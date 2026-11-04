// A person's restart of a Thread's Orb (#1592), on the Thread execution
// object, so one runs at a time per Thread and the limit outlives restarts
// of the object:
//
//   POST https://thread-execution/orb/restart        (x-dx-restarted-by: name)
//   POST https://thread-execution/orb/restart/note   the pending note, once
//
// The route checked access first (owner or Contribute, active Thread). A
// restart leaves a note for the Thread's next run, which tells its agent, as
// an automatic restart's note does (#1586).

import { ORB_RESTART_INTERVAL_SECONDS } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { threadDaemonLogger } from "../logging.js";
import type { RestoredWork } from "../orb-disk/read-only.js";
import type { ExecutionWorkspaces } from "../plugins/execution/provider.js";

type ProviderRestart = Awaited<ReturnType<ExecutionWorkspaces["restart"]>>;

const RESTARTED_AT_STORAGE_KEY = "orb-restarted-at";
const NOTE_STORAGE_KEY = "orb-restart-note";

/** Who restarted the Orb, and what it kept, for the Thread's next run. */
export interface OrbRestartNote {
  readonly by: string;
  readonly files: "kept" | "earlier" | "lost";
  readonly restartedAt: string;
  /** With `earlier` or `lost`: when the files it starts from were saved. */
  readonly savedAt?: number;
  /** The unsaved work dx copied out before dropping it. */
  readonly restored?: RestoredWork;
}

/** The restarting person's name, URI-encoded in its header by the route. */
export const restartedBy = (header: string | null) => {
  try {
    return decodeURIComponent(header ?? "").slice(0, 256) || "Someone";
  } catch {
    return "Someone";
  }
};

/** The pending note, taken once: the next run tells its agent. */
export const takeOrbRestartNote = async (
  storage: Pick<DurableObjectStorage, "get" | "delete">,
): Promise<OrbRestartNote | undefined> => {
  const note = await storage.get<OrbRestartNote>(NOTE_STORAGE_KEY);
  if (note !== undefined) await storage.delete(NOTE_STORAGE_KEY);
  return note;
};

export type OrbRestartRelayResult =
  | (Extract<ProviderRestart, { outcome: "restarted" }> & {
      readonly restartedAt: string;
    })
  | Extract<ProviderRestart, { outcome: "unsaved" | "unsupported" }>
  | { readonly outcome: "too-soon"; readonly retryAfterSeconds: number }
  | { readonly outcome: "failed" };

export interface OrbRestartDependencies {
  readonly storage: Pick<DurableObjectStorage, "get" | "put" | "delete">;
  /** The name of the person restarting it, as dx shows it. */
  readonly by: string;
  readonly now: () => number;
  /** The provider's restart, through `ExecutionWorkspaces.restart`. */
  readonly restart: () => Promise<ProviderRestart>;
  /** After a restart: the old daemon is gone, and the Orb starts again. */
  readonly restarted: () => void;
}

/**
 * Restarts the Orb unless it restarted less than
 * `ORB_RESTART_INTERVAL_SECONDS` ago. The time is taken before the restart
 * runs, so a second request meanwhile is refused, and given back when no
 * restart happened, so a failed one can be retried at once.
 */
export const restartOrb = async (
  threadId: ThreadId,
  dependencies: OrbRestartDependencies,
): Promise<OrbRestartRelayResult> => {
  const { storage, now } = dependencies;
  const startedAt = now();
  const previous = await storage.get<number>(RESTARTED_AT_STORAGE_KEY);
  const intervalMs = ORB_RESTART_INTERVAL_SECONDS * 1000;
  if (previous !== undefined && startedAt - previous < intervalMs)
    return {
      outcome: "too-soon",
      retryAfterSeconds: Math.ceil((previous + intervalMs - startedAt) / 1000),
    };
  await storage.put(RESTARTED_AT_STORAGE_KEY, startedAt);
  const giveBack = () =>
    previous === undefined
      ? storage.delete(RESTARTED_AT_STORAGE_KEY)
      : storage.put(RESTARTED_AT_STORAGE_KEY, previous);
  let result: Awaited<ReturnType<OrbRestartDependencies["restart"]>>;
  try {
    result = await dependencies.restart();
  } catch (cause) {
    await giveBack();
    threadDaemonLogger.error("The Orb's restart failed.", {
      event: "orb_restart",
      threadId,
      outcome: "failed",
      error: cause instanceof Error ? cause.message.slice(0, 500) : "failed",
    });
    return { outcome: "failed" };
  }
  if (result.outcome !== "restarted") {
    await giveBack();
    threadDaemonLogger.warn("The Orb was not restarted.", {
      event: "orb_restart",
      threadId,
      outcome: result.outcome,
    });
    return result;
  }
  threadDaemonLogger.info("The Orb was restarted.", {
    event: "orb_restart",
    threadId,
    outcome: "restarted",
    files: result.files,
    ...(result.rescue === undefined ? {} : { rescue: result.rescue }),
    durationMs: now() - startedAt,
  });
  const restartedAt = new Date(startedAt).toISOString();
  await storage.put(NOTE_STORAGE_KEY, {
    by: dependencies.by,
    files: result.files,
    restartedAt,
    ...(result.savedAt === undefined ? {} : { savedAt: result.savedAt }),
    ...(result.restored === undefined ? {} : { restored: result.restored }),
  } satisfies OrbRestartNote);
  dependencies.restarted();
  return { ...result, restartedAt };
};

/**
 * A run's activation takes the Thread's pending restart note, if any; it
 * never fails the run.
 */
export const takeOrbRestartNoteFor = async (
  namespace: DurableObjectNamespace | undefined,
  threadId: string,
): Promise<OrbRestartNote | undefined> => {
  if (namespace === undefined) return undefined;
  try {
    const response = await namespace.get(namespace.idFromName(threadId)).fetch(
      new Request("https://thread-execution/orb/restart/note", {
        method: "POST",
        headers: { "x-dx-thread-id": threadId },
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    return ((await response.json()) as OrbRestartNote | null) ?? undefined;
  } catch {
    return undefined;
  }
};
