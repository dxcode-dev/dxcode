import { parseClaudePlanLimit } from "@dx/domain";
import { automationLogger } from "../logging.js";

/**
 * A Thread whose submission fails on its Claude plan's limit waits for the
 * plan to reset, then runs again by itself (#1578). Whatever woke it (a
 * person's message, another Thread's message, a schedule firing, a GitHub
 * event) is already in its history, so nothing is lost; what was missing is
 * a turn to answer it.
 *
 * Thread activity keeps one row per waiting Thread in `thread_plan_wait`:
 * a submission that settles failed with the plan's limit text writes it,
 * with the reset that text names, and the Thread's next submission starting
 * deletes it. Each Worker cron tick resumes the Threads whose reset has
 * passed, as the owner's Retry does, with an idempotency key from the failed
 * submission, so a Thread runs once per wait however many ticks see it.
 * Several wakes during the limit each fail and leave their message; the one
 * resumed turn reads them all, in order. The Thread stays on its plan and
 * its mode: the resumed turn resolves its route as any other does.
 */

/** The reset a failed submission waits for, epoch seconds; from its text. */
export const claudePlanResetOf = (errorMessage: string | undefined) =>
  errorMessage === undefined
    ? undefined
    : parseClaudePlanLimit(errorMessage)?.resetsAt;

interface ClaudePlanWaitActivity {
  readonly threadId: string;
  readonly submissionId: string;
  /** The submission started running. */
  readonly running: boolean;
  /** Set when the submission settled failed on the plan's limit. */
  readonly planResetAt?: number;
  readonly recordedAt: string;
}

/**
 * The statement Thread activity runs in its batch for one observation: a
 * submission starting to run ends the wait, one failing on the limit starts
 * it. A message queued behind the failing one runs right after it settles,
 * so only running ends a wait.
 */
export const claudePlanWaitStatement = (
  db: D1Database,
  activity: ClaudePlanWaitActivity,
) =>
  activity.running
    ? db
        .prepare("DELETE FROM thread_plan_wait WHERE thread_id = ?")
        .bind(activity.threadId)
    : activity.planResetAt === undefined
      ? undefined
      : db
          .prepare(
            `INSERT INTO thread_plan_wait (
               thread_id, submission_id, resets_at, recorded_at
             )
             SELECT id, ?2, ?3, ?4 FROM threads WHERE id = ?1
             ON CONFLICT (thread_id) DO UPDATE SET
               submission_id = excluded.submission_id,
               resets_at = excluded.resets_at,
               recorded_at = excluded.recorded_at`,
          )
          .bind(
            activity.threadId,
            activity.submissionId,
            activity.planResetAt,
            activity.recordedAt,
          );

export interface ClaudePlanWait {
  readonly threadId: string;
  readonly ownerUserId: string;
  readonly submissionId: string;
  /** Names this wait, so resuming it again admits nothing new. */
  readonly key: string;
}

/** How many due Threads one tick resumes; the next tick takes the rest. */
const SWEEP_LIMIT = 100;

/**
 * Resumes each active Thread whose plan reset has passed. Never throws: a
 * Thread that could not be resumed keeps its row for the next tick.
 * Returns how many were resumed.
 */
export const sweepClaudePlanWaits = async (
  db: D1Database,
  now: Date,
  resume: (wait: ClaudePlanWait) => Promise<void>,
): Promise<number> => {
  const due = await db
    .prepare(
      `SELECT w.thread_id, w.submission_id, t.owner_user_id
         FROM thread_plan_wait w JOIN threads t ON t.id = w.thread_id
        WHERE w.resets_at <= ? AND t.lifecycle_state = 'active'
        ORDER BY w.resets_at LIMIT ${SWEEP_LIMIT}`,
    )
    .bind(Math.floor(now.getTime() / 1000))
    .all<{ thread_id: string; submission_id: string; owner_user_id: string }>()
    .catch((cause: unknown) => {
      automationLogger.warn("Threads waiting for a plan reset were not read.", {
        event: "claude_plan_wait_sweep_failed",
        cause,
      });
      return { results: [] };
    });
  let resumed = 0;
  for (const row of due.results) {
    try {
      await resume({
        threadId: row.thread_id,
        ownerUserId: row.owner_user_id,
        submissionId: row.submission_id,
        key: `plan-reset:${row.thread_id}:${row.submission_id}`,
      });
      resumed += 1;
    } catch (cause) {
      automationLogger.warn(
        "A Thread waiting for its plan's reset did not resume.",
        {
          event: "claude_plan_wait_resume_failed",
          threadId: row.thread_id,
          submissionId: row.submission_id,
          cause,
        },
      );
    }
  }
  return resumed;
};
