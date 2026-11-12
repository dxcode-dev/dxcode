import type { Bindings } from "../http/types.js";
import { orbProvidersLogger } from "../logging.js";

/**
 * Core-side idle pause, for a provider without a pause deadline of its own
 * (Lizard: a sandbox's timeout deletes it). The Orb's handle stores when it
 * goes idle (`orb_idle_deadline`, migration 0165); every activity moves
 * that, and the Worker's minute cron pauses each Orb past its deadline.
 * Each provider names how it pauses one sandbox (`IdlePausers`).
 */

export interface IdleOrb {
  readonly providerId: string;
  readonly sandboxId: string;
  readonly threadId: string;
}

/** Sets (or moves) when the Orb goes idle: `durationMs` from now. */
export const setIdleDeadline = async (
  db: D1Database,
  orb: IdleOrb,
  durationMs: number,
  now = Date.now(),
) => {
  await db
    .prepare(
      `INSERT INTO orb_idle_deadline (provider_id, sandbox_id, thread_id, deadline_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (provider_id, sandbox_id)
       DO UPDATE SET thread_id = excluded.thread_id, deadline_at = excluded.deadline_at`,
    )
    .bind(
      orb.providerId,
      orb.sandboxId,
      orb.threadId,
      now + Math.max(0, durationMs),
    )
    .run();
};

/** The Orb is paused or gone: nothing to pause any more. */
export const clearIdleDeadline = async (
  db: D1Database,
  providerId: string,
  sandboxId: string,
) => {
  await db
    .prepare(
      "DELETE FROM orb_idle_deadline WHERE provider_id = ? AND sandbox_id = ?",
    )
    .bind(providerId, sandboxId)
    .run();
};

/** Pauses one idle sandbox of its provider. */
export type IdlePausers = Readonly<
  Record<
    string,
    (bindings: Bindings, sandboxId: string, threadId: string) => Promise<void>
  >
>;

/** Orbs one tick pauses at most; the next tick takes the rest. */
const BATCH = 25;

/**
 * Pauses every Orb past its deadline. A row is claimed by deleting it at
 * the deadline read, so an Orb whose activity moved the deadline meanwhile
 * keeps running. A pause that fails puts the row back, so the next tick
 * tries again. Returns how many Orbs it paused.
 */
export const sweepIdleDeadlines = async (
  bindings: Bindings,
  pausers: IdlePausers,
  now = Date.now(),
): Promise<number> => {
  const db = bindings.DB;
  if (db === undefined) return 0;
  const due = await db
    .prepare(
      `SELECT provider_id, sandbox_id, thread_id, deadline_at
         FROM orb_idle_deadline WHERE deadline_at <= ? ORDER BY deadline_at LIMIT ?`,
    )
    .bind(now, BATCH)
    .all<{
      provider_id: string;
      sandbox_id: string;
      thread_id: string;
      deadline_at: number;
    }>();
  let paused = 0;
  for (const row of due.results) {
    const pause = pausers[row.provider_id];
    if (pause === undefined) continue;
    const claimed = await db
      .prepare(
        `DELETE FROM orb_idle_deadline
          WHERE provider_id = ? AND sandbox_id = ? AND deadline_at = ?`,
      )
      .bind(row.provider_id, row.sandbox_id, row.deadline_at)
      .run();
    if ((claimed.meta.changes ?? 0) === 0) continue;
    try {
      await pause(bindings, row.sandbox_id, row.thread_id);
      paused += 1;
    } catch (cause) {
      // Put it back unless activity set a new deadline meanwhile.
      await db
        .prepare(
          `INSERT INTO orb_idle_deadline (provider_id, sandbox_id, thread_id, deadline_at)
           VALUES (?1, ?2, ?3, ?4) ON CONFLICT (provider_id, sandbox_id) DO NOTHING`,
        )
        .bind(row.provider_id, row.sandbox_id, row.thread_id, row.deadline_at)
        .run();
      orbProvidersLogger.warn("An idle Orb could not be paused.", {
        event: "orb_idle_pause_failed",
        providerId: row.provider_id,
        threadId: row.thread_id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return paused;
};
