import type { ThreadId } from "@dx/domain";
import type { Sandbox } from "@flue/runtime";
import type { DxdChangesRefresh } from "../execution/dxd/protocol.js";
import { threadChangesLogger } from "../logging.js";
import { recordDefaultBranchLanding } from "../spaces/progress/shipped.js";
import {
  captureKey,
  captureThreadChanges,
  probeThreadChanges,
  putThreadChangesCapture,
} from "./capture.js";
import {
  makeThreadChangesRepository,
  type ThreadChangesCaptureLease,
  type ThreadChangesMutationLease,
  ThreadChangesPersistenceUnavailable,
  type ThreadChangesSource,
  type ThreadChangesState,
} from "./repository-d1.js";

export const MUTATION_LEASE_MS = 2 * 60_000;
const MUTATION_HEARTBEAT_MS = 30_000;
const CAPTURE_LEASE_MS = 90_000;
const BEST_EFFORT_RACE_ATTEMPTS = 2;

export interface ThreadChangesCoordinator {
  readonly sync: () => Promise<void>;
  readonly flush: (options?: {
    readonly detectUnchanged?: boolean;
  }) => Promise<"captured" | "unchanged" | "busy" | "missing" | "raced">;
  readonly runMutation: <A>(
    operation: () => Promise<A>,
    options?: {
      readonly detectUnchanged?: boolean;
      /** A lease the caller already took (in its authorization's batch). */
      readonly lease?: ThreadChangesMutationLease;
    },
  ) => Promise<A>;
}

const logFailure = (threadId: ThreadId, stage: string, cause: unknown) => {
  threadChangesLogger.warn("Thread Changes capture failed.", {
    event: "thread_changes_capture_failed",
    stage,
    threadId,
    // Capture errors name Git refs and storage keys, never file contents.
    errorName: cause instanceof Error ? cause.name.slice(0, 100) : typeof cause,
    ...(cause instanceof Error &&
    cause.name === "ThreadChangesCaptureUnavailable"
      ? {
          captureStage: (cause as { stage?: string }).stage,
          detail: (cause as { detail?: string }).detail,
        }
      : {}),
    errorMessage: (cause instanceof Error ? cause.message : String(cause))
      .replace(/\s+/g, " ")
      .slice(0, 300),
  });
};

const maintainMutationLease = (
  threadId: ThreadId,
  lease: ThreadChangesMutationLease,
) => {
  let stopped = false;
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal
      .then(() => (stopped ? undefined : lease.renew(MUTATION_LEASE_MS)))
      .catch((cause) => logFailure(threadId, "mutation-renew", cause));
  }, MUTATION_HEARTBEAT_MS);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await renewal;
  };
};

/** The refresh for a lease's mutation, from state and source already read. */
const refreshFrom = (
  lease: ThreadChangesMutationLease,
  state: ThreadChangesState | undefined,
  source: ThreadChangesSource | undefined,
): DxdChangesRefresh => {
  if (source === undefined)
    throw new ThreadChangesPersistenceUnavailable({
      operation: "thread-changes.source.missing",
    });
  return {
    type: "changes-refresh",
    token: lease.refreshToken,
    source: {
      baseline: source.baseline,
      defaultBranch: source.defaultBranch,
    },
    ...(state?.latestFingerprint === undefined
      ? {}
      : { expectedFingerprint: state.latestFingerprint }),
  };
};

/** How long a resident hint may hold the capture lease for its candidate. */
const RESIDENT_CAPTURE_HOLD_MS = 15_000;
/** A held lease closer than this to expiry is not trusted for a publication. */
const RESIDENT_CAPTURE_MARGIN_MS = 5_000;

/** A capture lease still safe to validate and publish under. */
export const usableResidentCapture = (
  capture: ThreadChangesCaptureLease | undefined,
) =>
  capture !== undefined &&
  capture.expiresAt - Date.now() > RESIDENT_CAPTURE_MARGIN_MS;

/**
 * Answer a resident filesystem hint in one D1 batch: mark the projection
 * dirty, mint (or record) the refresh token, and take or renew the capture
 * lease with a state read taken after the mark. The candidate is validated
 * against that read under the same lease before any R2 write; every later
 * mutation bumps the generation the publication CAS checks. No mutation lease
 * is held.
 */
export const markResidentThreadChangesDirty = async (input: {
  readonly db: D1Database;
  readonly threadId: ThreadId;
  readonly source: ThreadChangesSource;
  /** A token the caller already sent; minted here when absent. */
  readonly token?: string;
  /** The lease an earlier hint still holds; renewed rather than replaced. */
  readonly held?: ThreadChangesCaptureLease;
}): Promise<{
  readonly refresh: DxdChangesRefresh;
  readonly capture?: ThreadChangesCaptureLease;
}> => {
  const marked = await makeThreadChangesRepository(input.db).markDirty(
    input.threadId,
    input.token,
    {
      holdCaptureMs: RESIDENT_CAPTURE_HOLD_MS,
      ...(usableResidentCapture(input.held) ? { held: input.held } : {}),
    },
  );
  return {
    refresh: {
      type: "changes-refresh",
      token: marked.refreshToken,
      source: {
        baseline: input.source.baseline,
        defaultBranch: input.source.defaultBranch,
      },
      ...(marked.latestFingerprint === undefined
        ? {}
        : { expectedFingerprint: marked.latestFingerprint }),
    },
    ...(marked.capture === undefined ? {} : { capture: marked.capture }),
  };
};

export const runResidentThreadChangesMutation = async <A>(input: {
  readonly db: D1Database;
  readonly threadId: ThreadId;
  readonly allowMissingSource?: boolean;
  readonly residentRefresh?: (refresh: DxdChangesRefresh) => Promise<boolean>;
  readonly operation: (refresh?: DxdChangesRefresh) => Promise<A>;
}) => {
  const repository = makeThreadChangesRepository(input.db);
  if (
    input.allowMissingSource === true &&
    (await repository.source(input.threadId)) === undefined
  )
    return input.operation();
  const lease = await repository.beginMutation(
    input.threadId,
    MUTATION_LEASE_MS,
  );
  const stopMaintainingLease = maintainMutationLease(input.threadId, lease);
  try {
    const refresh = refreshFrom(lease, lease.began.state, lease.began.source);
    return await input.operation(refresh);
  } finally {
    await stopMaintainingLease();
    // A candidate produced during the save is only a preview. Confirm again
    // after release so even the last save can clear dirty_since without a
    // timer; the release and the refresh's reads share one round trip.
    const released = await lease
      .releaseAndRead()
      .catch((cause) => logFailure(input.threadId, "mutation-release", cause));
    if (input.residentRefresh !== undefined && released !== undefined) {
      try {
        await input.residentRefresh(
          refreshFrom(lease, released.state, released.source),
        );
      } catch (cause) {
        logFailure(input.threadId, "resident-refresh", cause);
      }
    }
  }
};

export const makeThreadChangesCoordinator = (input: {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly threadId: ThreadId;
  readonly sandbox: Sandbox;
  readonly residentRefresh?: (refresh: DxdChangesRefresh) => Promise<boolean>;
  /**
   * Keeps a mutation's settlement alive after its result returns. With it,
   * an agent command's result no longer waits for the lease's release and
   * the Changes refresh, a primary round trip each (#1589): they run right
   * after, and the lease keeps renewing until it is released. Without it,
   * the mutation settles before it returns.
   */
  readonly waitUntil?: (settlement: Promise<unknown>) => void;
}): ThreadChangesCoordinator => {
  const repository = makeThreadChangesRepository(input.db);

  const flush = async (options?: { readonly detectUnchanged?: boolean }) => {
    const captureLease = await repository.acquireCapture(
      input.threadId,
      CAPTURE_LEASE_MS,
    );
    if (captureLease === undefined) return "busy" as const;
    try {
      const { state, source } = captureLease;
      if (source === undefined) return "missing" as const;
      if (state === undefined || state.activeMutations > 0)
        return "busy" as const;
      const probe =
        options?.detectUnchanged === true &&
        state.latestCaptureId !== undefined &&
        state.latestFingerprint !== undefined
          ? await probeThreadChanges({
              sandbox: input.sandbox,
              source,
              expectedFingerprint: state.latestFingerprint,
            })
          : undefined;
      if (probe?.kind === "unchanged" && state.latestCaptureId !== undefined) {
        const confirmed = await repository.confirmUnchanged({
          threadId: input.threadId,
          generation: state.mutationGeneration,
          captureId: state.latestCaptureId,
          fingerprint: probe.fingerprint,
        });
        if (!confirmed) return "raced" as const;
        threadChangesLogger.info("Thread Changes capture remains current.", {
          event: "thread_changes_capture_unchanged",
          threadId: input.threadId,
          captureId: state.latestCaptureId,
          generation: state.mutationGeneration,
        });
        return "unchanged" as const;
      }
      const manifest = await captureThreadChanges({
        sandbox: input.sandbox,
        threadId: input.threadId,
        source,
        generation: state.mutationGeneration,
        ...(probe === undefined
          ? {}
          : { expectedFingerprint: probe.fingerprint }),
      });
      if (manifest === undefined) return "raced" as const;
      await putThreadChangesCapture(input.bucket, manifest);
      let published: boolean;
      try {
        const summary = manifest.ranges?.find(
          ({ range }) => range.kind === "all",
        )?.summary;
        published = await repository.publish({
          threadId: input.threadId,
          generation: manifest.generation,
          captureId: manifest.captureId,
          fingerprint: manifest.fingerprint,
          capturedAt: manifest.capturedAt,
          ...(summary === undefined ? {} : { summary }),
        });
      } catch (cause) {
        try {
          const after = await repository.read(input.threadId);
          if (after?.latestCaptureId !== manifest.captureId) {
            await input.bucket
              .delete(captureKey(input.threadId, manifest.captureId))
              .catch((inner) =>
                logFailure(input.threadId, "orphan-delete", inner),
              );
          }
        } catch (readCause) {
          logFailure(input.threadId, "orphan-read", readCause);
        }
        throw cause;
      }
      if (!published) {
        await input.bucket
          .delete(captureKey(input.threadId, manifest.captureId))
          .catch((cause) => logFailure(input.threadId, "orphan-delete", cause));
        return "raced" as const;
      }
      // Before the previous capture is deleted: it holds the work the
      // thread had not pushed yet. The turn's end refreshes its viewers.
      await recordDefaultBranchLanding({
        db: input.db,
        bucket: input.bucket,
        threadId: input.threadId,
        previousCaptureId: state.latestCaptureId,
        manifest,
      });
      if (
        state.latestCaptureId !== undefined &&
        state.latestCaptureId !== manifest.captureId
      )
        await input.bucket
          .delete(captureKey(input.threadId, state.latestCaptureId))
          .catch((cause) =>
            logFailure(input.threadId, "superseded-delete", cause),
          );
      threadChangesLogger.info("Thread Changes capture published.", {
        event: "thread_changes_capture_published",
        threadId: input.threadId,
        captureId: manifest.captureId,
        generation: manifest.generation,
      });
      return "captured" as const;
    } finally {
      await captureLease.release();
    }
  };

  const flushBestEffort = async (options?: {
    readonly detectUnchanged?: boolean;
  }) => {
    try {
      for (let attempt = 0; attempt < BEST_EFFORT_RACE_ATTEMPTS; attempt += 1) {
        if ((await flush(options)) !== "raced") return;
      }
    } catch (cause) {
      // A fresh workspace syncs before dxd is installed; the daemon's
      // registration captures Changes as soon as it is.
      if (
        (cause as { stage?: string } | undefined)?.stage ===
        "daemon-not-installed"
      )
        return;
      logFailure(input.threadId, "flush", cause);
    }
  };

  const queueResidentRefresh = async (
    lease: ThreadChangesMutationLease,
    released: {
      readonly state?: ThreadChangesState;
      readonly source?: ThreadChangesSource;
    },
  ) => {
    if (input.residentRefresh === undefined) return false;
    try {
      const refresh = refreshFrom(lease, released.state, released.source);
      return await input.residentRefresh(refresh);
    } catch (cause) {
      logFailure(input.threadId, "resident-refresh", cause);
      return false;
    }
  };

  const coordinateMutation = async <A>(
    operation: () => Promise<A>,
    options?: {
      readonly detectUnchanged?: boolean;
      readonly lease?: ThreadChangesMutationLease;
    },
    repair = false,
  ) => {
    const lease =
      options?.lease ??
      (await repository.beginMutation(input.threadId, MUTATION_LEASE_MS));
    const stopMaintainingLease = maintainMutationLease(input.threadId, lease);
    let operationResult: { readonly value: A } | undefined;
    let operationFailure: unknown;
    try {
      operationResult = { value: await operation() };
    } catch (cause) {
      operationFailure = cause;
    }
    const settle = async () => {
      await stopMaintainingLease();
      // The release and the refresh's reads share one round trip.
      let released:
        | Awaited<ReturnType<typeof lease.releaseAndRead>>
        | undefined;
      try {
        released = await lease.releaseAndRead();
      } catch (cause) {
        logFailure(input.threadId, "mutation-release", cause);
      }
      const dispatched =
        !repair &&
        released !== undefined &&
        (await queueResidentRefresh(lease, released));
      if (!dispatched) await flushBestEffort(options);
    };
    // The initial sync settles before the run continues; a command's result
    // returns while its lease settles. Its writes already happened, so the
    // Changes they make stay stale ("preview") until then, as during the
    // command itself.
    if (repair || input.waitUntil === undefined) await settle();
    else {
      const settlement = settle().catch((cause: unknown) =>
        logFailure(input.threadId, "mutation-settle", cause),
      );
      input.waitUntil(settlement);
    }
    if (operationResult !== undefined) return operationResult.value;
    throw operationFailure;
  };

  const runMutation = <A>(
    operation: () => Promise<A>,
    options?: {
      readonly detectUnchanged?: boolean;
      readonly lease?: ThreadChangesMutationLease;
    },
  ) => coordinateMutation(operation, options);

  const sync = () =>
    coordinateMutation(async () => undefined, { detectUnchanged: true }, true);

  return { sync, flush, runMutation };
};
