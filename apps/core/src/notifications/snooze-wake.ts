import type { ThreadId, UserId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { notificationLogger } from "../logging.js";
import { latestAgentReply } from "./latest-reply.js";
import { publishNotification } from "./publish.js";

/**
 * A snoozed Thread's wake time is a promise dx made to one person, and
 * nothing in a request runs at that moment, so a scheduled sweep tells them.
 * It notifies once per snooze: the source key carries the wake time, so
 * re-snoozing the same Thread notifies again and a repeated sweep does not.
 *
 * The Thread row is left exactly as it is. Waking is what readers already
 * derive from the clock; this only sends the nudge.
 */

/** Wake times older than this are left alone: a late sweep is not a flood. */
const WAKE_WINDOW_MS = 24 * 60 * 60 * 1_000;
/** Threads notified per sweep. More than this is a backlog, not a minute. */
const WAKE_BATCH = 100;

interface DueThread {
  readonly id: string;
  readonly owner_user_id: string;
  readonly snoozed_until: string;
}

/**
 * Threads whose snooze came due and whose owner has not been told yet. A
 * told owner has the snooze's notification row, found through its unique
 * (recipient, source key) index, so later sweeps skip the Thread instead of
 * reading its history again.
 */
export const dueSnoozedThreads = async (
  db: D1Database,
  now: Date,
): Promise<ReadonlyArray<DueThread>> =>
  (
    await db
      .prepare(
        `SELECT id, owner_user_id, snoozed_until
           FROM threads
          WHERE snoozed_until IS NOT NULL
            AND snoozed_until <= ?1
            AND snoozed_until > ?2
            AND lifecycle_state = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM notification
               WHERE notification.recipient_user_id = threads.owner_user_id
                 AND notification.source_key =
                       'snooze:' || threads.id || ':' || threads.snoozed_until)
          ORDER BY snoozed_until
          LIMIT ${WAKE_BATCH}`,
      )
      .bind(
        now.toISOString(),
        new Date(now.getTime() - WAKE_WINDOW_MS).toISOString(),
      )
      .all<DueThread>()
  ).results;

/**
 * Notifies every owner whose snoozed Thread is due. Never throws: a sweep
 * that fails is retried by the next one.
 */
export const sweepSnoozeWakes = async (
  bindings: Bindings,
  now = new Date(),
): Promise<number> => {
  const db = bindings.DB;
  if (db === undefined) return 0;
  try {
    const due = await dueSnoozedThreads(db, now);
    await Promise.all(
      due.map(async (thread) => {
        const ownerUserId = thread.owner_user_id as UserId;
        // Where the Thread left off; a wake without it still notifies.
        const reply = await latestAgentReply(
          bindings,
          ownerUserId,
          thread.id,
        ).catch((cause) => {
          notificationLogger.warn("The snoozed Thread's reply was not read.", {
            event: "snooze_wake_reply_read_failed",
            threadId: thread.id,
            cause,
          });
          return undefined;
        });
        await publishNotification(bindings, {
          topic: "snooze_woke",
          sourceKey: `snooze:${thread.id}:${thread.snoozed_until}`,
          recipients: [ownerUserId],
          threadId: thread.id as ThreadId,
          excerpt: reply ?? "",
        });
      }),
    );
    return due.length;
  } catch (cause) {
    notificationLogger.warn("Snoozed Threads were not swept.", {
      event: "snooze_wake_sweep_failed",
      cause,
    });
    return 0;
  }
};
