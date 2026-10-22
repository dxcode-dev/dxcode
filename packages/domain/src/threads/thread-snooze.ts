import { DateTime } from "effect";
import type { Thread } from "./thread.js";

/** The latest wake time an owner may choose: a year ahead. */
export const THREAD_SNOOZE_MAX_MS = 366 * 24 * 60 * 60 * 1_000;

/**
 * Where a snooze leaves a Thread at `now`:
 *
 * - `awake`: not snoozed, or the owner already saw it wake.
 * - `snoozed`: hidden until its wake time.
 * - `woke`: its wake time passed and the owner has not opened it since.
 *
 * Nothing runs at the wake time; every reader derives the state from the
 * clock, so the sidebar, the agent tools, and search agree.
 */
export type ThreadSnoozeState = "awake" | "snoozed" | "woke";

export const threadSnoozeState = (
  thread: Pick<Thread, "lifecycleState" | "snoozedUntil">,
  now: number,
): ThreadSnoozeState => {
  if (thread.lifecycleState !== "active" || thread.snoozedUntil === undefined)
    return "awake";
  return DateTime.toEpochMillis(thread.snoozedUntil) > now ? "snoozed" : "woke";
};

/**
 * When the Thread last came back to its owner: its last activity, or a later
 * wake. Time spent snoozed does not make a Thread inactive.
 */
export const threadReturnedAt = (
  thread: Pick<
    Thread,
    "lastActivityAt" | "lifecycleState" | "snoozedUntil" | "snoozeWokeAt"
  >,
  now: number,
): number =>
  Math.max(
    DateTime.toEpochMillis(thread.lastActivityAt),
    thread.snoozeWokeAt === undefined
      ? 0
      : DateTime.toEpochMillis(thread.snoozeWokeAt),
    threadSnoozeState(thread, now) === "awake" ||
      thread.snoozedUntil === undefined
      ? 0
      : Math.min(DateTime.toEpochMillis(thread.snoozedUntil), now),
  );
