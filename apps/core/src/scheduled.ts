import { moveHomeArtifacts } from "./artifact-library/moves.js";
import { purgeUnsentAttachments } from "./attachments/store.js";
import { attachmentTransfer } from "./attachments/transfer.js";
import { sweepAutomations } from "./automations/sweep.js";
import { sweepBugReportForwards } from "./bug-reports/forwarding.js";
import { sweepIdleDeadlines } from "./execution/idle-deadlines.js";
import type { Bindings } from "./http/types.js";
import {
  attachmentLogger,
  bugReportLogger,
  notificationLogger,
  orbProvidersLogger,
  settingsPersistenceLogger,
  sourceControlLogger,
  threadDeletionLogger,
  threadPersistenceLogger,
  threadStorageLogger,
} from "./logging.js";
import { THREAD_SWEEP_CRON } from "./notifications/snooze-cron.js";
import { sweepSnoozeWakes } from "./notifications/snooze-wake.js";
import { sweepPluginServices } from "./plugins/services/lifecycle.js";
import { pluginServiceLogger } from "./plugins/services/log.js";
import { sweepServiceSchedules } from "./plugins/services/schedules.js";
import { refreshModelsDev } from "./settings/model-routing/live-catalog.js";
import {
  scheduleUsageRetention,
  scheduleWorkspaceUsageBackfill,
} from "./settings/usage/retention.js";
import { sweepArtifactAgentWakes } from "./thread-artifacts/ask-effects.js";
import { threadArtifactLogger } from "./thread-artifacts/logger.js";
import { sweepDeletedArtifacts } from "./thread-artifacts/store.js";
import { sweepThreadDeletions } from "./thread-deletion/cleanup.js";
import { deployedThreadCleanup } from "./thread-deletion/routes.js";
import { sweepThreadStorage } from "./thread-storage/store.js";

/**
 * The Worker's cron handler. Every tick sweeps snoozed Threads, retries
 * unfinished Thread deletions and undelivered first messages, settles turns
 * whose settlement was missed, deletes expired Thread storage files, fires
 * due schedules, polls GitHub subscriptions, renews Bitbucket and GitHub user
 * tokens, charges metered Orb time, and retries bug reports still
 * to forward to the central deployment; the daily tick also runs
 * usage and attachment retention.
 */
export const scheduled = (
  controller: ScheduledController,
  bindings: Bindings,
  context: ExecutionContext,
) => {
  // Telling someone their snoozed Thread is back cannot wait for a daily
  // pass, so it runs on every tick; the heavy retention work does not.
  context.waitUntil(
    sweepSnoozeWakes(bindings, new Date(controller.scheduledTime)).then(
      (notified) => {
        if (notified > 0)
          notificationLogger.info("Snoozed Threads woke their owners.", {
            event: "snooze_wake_notified",
            notified,
          });
      },
    ),
  );
  // Bitbucket connections renew their single-use tokens here, whether or
  // not anyone uses dx (#1952).
  context.waitUntil(
    import("./source-control/bitbucket/token-renewer.js")
      .then(({ sweepBitbucketRenewals }) =>
        sweepBitbucketRenewals(bindings, controller.scheduledTime),
      )
      .catch((cause) =>
        sourceControlLogger.error("Bitbucket renewal sweep failed.", {
          event: "bitbucket_token_renewal_sweep_failed",
          cause,
        }),
      ),
  );
  // GitHub user tokens rotate the same way; their authorizations renew here
  // too (#1953).
  context.waitUntil(
    import("./source-control/github/token-renewer.js")
      .then(({ sweepGitHubRenewals }) =>
        sweepGitHubRenewals(bindings, controller.scheduledTime),
      )
      .catch((cause) =>
        sourceControlLogger.error("GitHub renewal sweep failed.", {
          event: "github_token_renewal_sweep_failed",
          cause,
        }),
      ),
  );
  // Models labs released after this deployment: models.dev is read into
  // D1 every few hours, so every model list grows without a release
  // (settings/model-routing/live-catalog.ts).
  if (bindings.DB !== undefined) {
    const db = bindings.DB;
    context.waitUntil(
      refreshModelsDev(db)
        .then((result) => {
          if (result.status === "refreshed")
            settingsPersistenceLogger.info("models.dev catalog refreshed.", {
              event: "models_dev_catalog_refreshed",
              models: result.models,
            });
          else if (result.status === "failed")
            settingsPersistenceLogger.warn(
              "models.dev catalog refresh failed.",
              {
                event: "models_dev_catalog_refresh_failed",
                reason: result.reason,
              },
            );
        })
        .catch((cause) =>
          settingsPersistenceLogger.error(
            "models.dev catalog refresh failed.",
            {
              event: "models_dev_catalog_refresh_failed",
              cause,
            },
          ),
        ),
    );
  }
  // A deleted Thread whose cleanup failed must not keep its sandbox or
  // history for a day, so its retry runs on every tick too.
  context.waitUntil(
    sweepThreadDeletions(
      bindings,
      deployedThreadCleanup(bindings),
      new Date(controller.scheduledTime),
    ).catch((cause) =>
      threadDeletionLogger.error("Thread deletion sweep failed.", {
        event: "thread_deletion_sweep_failed",
        cause,
      }),
    ),
  );
  // Plugins' URL listeners: open what runs, empty what no longer does.
  context.waitUntil(
    import("./plugins/hosts/durable/listeners.js")
      .then(({ sweepPluginListeners }) =>
        sweepPluginListeners(
          bindings,
          new Date(controller.scheduledTime),
          (promise) => context.waitUntil(promise),
        ),
      )
      .catch((cause) =>
        pluginServiceLogger.error("Plugin listener sweep failed.", {
          event: "plugin_listener_sweep_failed",
          cause,
        }),
      ),
  );
  // A new Thread whose request ended before its agent admitted the first
  // message must not sit silent, so its delivery retries on every tick.
  context.waitUntil(
    // Imported on use: it loads DxAgent, which the cron needs only here.
    import("./threads/initial-dispatch-delivery.js")
      .then(({ sweepPendingInitialDispatches }) =>
        sweepPendingInitialDispatches(bindings, controller.scheduledTime),
      )
      .then((outcomes) => {
        if (outcomes.length > 0)
          threadPersistenceLogger.info("Pending first messages delivered.", {
            event: "thread_initial_dispatch_sweep_completed",
            admitted: outcomes.filter(({ kind }) => kind === "admitted").length,
            failed: outcomes.filter(({ kind }) => kind === "failed").length,
            pending: outcomes.filter(({ kind }) => kind === "pending").length,
          });
      })
      .catch((cause) =>
        threadPersistenceLogger.error("Pending first message sweep failed.", {
          event: "thread_initial_dispatch_sweep_failed",
          cause,
        }),
      ),
  );
  // A turn whose settlement dx missed would show as running forever: the
  // header's Orb, the Space card and tab, the sidebar (threads/activity.ts).
  context.waitUntil(
    import("./threads/activity.js")
      .then(({ reconcileStaleThreadActivity }) =>
        reconcileStaleThreadActivity(bindings, controller.scheduledTime),
      )
      .then((settled) => {
        if (settled > 0)
          threadPersistenceLogger.info("Missed turn settlements recorded.", {
            event: "thread_activity_reconciled",
            settled,
          });
      })
      .catch((cause) =>
        threadPersistenceLogger.error("Thread activity reconcile failed.", {
          event: "thread_activity_reconcile_failed",
          cause,
        }),
      ),
  );
  // A temporary Thread storage file lasts three hours, so its sweep cannot
  // wait for the daily tick either.
  context.waitUntil(
    sweepThreadStorage(
      bindings,
      attachmentTransfer(bindings),
      controller.scheduledTime,
    )
      .then((deleted) => {
        if (deleted > 0)
          threadStorageLogger.info("Expired Thread storage files deleted.", {
            event: "thread_storage_sweep_completed",
            deleted,
          });
      })
      .catch((cause) =>
        threadStorageLogger.error("Thread storage sweep failed.", {
          event: "thread_storage_sweep_failed",
          cause,
        }),
      ),
  );
  // Schedules and GitHub events wake Threads; a dx run ends with its turn,
  // so nothing else would (automations/wake.ts).
  context.waitUntil(
    sweepAutomations(bindings, new Date(controller.scheduledTime), (promise) =>
      context.waitUntil(promise),
    ),
  );
  // Plugin services: their schedules, and keeping services and plugin Orbs
  // in step with installs (plugins/services/lifecycle.ts).
  context.waitUntil(
    Promise.all([
      sweepServiceSchedules(
        bindings,
        new Date(controller.scheduledTime),
        (promise) => context.waitUntil(promise),
      ),
      sweepPluginServices(
        bindings,
        new Date(controller.scheduledTime),
        (promise) => context.waitUntil(promise),
      ),
    ]).catch((cause: unknown) =>
      pluginServiceLogger.error("Plugin service sweep failed.", {
        event: "plugin_service_sweep_failed",
        cause,
      }),
    ),
  );
  // A bug report the central deployment did not take yet is retried while
  // it may still arrive (bug-reports/forwarding.ts).
  context.waitUntil(
    sweepBugReportForwards(bindings, new Date(controller.scheduledTime)).catch(
      (cause) =>
        bugReportLogger.error("Bug report forward sweep failed.", {
          event: "bug_report_forward_sweep_failed",
          cause,
        }),
    ),
  );
  // Standalone artifacts that lived in an artifact home until 0198: their
  // R2 objects move from the home's prefix to their own.
  context.waitUntil(
    moveHomeArtifacts(bindings)
      .then((moved) => {
        if (moved > 0)
          threadArtifactLogger.info("Home artifacts moved.", {
            event: "standalone_artifact_moved",
            moved,
          });
      })
      .catch((cause) =>
        threadArtifactLogger.error("Home artifact move failed.", {
          event: "standalone_artifact_move_failed",
          cause,
        }),
      ),
  );
  // Notify agent's trailing wakes: each closed window others joined gets
  // one, built now (thread-artifacts/agent-wake-window.ts).
  context.waitUntil(
    sweepArtifactAgentWakes(bindings, {
      now: controller.scheduledTime,
      waitUntil: (promise) => context.waitUntil(promise),
    }).catch((cause) =>
      threadArtifactLogger.error("Artifact trailing wake sweep failed.", {
        event: "thread_artifact_trailing_sweep_failed",
        cause,
      }),
    ),
  );
  // An idle Orb whose provider cannot pause it by itself (Lizard, Agent37)
  // pauses within a minute of its deadline.
  context.waitUntil(
    Promise.all([
      import("./execution/lizard/provider.js"),
      import("./execution/agent37/provider.js"),
    ])
      .then(([{ pauseIdleLizardSandbox }, { pauseIdleAgent37Instance }]) =>
        sweepIdleDeadlines(
          bindings,
          {
            lizard: (sweepBindings, sandboxId, threadId) =>
              pauseIdleLizardSandbox(sweepBindings, sandboxId, threadId),
            agent37: (sweepBindings, instanceId, threadId) =>
              pauseIdleAgent37Instance(sweepBindings, instanceId, threadId),
          },
          controller.scheduledTime,
        ),
      )
      .then((paused) => {
        if (paused > 0)
          orbProvidersLogger.info("Idle Orbs paused.", {
            event: "orb_idle_paused",
            paused,
          });
      })
      .catch((cause) =>
        orbProvidersLogger.error("Idle Orb sweep failed.", {
          event: "orb_idle_sweep_failed",
          cause,
        }),
      ),
  );
  // Orb time a deployment meters is charged every 2 to 3 minutes while the
  // Orb runs and once more when it stops (public dx meters nothing).
  context.waitUntil(
    import("./execution/orb-billing-registration.js")
      .then(({ registeredOrbBilling }) =>
        registeredOrbBilling.settle?.(controller.scheduledTime),
      )
      .then((stopped) => {
        if (stopped !== undefined && stopped > 0)
          orbProvidersLogger.info("Orbs out of credit stopped.", {
            event: "orb_time_out_of_credit",
            stopped,
          });
      })
      .catch((cause) =>
        orbProvidersLogger.error("Orb time settlement failed.", {
          event: "orb_time_settle_failed",
          cause,
        }),
      ),
  );
  // Grants past their date lapse, where a deployment registers expiring
  // grants (public dx has none).
  const expiryDatabase = bindings.DB;
  if (expiryDatabase !== undefined)
    context.waitUntil(
      import("./execution/credit-expiry-registration.js")
        .then(({ registeredCreditExpiry }) =>
          registeredCreditExpiry(expiryDatabase, controller.scheduledTime),
        )
        .then((expired) => {
          if (expired > 0)
            orbProvidersLogger.info("Expired grants written off.", {
              event: "credit_expiry_swept",
              expired,
            });
        })
        .catch((cause) =>
          orbProvidersLogger.error("Credit expiry sweep failed.", {
            event: "credit_expiry_sweep_failed",
            cause,
          }),
        ),
    );
  // Orbs left unused past the deployment's retention go, and their Threads
  // stay archived for good, where a deployment registers a retention
  // (public dx keeps every Orb).
  context.waitUntil(
    import("./execution/orb-retention-registration.js")
      .then(({ registeredOrbRetention }) =>
        registeredOrbRetention(bindings, {
          now: controller.scheduledTime,
          waitUntil: (promise) => context.waitUntil(promise),
        }),
      )
      .catch((cause) =>
        orbProvidersLogger.error("Orb retention sweep failed.", {
          event: "orb_retention_sweep_failed",
          cause,
        }),
      ),
  );
  scheduleWorkspaceUsageBackfill(bindings, context);
  if (controller.cron === THREAD_SWEEP_CRON) return;
  scheduleUsageRetention(controller, bindings, context);
  // Bodies of deleted artifacts still stored: a deleted account's Threads'
  // artifacts, or a delete whose purge failed.
  context.waitUntil(
    sweepDeletedArtifacts(bindings).catch((cause) =>
      threadArtifactLogger.error("Deleted artifact sweep failed.", {
        event: "thread_artifact_sweep_failed",
        cause,
      }),
    ),
  );
  const transfer = attachmentTransfer(bindings);
  if (transfer === undefined) return;
  context.waitUntil(
    purgeUnsentAttachments(bindings, transfer, controller.scheduledTime, {
      limit: 500,
    })
      .then((deleted) =>
        attachmentLogger.info("Unsent attachments purged.", {
          event: "attachment_retention_completed",
          deleted,
        }),
      )
      .catch(() =>
        attachmentLogger.error("Unsent attachment retention failed.", {
          event: "attachment_retention_failed",
        }),
      ),
  );
};
