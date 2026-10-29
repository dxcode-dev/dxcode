import { purgeUnsentAttachments } from "./attachments/store.js";
import { attachmentTransfer } from "./attachments/transfer.js";
import { sweepAutomations } from "./automations/sweep.js";
import type { Bindings } from "./http/types.js";
import {
  attachmentLogger,
  notificationLogger,
  threadDeletionLogger,
  threadStorageLogger,
} from "./logging.js";
import { THREAD_SWEEP_CRON } from "./notifications/snooze-cron.js";
import { sweepSnoozeWakes } from "./notifications/snooze-wake.js";
import { scheduleUsageRetention } from "./settings/usage/retention.js";
import { sweepThreadDeletions } from "./thread-deletion/cleanup.js";
import { deployedThreadCleanup } from "./thread-deletion/routes.js";
import { sweepThreadStorage } from "./thread-storage/store.js";

/**
 * The Worker's cron handler. Every tick sweeps snoozed Threads, retries
 * unfinished Thread deletions, deletes expired Thread storage files, fires
 * due schedules, and polls GitHub subscriptions; the daily tick also runs
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
  if (controller.cron === THREAD_SWEEP_CRON) return;
  scheduleUsageRetention(controller, bindings, context);
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
