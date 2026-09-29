import { ThreadId } from "@dx/domain";
import type {
  Sandbox as E2BSandbox,
  SandboxApiOpts,
  SandboxConnectOpts,
  SandboxInfo,
  SandboxListOpts,
  SandboxOpts,
  SandboxPauseOpts,
} from "e2b";
import { Sandbox, SandboxNotFoundError } from "e2b";
import { Effect, Redacted, Schema, Semaphore } from "effect";
import { executionWorkspaceLogger } from "../../logging.js";
import type { E2BRequirements } from "./requirements.js";

const LIST_PAGE_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const RECONCILIATION_DELAYS_MS = [0, 250, 500, 750] as const;
const EXECUTION_CONTRACT_VERSION = "command-environment-v1";
const RESOLUTION_LOCK_LEASE_MS = 5 * 60_000;
const RESOLUTION_LOCK_WAIT_MS = 60_000;
const RESOLUTION_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 250, 500, 1_000] as const;

export class ExecutionWorkspaceUnavailable extends Schema.TaggedError<ExecutionWorkspaceUnavailable>()(
  "ExecutionWorkspaceUnavailable",
  {},
) {}

export class ExecutionWorkspaceConflict extends Schema.TaggedError<ExecutionWorkspaceConflict>()(
  "ExecutionWorkspaceConflict",
  { count: Schema.Int },
) {}

const providerCauses = new WeakMap<object, unknown>();

class FastPathFallback extends ExecutionWorkspaceUnavailable {}

class FastPathAuthorizationRejected extends ExecutionWorkspaceUnavailable {
  constructor(readonly sandbox: E2BSandbox) {
    super();
  }
}

const unavailable = (cause?: unknown) => {
  const error = new ExecutionWorkspaceUnavailable();
  if (cause !== undefined) providerCauses.set(error, cause);
  return error;
};

interface E2BPaginator {
  readonly hasNext: boolean;
  nextItems(): Promise<ReadonlyArray<SandboxInfo>>;
}

export interface E2BResolverApi {
  list(options: SandboxListOpts): E2BPaginator;
  getInfo(sandboxId: string, options: SandboxApiOpts): Promise<SandboxInfo>;
  connect(sandboxId: string, options: SandboxConnectOpts): Promise<E2BSandbox>;
  create(options: SandboxOpts): Promise<E2BSandbox>;
  kill(sandboxId: string, options: SandboxApiOpts): Promise<boolean>;
  pause(sandboxId: string, options: SandboxPauseOpts): Promise<boolean>;
  isNotFound(cause: unknown): boolean;
}

const liveE2BApi: E2BResolverApi = {
  list: (options) => Sandbox.list(options),
  getInfo: (sandboxId, options) => Sandbox.getInfo(sandboxId, options),
  connect: (sandboxId, options) => Sandbox.connect(sandboxId, options),
  create: (options) => Sandbox.create(options),
  kill: (sandboxId, options) => Sandbox.kill(sandboxId, options),
  pause: (sandboxId, options) => Sandbox.pause(sandboxId, options),
  isNotFound: (cause) => cause instanceof SandboxNotFoundError,
};

const ExecutionWorkspaceState = Schema.Literals([
  "uninitialized",
  "provisioning",
  "initialized",
  "lost",
  "legacy",
  "legacy_unavailable",
  "conflict",
]);

type ExecutionWorkspaceState = typeof ExecutionWorkspaceState.Type;

export interface ExecutionWorkspaceRecord {
  readonly state: ExecutionWorkspaceState;
  readonly providerSandboxId: string | null;
  readonly initializationAttemptId: string | null;
  readonly conflictCount: number | null;
}

export interface ExecutionWorkspaceStateStore {
  readonly read: (
    threadId: ThreadId,
  ) => Promise<ExecutionWorkspaceRecord | undefined>;
  readonly transition: (
    threadId: ThreadId,
    current: ExecutionWorkspaceRecord,
    next: ExecutionWorkspaceRecord,
  ) => Promise<boolean>;
}

const ExecutionWorkspaceRow = Schema.Struct({
  state: ExecutionWorkspaceState,
  provider_sandbox_id: Schema.NullOr(Schema.String),
  initialization_attempt_id: Schema.NullOr(Schema.String),
  conflict_count: Schema.NullOr(Schema.Int),
});

export const makeD1ExecutionWorkspaceStateStore = (
  db: D1Database,
): ExecutionWorkspaceStateStore => ({
  read: async (threadId) => {
    const row = await db
      .prepare(
        `SELECT state, provider_sandbox_id, initialization_attempt_id, conflict_count
           FROM execution_workspace
          WHERE thread_id = ? AND provider = 'e2b'
          LIMIT 1`,
      )
      .bind(threadId)
      .first();
    if (row === null) return undefined;
    const decoded = Schema.decodeUnknownSync(ExecutionWorkspaceRow)(row);
    return {
      state: decoded.state,
      providerSandboxId: decoded.provider_sandbox_id,
      initializationAttemptId: decoded.initialization_attempt_id,
      conflictCount: decoded.conflict_count,
    };
  },
  transition: async (threadId, current, next) => {
    const result = await db
      .prepare(
        `UPDATE execution_workspace
            SET state = ?,
                provider_sandbox_id = ?,
                initialization_attempt_id = ?,
                conflict_count = ?,
                updated_at = ?
          WHERE thread_id = ?
            AND provider = 'e2b'
            AND state = ?
            AND provider_sandbox_id IS ?
            AND initialization_attempt_id IS ?
            AND conflict_count IS ?`,
      )
      .bind(
        next.state,
        next.providerSandboxId,
        next.initializationAttemptId,
        next.conflictCount,
        new Date().toISOString(),
        threadId,
        current.state,
        current.providerSandboxId,
        current.initializationAttemptId,
        current.conflictCount,
      )
      .run();
    return result.meta.changes === 1;
  },
});

export interface ResolveExecutionWorkspaceOptions {
  readonly id: string;
  readonly requirements: E2BRequirements;
  readonly stateStore: ExecutionWorkspaceStateStore;
  /** Connect to the authoritative workspace without initializing one. */
  readonly existingOnly?: boolean;
  /**
   * Coordinates resolution across Worker isolates. The local semaphore below
   * remains useful for calls sharing one isolate, while production callers
   * provide a durable coordinator backed by D1.
   */
  readonly coordination?: ExecutionWorkspaceCoordinator;
  readonly authorizeResolution?: () => Promise<void>;
  readonly observeResolution?: (
    observation: ExecutionWorkspaceResolution,
  ) => void | Promise<void>;
  readonly observeOpening?: (state: "starting" | "waking") => void;
  /**
   * Agent startup uses this advisory provider state to avoid rerunning resume
   * against a known-running workspace. Unknown remains conservative.
   */
  readonly observeResidency?: (
    residency: ExecutionWorkspaceResidency,
  ) => void | Promise<void>;
  readonly observePhase?: (
    phase:
      | "workspace_lock_acquired"
      | "workspace_state_resolved"
      | "provider_connected",
  ) => void;
}

export type ExecutionWorkspaceResidency = "running" | "paused" | "unknown";

export interface ExecutionWorkspaceResolution {
  readonly decision: "create" | "connect";
  readonly outcome: "success" | "conflict" | "error";
  readonly durationMs: number;
  readonly cpuCores: number | null;
  readonly memoryMb: number | null;
}

export interface ExecutionWorkspaceResolutionLease {
  readonly release: () => Promise<void>;
}

export interface ExecutionWorkspaceCoordinator {
  readonly acquire: (key: string) => Promise<ExecutionWorkspaceResolutionLease>;
}

const sleep = (durationMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, durationMs));

/**
 * D1-backed lease acquisition is atomic, so independent Flue and terminal
 * Durable Object isolates cannot initialize or reconcile the same Thread at
 * the same time.
 */
export const makeD1ExecutionWorkspaceCoordinator = (
  db: D1Database,
): ExecutionWorkspaceCoordinator => ({
  acquire: async (key) => {
    const token = crypto.randomUUID();
    const deadline = Date.now() + RESOLUTION_LOCK_WAIT_MS;
    let retryIndex = 0;

    while (true) {
      const now = Date.now();
      const result = await db
        .prepare(
          `INSERT INTO execution_workspace_resolution_lock (
             lock_key, lease_token, lease_expires_at
           ) VALUES (?, ?, ?)
           ON CONFLICT(lock_key) DO UPDATE SET
             lease_token = excluded.lease_token,
             lease_expires_at = excluded.lease_expires_at
           WHERE execution_workspace_resolution_lock.lease_expires_at <= ?`,
        )
        .bind(key, token, now + RESOLUTION_LOCK_LEASE_MS, now)
        .run();
      if (result.meta.changes === 1) {
        return {
          release: async () => {
            await db
              .prepare(
                `DELETE FROM execution_workspace_resolution_lock
                 WHERE lock_key = ? AND lease_token = ?`,
              )
              .bind(key, token)
              .run();
          },
        };
      }

      if (Date.now() >= deadline)
        throw new Error("Execution workspace resolution lock timed out.");
      const delay =
        RESOLUTION_LOCK_RETRY_DELAYS_MS[
          Math.min(retryIndex, RESOLUTION_LOCK_RETRY_DELAYS_MS.length - 1)
        ] ?? 1_000;
      retryIndex += 1;
      await sleep(delay);
    }
  },
});

const identityMetadataFor = (environment: string, threadId: ThreadId) => ({
  app: "dx",
  environment,
  threadId,
});

const metadataFor = (
  environment: string,
  threadId: ThreadId,
  initializationAttemptId: string,
) => ({
  ...identityMetadataFor(environment, threadId),
  executionContract: EXECUTION_CONTRACT_VERSION,
  initializationAttempt: initializationAttemptId,
});

const readState = (store: ExecutionWorkspaceStateStore, threadId: ThreadId) =>
  Effect.tryPromise({
    try: () => store.read(threadId),
    catch: unavailable,
  }).pipe(
    Effect.flatMap((record) =>
      record === undefined
        ? Effect.fail(unavailable())
        : Effect.succeed(record),
    ),
  );

const transitionState = (
  store: ExecutionWorkspaceStateStore,
  threadId: ThreadId,
  current: ExecutionWorkspaceRecord,
  next: ExecutionWorkspaceRecord,
) =>
  Effect.tryPromise({
    try: () => store.transition(threadId, current, next),
    catch: unavailable,
  });

const conflictRecord = (
  record: ExecutionWorkspaceRecord,
  count: number,
): ExecutionWorkspaceRecord => ({
  state: "conflict",
  providerSandboxId: null,
  initializationAttemptId: record.initializationAttemptId,
  conflictCount: Math.max(1, count),
});

export interface PauseExecutionWorkspaceOptions {
  readonly id: string;
  readonly requirements: E2BRequirements;
  readonly stateStore: ExecutionWorkspaceStateStore;
  readonly coordination?: ExecutionWorkspaceCoordinator;
  readonly authorizePause?: () => Promise<void>;
}

export const makePauseExecutionWorkspace = (api: E2BResolverApi) =>
  Effect.fn("pauseExecutionWorkspace")(function* ({
    id,
    requirements,
    stateStore,
    coordination,
    authorizePause,
  }: PauseExecutionWorkspaceOptions) {
    const threadId = yield* Schema.decodeEffect(ThreadId)(id).pipe(
      Effect.mapError(unavailable),
    );
    const apiKey = Redacted.value(requirements.apiKey);
    const authorize =
      authorizePause === undefined
        ? Effect.void
        : Effect.tryPromise({ try: authorizePause, catch: unavailable });
    const pause = authorize.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const record = yield* readState(stateStore, threadId);
          if (record.state === "uninitialized") return 0;
          if (
            record.state !== "initialized" ||
            record.providerSandboxId === null
          )
            return yield* unavailable();
          // E2B returns false (HTTP 409) for a sandbox that is already
          // paused, e.g. by its idle timeout; that is the requested state.
          yield* Effect.tryPromise({
            try: () =>
              api.pause(record.providerSandboxId as string, {
                apiKey,
                requestTimeoutMs: REQUEST_TIMEOUT_MS,
                keepMemory: true,
              }),
            catch: (cause) => cause,
          }).pipe(
            Effect.catch((cause) =>
              api.isNotFound(cause)
                ? transitionState(stateStore, threadId, record, {
                    ...record,
                    state: "lost",
                  }).pipe(Effect.andThen(Effect.fail(unavailable(cause))))
                : Effect.sync(() =>
                    executionWorkspaceLogger.warn(
                      "E2B workspace pause failed.",
                      {
                        event: "execution_workspace_pause_failed",
                        threadId,
                        error:
                          cause instanceof Error ? cause.name : typeof cause,
                      },
                    ),
                  ).pipe(Effect.andThen(Effect.fail(unavailable(cause)))),
            ),
          );
          return 1;
        }),
      ),
    );
    if (coordination === undefined) return yield* pause;
    const lease = yield* Effect.tryPromise({
      try: () => coordination.acquire(`${requirements.dxEnv}:${threadId}`),
      catch: unavailable,
    });
    return yield* Effect.ensuring(
      pause,
      Effect.tryPromise({
        try: () => lease.release(),
        catch: () => undefined,
      }).pipe(Effect.ignore),
    );
  });

export const pauseExecutionWorkspace = makePauseExecutionWorkspace(liveE2BApi);

export const makeResolveExecutionWorkspace = (api: E2BResolverApi) => {
  const listMatches = Effect.fn("listExecutionWorkspaces")(function* (
    metadata: Record<string, string>,
    apiKey: string,
  ) {
    return yield* Effect.tryPromise({
      try: async () => {
        const paginator = api.list({
          apiKey,
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
          limit: LIST_PAGE_LIMIT,
          query: { metadata, state: ["running", "paused"] },
        });
        const matches: Array<SandboxInfo> = [];
        while (paginator.hasNext)
          matches.push(...(await paginator.nextItems()));
        return matches;
      },
      catch: unavailable,
    });
  });

  const resolutionLocks = new Map<
    string,
    { readonly semaphore: Semaphore.Semaphore; users: number }
  >();
  const withResolutionLock = <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      let lock = resolutionLocks.get(key);
      if (lock === undefined) {
        lock = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        resolutionLocks.set(key, lock);
      }
      lock.users += 1;
      const currentLock = lock;
      return Effect.ensuring(
        currentLock.semaphore.withPermit(effect),
        Effect.sync(() => {
          currentLock.users -= 1;
          if (
            currentLock.users === 0 &&
            resolutionLocks.get(key) === currentLock
          )
            resolutionLocks.delete(key);
        }),
      );
    });

  const resolveUnlocked = Effect.fn("resolveExecutionWorkspace")(function* (
    {
      id,
      requirements,
      stateStore,
      existingOnly,
      coordination,
      authorizeResolution,
      observeResolution,
      observeOpening,
      observeResidency,
      observePhase,
    }: ResolveExecutionWorkspaceOptions,
    fastPath?: {
      readonly threadId: ThreadId;
      readonly record: ExecutionWorkspaceRecord;
      readonly info: SandboxInfo;
    },
    coordinationLeaseHeld = false,
  ) {
    const startedAt = Date.now();
    const threadId =
      fastPath?.threadId ??
      (yield* Schema.decodeEffect(ThreadId)(id).pipe(
        Effect.mapError(unavailable),
      ));
    const notify = (observation: ExecutionWorkspaceResolution) =>
      observeResolution === undefined
        ? Effect.void
        : Effect.tryPromise({
            try: () => Promise.resolve(observeResolution(observation)),
            catch: () => undefined,
          }).pipe(
            Effect.catch(() =>
              Effect.sync(() =>
                executionWorkspaceLogger.warn(
                  "E2B usage observation could not be recorded.",
                  {
                    event: "usage_record_failed",
                    source: "e2b",
                    threadId,
                    decision: observation.decision,
                    outcome: observation.outcome,
                  },
                ),
              ),
            ),
          );
    const resolution = (
      decision: ExecutionWorkspaceResolution["decision"],
      outcome: ExecutionWorkspaceResolution["outcome"],
      info?: SandboxInfo,
    ): ExecutionWorkspaceResolution => ({
      decision,
      outcome,
      durationMs: Date.now() - startedAt,
      cpuCores:
        info !== undefined &&
        Number.isFinite(info.cpuCount) &&
        info.cpuCount > 0
          ? info.cpuCount
          : null,
      memoryMb:
        info !== undefined &&
        Number.isInteger(info.memoryMB) &&
        info.memoryMB >= 0
          ? info.memoryMB
          : null,
    });
    const apiKey = Redacted.value(requirements.apiKey);
    let decision: ExecutionWorkspaceResolution["decision"] = "connect";
    let observedInfo: SandboxInfo | undefined;

    const connectPersisted = Effect.fn("connectPersistedExecutionWorkspace")(
      function* (
        record: ExecutionWorkspaceRecord,
        info?: SandboxInfo,
        fallbackOnNotFound = false,
      ) {
        if (record.providerSandboxId === null) return yield* unavailable();
        let residencyInfo = info;
        if (observeResidency !== undefined && residencyInfo === undefined) {
          residencyInfo = yield* Effect.tryPromise({
            try: () =>
              api.getInfo(record.providerSandboxId as string, {
                apiKey,
                requestTimeoutMs: REQUEST_TIMEOUT_MS,
              }),
            catch: (cause) => cause,
          }).pipe(
            Effect.catch((cause) =>
              api.isNotFound(cause)
                ? transitionState(stateStore, threadId, record, {
                    ...record,
                    state: "lost",
                  }).pipe(Effect.andThen(Effect.fail(unavailable(cause))))
                : Effect.succeed(undefined),
            ),
          );
        }
        if (observeResidency !== undefined) {
          const residency: ExecutionWorkspaceResidency =
            residencyInfo?.state === "running"
              ? "running"
              : residencyInfo?.state === "paused"
                ? "paused"
                : "unknown";
          yield* Effect.tryPromise({
            try: () => Promise.resolve(observeResidency(residency)),
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.void));
        }
        observeOpening?.("waking");
        const connected = yield* Effect.tryPromise({
          try: () =>
            api.connect(record.providerSandboxId as string, {
              apiKey,
              requestTimeoutMs: REQUEST_TIMEOUT_MS,
              timeoutMs: requirements.timeoutMs,
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            api.isNotFound(cause)
              ? fallbackOnNotFound
                ? Effect.fail(new FastPathFallback())
                : transitionState(stateStore, threadId, record, {
                    ...record,
                    state: "lost",
                  }).pipe(Effect.andThen(Effect.fail(unavailable(cause))))
              : Effect.fail(unavailable(cause)),
          ),
        );
        try {
          observePhase?.("provider_connected");
        } catch {
          // Startup instrumentation is passive.
        }
        observedInfo = residencyInfo;
        return connected;
      },
    );

    const markConflict = Effect.fn("markExecutionWorkspaceConflict")(function* (
      record: ExecutionWorkspaceRecord,
      count: number,
    ) {
      yield* transitionState(
        stateStore,
        threadId,
        record,
        conflictRecord(record, count),
      );
      return yield* new ExecutionWorkspaceConflict({
        count: Math.max(1, count),
      });
    });

    const reconcile = Effect.fn("reconcileExecutionWorkspace")(function* (
      record: ExecutionWorkspaceRecord,
    ) {
      const delays =
        record.state === "provisioning"
          ? RECONCILIATION_DELAYS_MS
          : ([0] as const);
      for (const delayMs of delays) {
        if (delayMs > 0) yield* Effect.sleep(delayMs);
        const matches = yield* listMatches(
          identityMetadataFor(requirements.dxEnv, threadId),
          apiKey,
        );
        if (matches.length > 1)
          return yield* markConflict(record, matches.length);
        const match = matches[0];
        if (match === undefined) continue;
        const compatible =
          record.state === "provisioning"
            ? match.metadata.executionContract === EXECUTION_CONTRACT_VERSION &&
              match.metadata.initializationAttempt ===
                record.initializationAttemptId
            : match.metadata.executionContract === undefined ||
              match.metadata.executionContract === EXECUTION_CONTRACT_VERSION;
        if (!compatible) return yield* markConflict(record, 1);
        const initialized: ExecutionWorkspaceRecord = {
          state: "initialized",
          providerSandboxId: match.sandboxId,
          initializationAttemptId: null,
          conflictCount: null,
        };
        const transitioned = yield* transitionState(
          stateStore,
          threadId,
          record,
          initialized,
        );
        if (!transitioned) {
          const current = yield* readState(stateStore, threadId);
          if (
            current.state !== "initialized" ||
            current.providerSandboxId !== match.sandboxId
          )
            return yield* unavailable();
          return yield* connectPersisted(current, match);
        }
        return yield* connectPersisted(initialized, match);
      }
      if (record.state === "legacy") {
        yield* transitionState(stateStore, threadId, record, {
          state: "legacy_unavailable",
          providerSandboxId: null,
          initializationAttemptId: null,
          conflictCount: null,
        });
      }
      return yield* unavailable();
    });

    const resolveState = Effect.fn("resolveExecutionWorkspaceState")(function* (
      record: ExecutionWorkspaceRecord,
    ) {
      switch (record.state) {
        case "initialized":
          return yield* connectPersisted(
            record,
            fastPath?.info,
            fastPath !== undefined,
          );
        case "provisioning":
        case "legacy":
          return yield* reconcile(record);
        case "conflict":
          return yield* new ExecutionWorkspaceConflict({
            count: record.conflictCount ?? 1,
          });
        case "lost":
        case "legacy_unavailable":
          return yield* unavailable();
        case "uninitialized": {
          if (existingOnly) return yield* unavailable();
          decision = "create";
          const provisioning: ExecutionWorkspaceRecord = {
            state: "provisioning",
            providerSandboxId: null,
            initializationAttemptId: crypto.randomUUID(),
            conflictCount: null,
          };
          const began = yield* transitionState(
            stateStore,
            threadId,
            record,
            provisioning,
          );
          if (!began) return yield* unavailable();
          observeOpening?.("starting");
          let reconciledAfterCreate = false;
          const created = yield* Effect.tryPromise({
            try: () =>
              api.create({
                apiKey,
                requestTimeoutMs: REQUEST_TIMEOUT_MS,
                template: requirements.template,
                timeoutMs: requirements.timeoutMs,
                metadata: metadataFor(
                  requirements.dxEnv,
                  threadId,
                  provisioning.initializationAttemptId as string,
                ),
                allowInternetAccess: true,
                lifecycle: {
                  onTimeout: { action: "pause", keepMemory: true },
                  autoResume: true,
                },
              }),
            catch: (cause) => cause,
          }).pipe(
            Effect.catch((cause) =>
              reconcile(provisioning).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    decision = "connect";
                    reconciledAfterCreate = true;
                  }),
                ),
                Effect.catchTag("ExecutionWorkspaceUnavailable", () =>
                  Effect.fail(unavailable(cause)),
                ),
              ),
            ),
          );
          if (reconciledAfterCreate) return created;
          const initialized: ExecutionWorkspaceRecord = {
            state: "initialized",
            providerSandboxId: created.sandboxId,
            initializationAttemptId: null,
            conflictCount: null,
          };
          const persisted = yield* transitionState(
            stateStore,
            threadId,
            provisioning,
            initialized,
          );
          if (!persisted) {
            const current = yield* readState(stateStore, threadId);
            if (
              current.state !== "initialized" ||
              current.providerSandboxId !== created.sandboxId
            ) {
              yield* Effect.tryPromise({
                try: () =>
                  api.kill(created.sandboxId, {
                    apiKey,
                    requestTimeoutMs: REQUEST_TIMEOUT_MS,
                  }),
                catch: unavailable,
              });
              return yield* unavailable();
            }
          }
          return created;
        }
      }
    });

    const state = fastPath?.record ?? (yield* readState(stateStore, threadId));
    try {
      observePhase?.("workspace_state_resolved");
    } catch {
      // Startup instrumentation is passive.
    }
    const sandbox = yield* resolveState(state).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (error instanceof FastPathFallback)
            return yield* Effect.fail(error);
          const outcome =
            error instanceof ExecutionWorkspaceConflict ? "conflict" : "error";
          executionWorkspaceLogger.error("E2B workspace resolution failed.", {
            event: "execution_workspace_resolution",
            threadId,
            decision,
            outcome,
            durationMs: Date.now() - startedAt,
          });
          yield* notify(resolution(decision, outcome, observedInfo));
          return yield* error;
        }),
      ),
    );

    if (fastPath !== undefined && authorizeResolution !== undefined) {
      const authorizeFastPath = Effect.tryPromise({
        try: authorizeResolution,
        catch: () => unavailable(),
      }).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      const authorized = yield* coordination === undefined ||
      coordinationLeaseHeld
        ? authorizeFastPath
        : Effect.acquireUseRelease(
            Effect.tryPromise({
              try: () =>
                coordination.acquire(`${requirements.dxEnv}:${threadId}`),
              catch: unavailable,
            }),
            () => authorizeFastPath,
            (lease) =>
              Effect.tryPromise({
                try: () => lease.release(),
                catch: () => undefined,
              }).pipe(Effect.ignore),
          );
      if (!authorized)
        return yield* Effect.fail(new FastPathAuthorizationRejected(sandbox));
    }

    executionWorkspaceLogger.info("E2B workspace resolved.", {
      event: "execution_workspace_resolution",
      threadId,
      decision,
      outcome: "success",
      durationMs: Date.now() - startedAt,
    });
    yield* notify(resolution(decision, "success", observedInfo));
    return sandbox;
  });

  return Effect.fn("resolveExecutionWorkspace")(function* (
    options: ResolveExecutionWorkspaceOptions,
  ) {
    const threadId = yield* Schema.decodeEffect(ThreadId)(options.id).pipe(
      Effect.mapError(unavailable),
    );
    const key = `${options.requirements.dxEnv}:${threadId}`;
    const coordinator = options.coordination;
    const authorize =
      options.authorizeResolution === undefined
        ? Effect.void
        : Effect.tryPromise({
            try: options.authorizeResolution,
            catch: unavailable,
          });
    const authorizedResolve = authorize.pipe(
      Effect.andThen(resolveUnlocked(options)),
    );
    const lockedResolve =
      coordinator === undefined
        ? Effect.sync(() => {
            try {
              options.observePhase?.("workspace_lock_acquired");
            } catch {
              // Startup instrumentation is passive.
            }
          }).pipe(Effect.andThen(authorizedResolve))
        : Effect.gen(function* () {
            const lease = yield* Effect.tryPromise({
              try: () => coordinator.acquire(key),
              catch: unavailable,
            });
            try {
              options.observePhase?.("workspace_lock_acquired");
            } catch {
              // Startup instrumentation is passive.
            }
            return yield* Effect.ensuring(
              authorizedResolve,
              Effect.tryPromise({
                try: () => lease.release(),
                catch: () => {
                  executionWorkspaceLogger.warn(
                    "E2B resolution lease release could not be recorded.",
                    {
                      event:
                        "execution_workspace_resolution_lock_release_failed",
                      threadId,
                      outcome: "error",
                    },
                  );
                  return undefined;
                },
              }).pipe(Effect.catch(() => Effect.void)),
            );
          });
    const bestEffortPause = (record: ExecutionWorkspaceRecord) =>
      record.state !== "initialized" || record.providerSandboxId === null
        ? Effect.void
        : Effect.tryPromise({
            try: () =>
              api.pause(record.providerSandboxId as string, {
                apiKey: Redacted.value(options.requirements.apiKey),
                requestTimeoutMs: REQUEST_TIMEOUT_MS,
                keepMemory: true,
              }),
            catch: (cause) => cause,
          }).pipe(
            Effect.catch((cause) =>
              api.isNotFound(cause)
                ? transitionState(options.stateStore, threadId, record, {
                    ...record,
                    state: "lost",
                  }).pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.asVoid,
          );
    const repairRejectedFastPath = (
      rejected: FastPathAuthorizationRejected,
      record: ExecutionWorkspaceRecord,
    ) => {
      const repair = Effect.tryPromise({
        try: options.authorizeResolution as () => Promise<void>,
        catch: () => unavailable(),
      }).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
        Effect.flatMap((authorized) =>
          authorized
            ? Effect.succeed(rejected.sandbox)
            : readState(options.stateStore, threadId).pipe(
                Effect.flatMap((current) => bestEffortPause(current)),
                Effect.andThen(Effect.fail(unavailable())),
              ),
        ),
      );
      if (coordinator === undefined) return repair;
      return Effect.tryPromise({
        try: () => coordinator.acquire(key),
        catch: () => undefined,
      }).pipe(
        Effect.flatMap((lease) =>
          lease === undefined
            ? bestEffortPause(record).pipe(
                Effect.andThen(Effect.fail(unavailable())),
              )
            : Effect.ensuring(
                repair,
                Effect.tryPromise({
                  try: () => lease.release(),
                  catch: () => undefined,
                }).pipe(Effect.ignore),
              ),
        ),
      );
    };
    const fastPath =
      options.authorizeResolution === undefined
        ? lockedResolve
        : authorize.pipe(
            Effect.andThen(readState(options.stateStore, threadId)),
            Effect.flatMap((record) => {
              if (
                record.state !== "initialized" ||
                record.providerSandboxId === null
              )
                return Effect.fail(new FastPathFallback());
              return Effect.tryPromise({
                try: () =>
                  api.getInfo(record.providerSandboxId as string, {
                    apiKey: Redacted.value(options.requirements.apiKey),
                    requestTimeoutMs: REQUEST_TIMEOUT_MS,
                  }),
                catch: () => new FastPathFallback(),
              }).pipe(
                Effect.flatMap((info) =>
                  info.state === "running" &&
                  info.sandboxId === record.providerSandboxId
                    ? authorize
                        .pipe(
                          Effect.andThen(
                            readState(options.stateStore, threadId),
                          ),
                          Effect.flatMap((current) =>
                            current.state === "initialized" &&
                            current.providerSandboxId ===
                              record.providerSandboxId
                              ? resolveUnlocked(
                                  options,
                                  { threadId, record: current, info },
                                  coordinator !== undefined,
                                )
                              : Effect.fail(new FastPathFallback()),
                          ),
                          (resolveCurrent) =>
                            coordinator === undefined
                              ? resolveCurrent
                              : Effect.acquireUseRelease(
                                  Effect.tryPromise({
                                    try: () => coordinator.acquire(key),
                                    catch: unavailable,
                                  }),
                                  () => resolveCurrent,
                                  (lease) =>
                                    Effect.tryPromise({
                                      try: () => lease.release(),
                                      catch: () => undefined,
                                    }).pipe(Effect.ignore),
                                ),
                        )
                        .pipe(
                          Effect.catch((error) =>
                            error instanceof FastPathAuthorizationRejected
                              ? repairRejectedFastPath(error, record)
                              : Effect.fail(error),
                          ),
                        )
                    : Effect.fail(new FastPathFallback()),
                ),
              );
            }),
            Effect.catch((error) =>
              error instanceof FastPathFallback
                ? lockedResolve
                : Effect.fail(error),
            ),
          );
    return yield* withResolutionLock(key, fastPath);
  });
};

export const resolveExecutionWorkspace =
  makeResolveExecutionWorkspace(liveE2BApi);

export const makeConnectExistingExecutionWorkspace = (api: E2BResolverApi) => {
  const resolve = makeResolveExecutionWorkspace(api);
  return Effect.fn("connectExistingExecutionWorkspace")(
    (options: Omit<ResolveExecutionWorkspaceOptions, "existingOnly">) =>
      resolve({ ...options, existingOnly: true }),
  );
};

export const connectExistingExecutionWorkspace =
  makeConnectExistingExecutionWorkspace(liveE2BApi);
