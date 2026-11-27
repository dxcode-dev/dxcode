import { sweepClaudePlanWaits } from "../claude-code/plan-wait.js";
import type { Bindings } from "../http/types.js";
import { automationLogger } from "../logging.js";
import { spacesEnabled } from "../spaces/availability.js";
import { creatorAccessEnded } from "./creator.js";
import {
  claimFiring,
  dueSchedules,
  pauseSchedule,
  recordFiring,
  type ScheduleRow,
} from "./schedules.js";
import { expireSubscriptions } from "./subscriptions.js";
import {
  deliverMessage,
  resumeThread,
  selectionFor,
  startThread,
  type WakeTarget,
} from "./wake.js";

/**
 * The Worker cron's automation pass, every minute: fire schedules that came
 * due, waking Threads through `wake.ts`, and end GitHub subscriptions past
 * their expiry. GitHub events arrive by webhook (`deliver.ts`), not here.
 * Each firing is claimed in D1 first, so overlapping sweeps act once. Never
 * throws: one failure is recorded on its schedule and the rest go on.
 */

interface ThreadState {
  readonly lifecycle_state: string;
  readonly project_id: string;
  readonly kind: string | null;
  readonly space_state: string | null;
}

/**
 * The Thread an automation wakes, and why it may not: an archived Thread,
 * or a thread whose Space is archived, hears nothing until it is restored.
 * While Spaces are off (`spaces` false), a Space hears nothing and its
 * threads wake as any other. Nothing it missed meanwhile is replayed.
 */
export const threadState = async (
  db: D1Database,
  threadId: string,
  spaces = true,
) => {
  const row = await db
    .prepare(
      `SELECT thread.lifecycle_state, thread.project_id, thread.kind,
              space.lifecycle_state AS space_state
         FROM threads AS thread
         LEFT JOIN threads AS space
           ON space.id = thread.parent_thread_id AND space.kind = 'space'
        WHERE thread.id = ?`,
    )
    .bind(threadId)
    .first<ThreadState>();
  // A deleted Thread is gone, not paused.
  if (row === null || !["active", "archived"].includes(row.lifecycle_state))
    return undefined;
  const paused =
    row.lifecycle_state !== "active"
      ? "The Thread is archived."
      : !spaces && row.kind === "space"
        ? "Spaces are off on this deployment."
        : spaces && row.space_state !== null && row.space_state !== "active"
          ? "The Space that started this Thread is archived."
          : undefined;
  return { projectId: row.project_id, paused };
};

export const message = (error: unknown) =>
  error instanceof Error ? error.message : "Unexpected failure.";

/**
 * What a woken Thread reads when its schedule fires: the same words every
 * time. The agent reads the saved prompt with get_schedule, so the
 * transcript shows one short wake-up line, not the prompt again.
 */
export const SCHEDULE_WAKE_MESSAGE =
  "Scheduled wake-up. Call get_schedule to read this Thread's saved prompt, then carry it out as the user's instructions for this turn. If there is no schedule, stop. If no action is necessary, give a short, concise update, even when the saved prompt says to skip the update.";

const fireSchedule = async (
  bindings: Bindings,
  db: D1Database,
  row: ScheduleRow,
  now: Date,
  waitUntil?: (promise: Promise<unknown>) => void,
) => {
  const occurrence = row.next_run_at as string;
  if (!(await claimFiring(db, row, now))) return;
  const thread = await threadState(db, row.thread_id, spacesEnabled(bindings));
  // The occurrence is claimed and passes: restoring the Thread resumes the
  // schedule at its next occurrence.
  if (thread === undefined || thread.paused !== undefined) {
    await recordFiring(db, row.thread_id, {
      status: "skipped",
      detail: thread?.paused ?? "The Thread is gone.",
    });
    return;
  }
  // A member's schedule never outlives their Contribute access: it pauses
  // until the owner resumes it.
  const ended = await creatorAccessEnded(
    db,
    row.thread_id,
    row.created_by_user_id,
    now,
  );
  if (ended !== undefined) {
    await pauseSchedule(db, row.thread_id, now);
    await recordFiring(db, row.thread_id, { status: "skipped", detail: ended });
    automationLogger.info(
      "A member's schedule paused after their access ended.",
      {
        event: "schedule_creator_access_ended",
        threadId: row.thread_id,
      },
    );
    return;
  }
  const target: WakeTarget = {
    bindings,
    ownerUserId: row.owner_user_id,
    automation: "schedule",
    ...(waitUntil === undefined ? {} : { waitUntil }),
  };
  // Names this firing: the same occurrence of the same schedule.
  const key = `schedule:${row.thread_id}:${row.created_at}:${occurrence}`;
  try {
    if (row.run_mode === "existing") {
      await deliverMessage(target, row.thread_id, SCHEDULE_WAKE_MESSAGE, key);
      await recordFiring(db, row.thread_id, { status: "delivered" });
    } else {
      const started = await startThread(target, {
        parentThreadId: row.thread_id,
        projectId: thread.projectId,
        title: `${row.title} · ${occurrence.slice(0, 16).replace("T", " ")} UTC`,
        prompt: row.prompt,
        selection: await selectionFor(db, row.thread_id, row.agent_mode),
        key,
      });
      await recordFiring(db, row.thread_id, {
        status: "started",
        threadId: started,
      });
    }
    automationLogger.info("Schedule fired.", {
      event: "schedule_fired",
      threadId: row.thread_id,
      runMode: row.run_mode,
    });
  } catch (error) {
    automationLogger.warn("Schedule firing failed.", {
      event: "schedule_fire_failed",
      threadId: row.thread_id,
      cause: error,
    });
    await recordFiring(db, row.thread_id, {
      status: "failed",
      detail: message(error),
    });
  }
};

/**
 * Runs one automation pass. Returns how many schedules it fired,
 * subscriptions it expired, and Threads it resumed after their Claude plan
 * reset (claude-code/plan-wait.ts).
 */
export const sweepAutomations = async (
  bindings: Bindings,
  now = new Date(),
  waitUntil?: (promise: Promise<unknown>) => void,
) => {
  const db = bindings.DB;
  if (db === undefined) return { schedules: 0, expired: 0, resumed: 0 };
  try {
    const [schedules, expired, resumed] = await Promise.all([
      dueSchedules(db, now),
      expireSubscriptions(db, now),
      sweepClaudePlanWaits(db, now, (wait) =>
        resumeThread(
          {
            bindings,
            ownerUserId: wait.ownerUserId,
            ...(waitUntil === undefined ? {} : { waitUntil }),
          },
          wait.threadId,
          wait.key,
        ).then(() =>
          automationLogger.info("Thread resumed after its plan reset.", {
            event: "claude_plan_wait_resumed",
            threadId: wait.threadId,
            submissionId: wait.submissionId,
          }),
        ),
      ),
    ]);
    await Promise.all(
      schedules.map((row) =>
        fireSchedule(bindings, db, row, now, waitUntil).catch((cause) =>
          automationLogger.error("Schedule sweep failed.", {
            event: "schedule_sweep_failed",
            threadId: row.thread_id,
            cause,
          }),
        ),
      ),
    );
    return { schedules: schedules.length, expired, resumed };
  } catch (cause) {
    automationLogger.warn("Automations were not swept.", {
      event: "automation_sweep_failed",
      cause,
    });
    return { schedules: 0, expired: 0, resumed: 0 };
  }
};
