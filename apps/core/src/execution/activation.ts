import { env } from "cloudflare:workers";
import { ThreadId } from "@dx/domain";
import type { SandboxFactory } from "@flue/runtime";
import { Effect, Schema } from "effect";
import type { Bindings } from "../http/types.js";
import { executionWorkspaceLogger, threadDaemonLogger } from "../logging.js";
import {
  activeSubmissionId,
  recordActiveSubmissionPhase,
} from "../observability/startup-runtime.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import type {
  DaemonInstallation,
  DaemonInstallOutcome,
  EnsureDaemonInput,
  ExecutionActivation,
  ExecutionContext,
  ExecutionProvider,
  ExecutionWorkspaceHandle,
  ExecutionWorkspaceResidency,
} from "../plugins/execution/provider.js";
import { executionWorkspaceTools } from "../plugins/execution/tools.js";
import {
  publishRealtimeInvalidation,
  publishRealtimeWorkspaceStatus,
} from "../realtime/publication.js";
import { resolveExecutionEnvironment } from "../settings/environment-variables/execution.js";
import { withExecutionEnvironment } from "../settings/environment-variables/sandbox.js";
import {
  SOURCE_WORKSPACE_CWD,
  type SourceWorkspacePreparationPhase,
} from "../source-control/source-workspace.js";
import { makeThreadChangesCoordinator } from "../thread-changes/coordinator.js";
import { makeThreadChangesRepository } from "../thread-changes/repository-d1.js";
import {
  queueThreadChangesRefresh,
  startThreadDaemonActivation,
} from "../threads/daemon-client.js";
import { createWorkspaceActivity, type WorkspaceActivity } from "./activity.js";
import {
  activateSourceWorkspace,
  ensureGithubCliWrapper,
  withSourceRuntimeAdmission,
} from "./source-preparation.js";
import {
  markExecutionWorkspaceReady,
  readExecutionWorkspaceReadiness,
  setExecutionWorkspacePreparationStatus,
} from "./workspace-readiness.js";

/**
 * Core's Execution activation pipeline, the same for every provider:
 *
 *   create/connect (provider) → source preparation → `gh` wrapper →
 *   [prepared hook] → readiness → daemon kick → environment, Changes,
 *   source admission, and activity decoration
 *
 * A provider only returns raw handles
 * ([`ExecutionWorkspaceProvider`](../plugins/execution/provider.ts)). The
 * pinned context is resolved once per activation by composition and passed
 * in; nothing here adds a provider call or a D1 read to the wake path.
 */

interface ActivityEntry {
  readonly activity: WorkspaceActivity;
  readonly host: {
    setDeadline: (durationMs: number) => Promise<void>;
  };
  residentTerminal?: {
    foregroundCommand: boolean;
    readonly detach: () => void;
  };
}
const activities = new Map<ThreadId, ActivityEntry>();

const residentActivityInitializations = new Map<ThreadId, Promise<void>>();

const sourcePreparationStatus = {
  "cloning-repository": "Cloning repository…",
  "running-setup": "Setting up machine…",
} satisfies Record<SourceWorkspacePreparationPhase, string>;

const reportWorkspacePreparation = async (
  bindings: Bindings,
  db: D1Database,
  threadId: ThreadId,
  status: string | null,
) => {
  try {
    await setExecutionWorkspacePreparationStatus(db, threadId, status);
    await publishRealtimeInvalidation(
      bindings,
      threadId,
      "readiness.invalidated",
    );
  } catch {
    executionWorkspaceLogger.warn(
      "Execution workspace preparation status could not be recorded.",
      {
        event: "execution_workspace_preparation_status",
        threadId,
        outcome: "error",
      },
    );
  }
};

const sourcePreparationReporter =
  (bindings: Bindings, db: D1Database, threadId: ThreadId) =>
  (phase: SourceWorkspacePreparationPhase) =>
    Effect.promise(() =>
      reportWorkspacePreparation(
        bindings,
        db,
        threadId,
        sourcePreparationStatus[phase],
      ),
    );

const activityFor = (
  threadId: ThreadId,
  setDeadline: (durationMs: number) => Promise<void>,
  inactivityMs?: number,
) => {
  const existing = activities.get(threadId);
  if (existing !== undefined) {
    existing.host.setDeadline = setDeadline;
    return existing.activity;
  }
  const host = { setDeadline };
  let entry: ActivityEntry;
  const activity = createWorkspaceActivity(
    {
      setDeadline: (durationMs) => host.setDeadline(durationMs),
      onIdle: () => {
        if (activities.get(threadId) === entry) activities.delete(threadId);
      },
    },
    undefined,
    inactivityMs,
  );
  entry = {
    host,
    activity,
  };
  activities.set(threadId, entry);
  return activity;
};

const handleActivity = (threadId: ThreadId, handle: ExecutionWorkspaceHandle) =>
  activityFor(threadId, handle.setIdleDeadline, handle.inactivityMs);

const residentRefreshFor = (bindings: Bindings, threadId: ThreadId) =>
  bindings.THREAD_EXECUTION === undefined
    ? undefined
    : (refresh: Parameters<typeof queueThreadChangesRefresh>[2]) =>
        queueThreadChangesRefresh(bindings, threadId, refresh);

const kickDaemonActivation = (
  bindings: Bindings,
  threadId: ThreadId,
  submissionId?: string,
) => {
  void startThreadDaemonActivation(bindings, threadId, submissionId);
};

export const withCommandActivity = (
  factory: SandboxFactory,
  activityForCommand: () => WorkspaceActivity,
  defaultTimeoutMs: number,
  authorizeCommand: () => Promise<void>,
): SandboxFactory => ({
  async createSandbox(request) {
    const sandbox = await factory.createSandbox(request);
    return {
      ...sandbox,
      async exec(command, options) {
        await authorizeCommand();
        return activityForCommand().runCommand(
          options?.timeoutMs ?? defaultTimeoutMs,
          () => sandbox.exec(command, options),
        );
      },
      async writeFile(path, content) {
        await authorizeCommand();
        return activityForCommand().runCommand(defaultTimeoutMs, () =>
          sandbox.writeFile(path, content),
        );
      },
      async mkdir(path, options) {
        await authorizeCommand();
        return activityForCommand().runCommand(defaultTimeoutMs, () =>
          sandbox.mkdir(path, options),
        );
      },
      async rm(path, options) {
        await authorizeCommand();
        return activityForCommand().runCommand(defaultTimeoutMs, () =>
          sandbox.rm(path, options),
        );
      },
    };
  },
  ...(factory.tools === undefined ? {} : { tools: factory.tools }),
});

export const withThreadChanges = (
  factory: SandboxFactory,
  input: {
    readonly db: D1Database;
    readonly bucket: R2Bucket;
    readonly threadId: ThreadId;
    readonly onInitialSyncSettled?: () => void;
    readonly residentRefresh?: Parameters<
      typeof makeThreadChangesCoordinator
    >[0]["residentRefresh"];
  },
): SandboxFactory => ({
  async createSandbox(request) {
    const sandbox = await factory.createSandbox(request);
    const { onInitialSyncSettled, ...coordinatorInput } = input;
    const changes = makeThreadChangesCoordinator({
      ...coordinatorInput,
      sandbox,
    });
    const initialSync = changes
      .sync()
      .then(() => onInitialSyncSettled?.())
      .catch(() => {
        // The next activation repairs a missed capture. Startup must continue.
      });
    const runMutation = async <A>(
      operation: () => Promise<A>,
      options?: { readonly detectUnchanged?: boolean },
    ) => {
      await initialSync;
      return changes.runMutation(operation, options);
    };
    return {
      ...sandbox,
      exec: (command, options) =>
        runMutation(() => sandbox.exec(command, options), {
          detectUnchanged: true,
        }),
      writeFile: (path, content) =>
        runMutation(() => sandbox.writeFile(path, content)),
      mkdir: (path, options) => runMutation(() => sandbox.mkdir(path, options)),
      rm: (path, options) => runMutation(() => sandbox.rm(path, options)),
    };
  },
  ...(factory.tools === undefined ? {} : { tools: factory.tools }),
});

export const withThreadChangesIfSourced = async (
  factory: SandboxFactory,
  input: Parameters<typeof withThreadChanges>[1],
): Promise<SandboxFactory> =>
  (await makeThreadChangesRepository(input.db).source(input.threadId)) ===
  undefined
    ? factory
    : withThreadChanges(factory, input);

type SandboxRequest = Parameters<SandboxFactory["createSandbox"]>[0];
type FlueSandbox = Awaited<ReturnType<SandboxFactory["createSandbox"]>>;
const abortError = () => new Error("Daemon activation aborted.");

const throwIfAborted = (signal: AbortSignal | undefined) => {
  if (signal?.aborted) throw abortError();
};

export const assertThreadLifecycleState = async (
  db: D1Database,
  threadId: string,
  lifecycleState: "active" | "archived",
) => {
  const row = await db
    .prepare("SELECT lifecycle_state FROM threads WHERE id = ? LIMIT 1")
    .bind(threadId)
    .first<{ lifecycle_state: string }>();
  if (row?.lifecycle_state !== lifecycleState)
    throw new Error(`Thread is not ${lifecycleState}.`);
};

export const assertThreadActive = (db: D1Database, threadId: string) =>
  assertThreadLifecycleState(db, threadId, "active");

/**
 * Between source preparation and the workspace's first use, for 4e's warm
 * snapshot capture. Nothing registers one yet.
 */
export interface ExecutionActivationHooks {
  readonly prepared?: (event: {
    readonly context: ExecutionContext;
    readonly threadId: ThreadId;
    readonly handle: ExecutionWorkspaceHandle;
    readonly firstPreparation: boolean;
  }) => Promise<void>;
}

type DaemonInstallationStage = "release" | "workspace" | "source" | "guest";

class DaemonInstallationStageError extends Error {
  constructor(
    readonly stage: DaemonInstallationStage,
    readonly failure: unknown,
  ) {
    super(`Thread daemon installation failed during ${stage}.`);
  }
}

/** How long a resumed guest's daemon gets to reconnect before bootstrap. */
const DAEMON_SELF_REGISTRATION_WAIT_MS = 3_000;

/** Attributes a provider's failure to an installation stage in Core's log. */
export const atDaemonInstallationStage = async <Value>(
  stage: DaemonInstallationStage,
  operation: Promise<Value>,
): Promise<Value> => {
  try {
    return await operation;
  } catch (cause) {
    throw new DaemonInstallationStageError(stage, cause);
  }
};

/** Core's activation pipeline over one provider's raw handles. */
export const makeExecutionActivation =
  (hooks: ExecutionActivationHooks = {}) =>
  (provider: ExecutionProvider): ExecutionActivation => {
    const open = async (
      context: ExecutionContext,
      { id }: SandboxRequest,
      existingOnly: boolean,
    ): Promise<FlueSandbox> => {
      const bindings = env as Bindings;
      const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
      await assertThreadActive(db, id);
      const threadId = Schema.decodeUnknownSync(ThreadId)(id);
      const authorize = () => assertThreadActive(db, id);
      const needsFirstReadiness = !existingOnly
        ? await readExecutionWorkspaceReadiness(db, threadId)
            .then((readiness) => !readiness.ready)
            .catch(() => true)
        : false;
      if (needsFirstReadiness)
        await reportWorkspacePreparation(
          bindings,
          db,
          threadId,
          "Preparing workspace…",
        );
      let wakeStatusPublished = false;
      try {
        const residency: { value: ExecutionWorkspaceResidency } = {
          value: "unknown",
        };
        const handle = existingOnly
          ? await provider.workspace.connect(
              context,
              { threadId },
              { authorize },
            )
          : await provider.workspace.create(
              context,
              { threadId },
              {
                authorize,
                observeResidency: async (observed) => {
                  residency.value = observed;
                  if (observed === "paused" && !needsFirstReadiness) {
                    wakeStatusPublished = true;
                    await publishRealtimeWorkspaceStatus(
                      bindings,
                      threadId,
                      "waking",
                    );
                  }
                },
              },
            );
        void recordActiveSubmissionPhase(bindings, id, "workspace_resolved");
        if (needsFirstReadiness)
          await reportWorkspacePreparation(
            bindings,
            db,
            threadId,
            "Preparing source…",
          );
        const source = await handle.development?.source();
        // Source preparation runs on the raw guest, outside the agent's
        // command leases, and its setup and resume hooks can outlast the
        // provider deadline that create/connect just set. Hold the Thread's
        // activity lease so the idle deadline keeps renewing until it ends.
        const preparation = handleActivity(threadId, handle).retain();
        let sourceCwd: string;
        try {
          sourceCwd = await activateSourceWorkspace(
            bindings,
            db,
            id,
            handle.guest,
            true,
            source,
            needsFirstReadiness
              ? undefined
              : sourcePreparationReporter(bindings, db, threadId),
            residency.value !== "running" || needsFirstReadiness,
          );
          if (source === undefined)
            await ensureGithubCliWrapper(db, id, handle.guest);
          await hooks.prepared?.({
            context,
            threadId,
            handle,
            firstPreparation: needsFirstReadiness,
          });
        } finally {
          preparation.release();
        }
        void recordActiveSubmissionPhase(bindings, id, "source_activated");
        if (wakeStatusPublished)
          await publishRealtimeWorkspaceStatus(bindings, threadId, "ready");
        if (needsFirstReadiness) {
          await reportWorkspacePreparation(
            bindings,
            db,
            threadId,
            "Starting workspace services…",
          );
          await markExecutionWorkspaceReady(db, threadId);
          await publishRealtimeInvalidation(
            bindings,
            threadId,
            "readiness.invalidated",
          );
        }
        kickDaemonActivation(bindings, threadId, activeSubmissionId(id));
        const factory: SandboxFactory = {
          createSandbox: () => handle.sandbox(sourceCwd),
          tools: executionWorkspaceTools,
        };
        const environmentFactory = context.profile.capabilities.includes(
          "environment-variables",
        )
          ? withExecutionEnvironment(factory, (activeThreadId) =>
              Effect.runPromise(
                resolveExecutionEnvironment(bindings, activeThreadId),
              ),
            )
          : factory;
        const changesInput = {
          db,
          threadId,
          residentRefresh: residentRefreshFor(bindings, threadId),
          onInitialSyncSettled: () => {
            void recordActiveSubmissionPhase(bindings, id, "changes_synced");
          },
        };
        const changesFactory =
          bindings.DX_STORAGE === undefined ||
          sourceCwd !== SOURCE_WORKSPACE_CWD
            ? environmentFactory
            : source === undefined
              ? withThreadChanges(environmentFactory, {
                  ...changesInput,
                  bucket: bindings.DX_STORAGE,
                })
              : // The development runtime keeps scratch Threads out of Changes.
                await withThreadChangesIfSourced(environmentFactory, {
                  ...changesInput,
                  bucket: bindings.DX_STORAGE,
                });
        const flueSandbox = await withCommandActivity(
          withSourceRuntimeAdmission(changesFactory, bindings, db, source),
          () => handleActivity(threadId, handle),
          handle.commandTimeoutMs,
          authorize,
        ).createSandbox({ id });
        const snapshotWorkspaceContext = flueSandbox.snapshotWorkspaceContext;
        if (snapshotWorkspaceContext === undefined) return flueSandbox;
        return {
          ...flueSandbox,
          async snapshotWorkspaceContext(root: string) {
            const snapshot = await snapshotWorkspaceContext(root);
            if (!("kind" in snapshot))
              void recordActiveSubmissionPhase(
                bindings,
                id,
                "context_discovered",
                { operationCount: 1 },
              );
            return snapshot;
          },
        };
      } catch (cause) {
        if (needsFirstReadiness)
          await reportWorkspacePreparation(bindings, db, threadId, null);
        else if (wakeStatusPublished)
          await publishRealtimeWorkspaceStatus(bindings, threadId, "ready");
        throw cause;
      }
    };

    const ensureDaemon = async (
      context: ExecutionContext,
      input: EnsureDaemonInput,
    ): Promise<DaemonInstallation> => {
      const residentDaemon = provider.residentDaemon;
      if (residentDaemon === undefined)
        throw new Error("The Execution provider hosts no resident daemon.");
      const bindings = env as Bindings;
      const startedAt = Date.now();
      const timing: Record<string, number> = {};
      let markedAt = startedAt;
      const mark = (name: string) => {
        const now = Date.now();
        timing[`${name}Ms`] = now - markedAt;
        markedAt = now;
      };
      const logTiming = (
        outcome: "registered" | "bootstrapped",
        guest?: string,
      ) =>
        threadDaemonLogger.info("Thread daemon installation timing.", {
          event: "thread_daemon_installation_timing",
          threadId: input.threadId,
          outcome,
          ...(guest === undefined ? {} : { guest }),
          totalMs: Date.now() - startedAt,
          ...timing,
        });
      const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
      await assertThreadActive(db, input.threadId);
      mark("prepare");
      let stage: DaemonInstallationStage = "workspace";
      try {
        throwIfAborted(input.signal);
        const handle = await atDaemonInstallationStage(
          "workspace",
          provider.workspace.connect(
            context,
            { threadId: input.threadId },
            { authorize: () => assertThreadActive(db, input.threadId) },
          ),
        );
        throwIfAborted(input.signal);
        mark("workspace");
        const processes =
          handle.processesStartedAt === undefined
            ? {}
            : { processesStartedAt: handle.processesStartedAt };
        // The connect moved the provider's deadline to its connect timeout; a
        // wake runs no guest command that would publish the inactivity
        // deadline again, so an idle workspace would otherwise stay up that
        // long.
        handleActivity(input.threadId, handle).deadlineReplaced();
        // A paused guest's daemon sees the clock step on resume and
        // re-registers within one round trip. A daemon that registers proves
        // this immutable workspace was already bootstrapped (and its source
        // verified), so a wake runs no guest command at all. A key minted
        // for this activation cannot be in any guest yet: skip the wait.
        const registered =
          input.credential === undefined &&
          (await input.awaitRegistration(DAEMON_SELF_REGISTRATION_WAIT_MS));
        mark("registrationWait");
        if (registered) {
          logTiming("registered");
          return { bootstrapped: false, ...processes };
        }
        throwIfAborted(input.signal);
        // A bootstrap prepares source and installs dxd on the raw guest; hold
        // the activity lease so that work cannot outlast the connect timeout.
        const preparation = handleActivity(input.threadId, handle).retain();
        let outcome: DaemonInstallOutcome;
        try {
          stage = "source";
          const source = await handle.development?.source();
          await activateSourceWorkspace(
            bindings,
            db,
            input.threadId,
            handle.guest,
            false,
            source,
          );
          throwIfAborted(input.signal);
          mark("source");
          if (source === undefined) {
            await ensureGithubCliWrapper(db, input.threadId, handle.guest);
            mark("githubCli");
          }
          throwIfAborted(input.signal);
          stage = "guest";
          outcome = await residentDaemon.install(context, handle, {
            threadId: input.threadId,
            endpoint: input.endpoint,
            credential: input.credential,
            mintCredential: input.mintCredential,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
        } finally {
          preparation.release();
        }
        mark("install");
        logTiming("bootstrapped", outcome.guest);
        return {
          ...(outcome.releaseLoadedAt === undefined
            ? {}
            : { releaseLoadedAt: outcome.releaseLoadedAt }),
          installedAt: Date.now(),
          bootstrapped: true,
          ...processes,
        };
      } catch (cause) {
        const failureStage =
          cause instanceof DaemonInstallationStageError ? cause.stage : stage;
        threadDaemonLogger.error("Thread daemon installation failed.", {
          event: "thread_daemon_installation",
          threadId: input.threadId,
          stage: failureStage,
        });
        throw cause instanceof DaemonInstallationStageError
          ? cause.failure
          : cause;
      }
    };

    const initializeResidentActivity = async (
      loadContext: () => Promise<ExecutionContext>,
      threadId: ThreadId,
    ) => {
      const bindings = env as Bindings;
      const context = await loadContext();
      const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
      await assertThreadActive(db, threadId);
      const handle = await provider.workspace.connect(
        context,
        { threadId },
        { authorize: () => assertThreadActive(db, threadId) },
      );
      handleActivity(threadId, handle);
    };

    const recordResidentTerminalInput = async (
      loadContext: () => Promise<ExecutionContext>,
      threadId: ThreadId,
    ) => {
      if (!activities.has(threadId)) {
        let initialization = residentActivityInitializations.get(threadId);
        if (initialization === undefined) {
          initialization = initializeResidentActivity(
            loadContext,
            threadId,
          ).finally(() => {
            residentActivityInitializations.delete(threadId);
          });
          residentActivityInitializations.set(threadId, initialization);
        }
        await initialization;
      }
      const activity = activities.get(threadId)?.activity;
      if (activity === undefined)
        throw new Error("Resident Terminal activity unavailable.");
      activity.recordTerminalInput();
    };

    return {
      activate: (context, request) => open(context, request, false),
      reconnect: (context, request) => open(context, request, true),
      ensureDaemon,
      recordResidentTerminalInput,
      recordResidentTerminalHeartbeat,
    };
  };

const recordResidentTerminalHeartbeat = (
  threadId: ThreadId,
  foregroundCommand: boolean | undefined,
) => {
  const entry = activities.get(threadId);
  if (entry === undefined) return;
  if (foregroundCommand === undefined) {
    entry.residentTerminal?.detach();
    entry.residentTerminal = undefined;
    return;
  }
  if (entry.residentTerminal === undefined) {
    const residentTerminal = {
      foregroundCommand,
      detach: () => {},
    };
    residentTerminal.detach = entry.activity.attachTerminal(
      async () => residentTerminal.foregroundCommand,
    );
    entry.residentTerminal = residentTerminal;
  } else entry.residentTerminal.foregroundCommand = foregroundCommand;
};
