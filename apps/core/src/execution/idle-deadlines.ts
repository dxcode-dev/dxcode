import type { OrbProviderCredentials } from "@dx/domain";
import { Effect, Redacted } from "effect";
import type { Bindings } from "../http/types.js";
import { orbProvidersLogger } from "../logging.js";
import { resolveExecutionTarget } from "./runner-profiles/execution.js";

/**
 * Core-side idle pause, for a provider without a pause deadline of its own
 * (Lizard: a sandbox's timeout deletes it; Agent37: its auto-sleep cannot
 * see dxd). The Orb's handle stores when it
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

/**
 * The credentials an idle Orb runs on, for a pauser that knows only the
 * Thread: its pin's person's, workspace's, or deployment Orb account's
 * connection. Undefined when the pin has none, or runs on a deployment
 * secret (whose provider pauses itself).
 */
export const idleOrbCredentials = async (
  bindings: Bindings,
  threadId: string,
): Promise<OrbProviderCredentials | undefined> => {
  const { credential } = await Effect.runPromise(
    resolveExecutionTarget(bindings, threadId, { admission: false }),
  );
  if (credential.scope === "unavailable" || credential.scope === "deployment")
    return undefined;
  return Redacted.value(credential.credentials);
};

/** Pauses one idle sandbox of its provider. */
export type IdlePausers = Readonly<
  Record<
    string,
    (bindings: Bindings, sandboxId: string, threadId: string) => Promise<void>
  >
>;

/**
 * A failure's text for the log. A tagged error (such as
 * `Agent37WorkspaceUnavailable`) has an empty message and says why in its
 * `reason`.
 */
const errorText = (cause: unknown) => {
  if (!(cause instanceof Error)) return String(cause);
  if (cause.message !== "") return cause.message;
  const { reason } = cause as { readonly reason?: unknown };
  return typeof reason === "string" ? `${cause.name}: ${reason}` : cause.name;
};

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
        error: errorText(cause),
      });
    }
  }
  return paused;
};

/**
 * Pauses every Orb still running on a person's or workspace's connection,
 * with its credentials, as the connection is removed: once its key is gone
 * the sweep can no longer pause them, and the provider bills them until
 * someone stops them by hand. A pause that fails is logged, never retried
 * (there is no key to retry with), and never keeps the key from being
 * removed. Returns how many it paused.
 */
export const pauseConnectionOrbs = async (
  db: D1Database,
  connection: {
    readonly scope: "personal" | "workspace";
    readonly targetId: string;
    readonly providerId: string;
  },
  pause: (sandboxId: string) => Promise<void>,
): Promise<number> => {
  const running = await db
    .prepare(
      `SELECT deadline.sandbox_id, deadline.thread_id
         FROM orb_idle_deadline AS deadline
         JOIN execution_workspace AS pin
           ON pin.thread_id = deadline.thread_id
          AND pin.provider_sandbox_id = deadline.sandbox_id
        WHERE deadline.provider_id = ?1 AND pin.provider = ?1
          AND pin.account_scope = ?2 AND pin.account_owner_id = ?3`,
    )
    .bind(connection.providerId, connection.scope, connection.targetId)
    .all<{ sandbox_id: string; thread_id: string }>();
  let paused = 0;
  for (const row of running.results) {
    await clearIdleDeadline(db, connection.providerId, row.sandbox_id);
    try {
      await pause(row.sandbox_id);
      paused += 1;
    } catch (cause) {
      orbProvidersLogger.warn("An Orb on a removed key could not be paused.", {
        event: "orb_connection_removal_pause_failed",
        providerId: connection.providerId,
        threadId: row.thread_id,
        error: errorText(cause),
      });
    }
  }
  return paused;
};
