import type { Bindings } from "../http/types.js";
import { automationLogger } from "../logging.js";
import {
  claimFiring,
  dueSchedules,
  recordFiring,
  type ScheduleRow,
} from "./schedules.js";
import { expireSubscriptions } from "./subscriptions.js";
import {
  deliverMessage,
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
}

export const threadState = (db: D1Database, threadId: string) =>
  db
    .prepare("SELECT lifecycle_state, project_id FROM threads WHERE id = ?")
    .bind(threadId)
    .first<ThreadState>();

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
  const thread = await threadState(db, row.thread_id);
  if (thread === null || thread.lifecycle_state !== "active") {
    await recordFiring(db, row.thread_id, {
      status: "skipped",
      detail: "The Thread is archived.",
    });
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
        projectId: thread.project_id,
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

/** Runs one automation pass. Returns how many it fired and expired. */
export const sweepAutomations = async (
  bindings: Bindings,
  now = new Date(),
  waitUntil?: (promise: Promise<unknown>) => void,
) => {
  const db = bindings.DB;
  if (db === undefined) return { schedules: 0, expired: 0 };
  try {
    const [schedules, expired] = await Promise.all([
      dueSchedules(db, now),
      expireSubscriptions(db, now),
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
    return { schedules: schedules.length, expired };
  } catch (cause) {
    automationLogger.warn("Automations were not swept.", {
      event: "automation_sweep_failed",
      cause,
    });
    return { schedules: 0, expired: 0 };
  }
};
