import type { ThreadId } from "@dx/domain";
import type { Sandbox } from "@flue/runtime";
import type { DxdChangesRefresh } from "../execution/dxd/protocol.js";
import { threadChangesLogger } from "../logging.js";
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
} from "./repository-d1.js";

const MUTATION_LEASE_MS = 2 * 60_000;
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
    options?: { readonly detectUnchanged?: boolean },
  ) => Promise<A>;
}

type ThreadChangesRepository = ReturnType<typeof makeThreadChangesRepository>;

const logFailure = (threadId: ThreadId, stage: string, _cause: unknown) => {
  threadChangesLogger.warn("Thread Changes capture failed.", {
    event: "thread_changes_capture_failed",
    stage,
    threadId,
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

const refreshFor = async (
  repository: ThreadChangesRepository,
  threadId: ThreadId,
  lease: ThreadChangesMutationLease,
): Promise<DxdChangesRefresh> => {
  const [state, source] = await Promise.all([
    repository.read(threadId),
    repository.source(threadId),
  ]);
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
    const refresh = await refreshFor(repository, input.threadId, lease);
    return await input.operation(refresh);
  } finally {
    await stopMaintainingLease();
    await lease
      .release()
      .catch((cause) => logFailure(input.threadId, "mutation-release", cause));
    // A candidate produced during the save is only a preview. Confirm again
    // after release so even the last save can clear dirty_since without a timer.
    if (input.residentRefresh !== undefined) {
      try {
        await input.residentRefresh(
          await refreshFor(repository, input.threadId, lease),
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
      logFailure(input.threadId, "flush", cause);
    }
  };

  const queueResidentRefresh = async (lease: ThreadChangesMutationLease) => {
    if (input.residentRefresh === undefined) return false;
    try {
      const refresh = await refreshFor(repository, input.threadId, lease);
      return await input.residentRefresh(refresh);
    } catch (cause) {
      logFailure(input.threadId, "resident-refresh", cause);
      return false;
    }
  };

  const coordinateMutation = async <A>(
    operation: () => Promise<A>,
    options?: { readonly detectUnchanged?: boolean },
    repair = false,
  ) => {
    const lease = await repository.beginMutation(
      input.threadId,
      MUTATION_LEASE_MS,
    );
    const stopMaintainingLease = maintainMutationLease(input.threadId, lease);
    let operationResult: { readonly value: A } | undefined;
    let operationFailure: unknown;
    try {
      operationResult = { value: await operation() };
    } catch (cause) {
      operationFailure = cause;
    }
    await stopMaintainingLease();
    try {
      await lease.release();
    } catch (cause) {
      logFailure(input.threadId, "mutation-release", cause);
    }
    const dispatched = !repair && (await queueResidentRefresh(lease));
    if (!dispatched) await flushBestEffort(options);
    if (operationResult !== undefined) return operationResult.value;
    throw operationFailure;
  };

  const runMutation = <A>(
    operation: () => Promise<A>,
    options?: { readonly detectUnchanged?: boolean },
  ) => coordinateMutation(operation, options);

  const sync = () =>
    coordinateMutation(async () => undefined, { detectUnchanged: true }, true);

  return { sync, flush, runMutation };
};
