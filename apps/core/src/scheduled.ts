import { purgeUnsentAttachments } from "./attachments/store.js";
import { attachmentTransfer } from "./attachments/transfer.js";
import { sweepAutomations } from "./automations/sweep.js";
import { sweepBugReportForwards } from "./bug-reports/forwarding.js";
import type { Bindings } from "./http/types.js";
import {
  attachmentLogger,
  bugReportLogger,
  notificationLogger,
  sourceControlLogger,
  threadDeletionLogger,
  threadPersistenceLogger,
  threadStorageLogger,
} from "./logging.js";
import { THREAD_SWEEP_CRON } from "./notifications/snooze-cron.js";
import { sweepSnoozeWakes } from "./notifications/snooze-wake.js";
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
 * unfinished Thread deletions and undelivered first messages, deletes expired Thread storage files, fires
 * due schedules, polls GitHub subscriptions, renews Bitbucket tokens, and
 * retries bug reports still
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
