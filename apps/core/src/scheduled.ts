import { purgeUnsentAttachments } from "./attachments/store.js";
import { attachmentTransfer } from "./attachments/transfer.js";
import type { Bindings } from "./http/types.js";
import { attachmentLogger, notificationLogger } from "./logging.js";
import { SNOOZE_SWEEP_CRON } from "./notifications/snooze-cron.js";
import { sweepSnoozeWakes } from "./notifications/snooze-wake.js";
import { scheduleUsageRetention } from "./settings/usage/retention.js";

/**
 * The Worker's cron handler. Every tick sweeps snoozed Threads; the daily
 * tick also runs usage and attachment retention.
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
  if (controller.cron === SNOOZE_SWEEP_CRON) return;
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
