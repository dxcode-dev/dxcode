import type { ThreadData } from "@dx/api";
import type { Thread, ThreadId } from "@dx/domain";

/** A Thread's snooze as its owner's clients receive it. */
export const threadSnoozeData = (
  thread: Thread,
): Pick<ThreadData, "snoozedUntil" | "snoozeWokeAt"> => ({
  ...(thread.snoozedUntil === undefined
    ? {}
    : { snoozedUntil: thread.snoozedUntil }),
  ...(thread.snoozeWokeAt === undefined
    ? {}
    : { snoozeWokeAt: thread.snoozeWokeAt }),
});

/**
 * A message someone sent wakes a snoozed Thread, as if its owner woke it.
 * Messages from other Threads' agents do not: they continue work the owner
 * put aside. True when the Thread was snoozed or still marked woken.
 */
export const wakeSnoozedThread = async (
  db: D1Database,
  threadId: ThreadId,
  now = new Date(),
): Promise<boolean> => {
  const at = now.toISOString();
  const result = await db
    .prepare(
      `UPDATE threads
          SET snooze_woke_at = MIN(snoozed_until, ?2),
              snoozed_until = NULL,
              snoozed_at = NULL,
              updated_at = ?2
        WHERE id = ?1 AND snoozed_until IS NOT NULL`,
    )
    .bind(threadId, at)
    .run();
  return (result.meta.changes ?? 0) > 0;
};
