/**
 * The Orbs running now (migration 0213's orb_running): the Thread's
 * execution object marks a run when its Orb daemon registers and clears it
 * when the run ends, beside recording the finished run in
 * thread_orb_session. Written off the request path; a failed write is
 * logged by the caller and corrected by the next start or end.
 */

/** A run of the Thread's Orb started at `startedAt` (epoch ms). */
export const markOrbRunning = (
  db: D1Database,
  threadId: string,
  startedAt: number,
) =>
  db
    .prepare(
      `INSERT INTO orb_running (thread_id, started_at) VALUES (?, ?)
       ON CONFLICT (thread_id) DO UPDATE SET started_at = excluded.started_at`,
    )
    .bind(threadId, startedAt)
    .run();

/** The Thread's Orb run ended. */
export const clearOrbRunning = (db: D1Database, threadId: string) =>
  db
    .prepare("DELETE FROM orb_running WHERE thread_id = ?")
    .bind(threadId)
    .run();
