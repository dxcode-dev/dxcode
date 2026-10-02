import { env } from "cloudflare:workers";
import {
  type E2BRunnerProfileConfiguration,
  type LocalRunnerProfileConfiguration,
  SourceControlProviderFailure,
  SourceWorkspaceRepository,
  ThreadId,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import type { Sandbox, SandboxFactory } from "@flue/runtime";
import { Effect, Layer, Redacted, Schema } from "effect";
import type { Bindings } from "../http/types.js";
import { executionWorkspaceLogger, threadDaemonLogger } from "../logging.js";
import {
  activeSubmissionId,
  recordActiveSubmissionPhase,
} from "../observability/startup-runtime.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import {
  publishRealtimeInvalidation,
  publishRealtimeWorkspaceStatus,
} from "../realtime/publication.js";
import { selectWorkspaceRuntime } from "../runtime/workspace-composition.js";
import { SettingsAudit } from "../settings/audit.js";
import { resolveExecutionEnvironment } from "../settings/environment-variables/execution.js";
import { withExecutionEnvironment } from "../settings/environment-variables/sandbox.js";
import { SettingsService } from "../settings/service.js";
import {
  recordRunnerUsage,
  runnerResourceAttribution,
} from "../settings/usage/recorder.js";
import { WorkspaceRepositoryD1 } from "../settings/workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../settings/workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../settings/workspace-policy/service.js";
import { SourceAuditD1 } from "../source-control/audit.js";
import { bitbucketRuntimeBroker } from "../source-control/bitbucket/runtime.js";
import { loadSourceWorkspaceConfiguration } from "../source-control/configuration.js";
import {
  GITHUB_CLI_WRAPPER_INSTALL_COMMAND,
  githubCliWrapper,
} from "../source-control/github/cli-wrapper.js";
import { GitHubRuntimeAdapterLive } from "../source-control/github/runtime-adapter.js";
import {
  SourceAuthorizationPolicyLive,
  SourceRuntimeBroker,
  SourceRuntimeBrokerLive,
  type SourceRuntimeBrokerShape,
} from "../source-control/runtime.js";
import { SourceAuthorityRepositoryD1 } from "../source-control/runtime-authority.js";
import {
  SOURCE_WORKSPACE_CWD,
  type SourceWorkspaceAssetVerification,
  type SourceWorkspacePreparationPhase,
  SourceWorkspaceService,
  SourceWorkspaceServiceWithBroker,
} from "../source-control/source-workspace.js";
import { SourceWorkspaceRepositoryD1 } from "../source-control/source-workspace-repository-d1.js";
import {
  createSourceWorkspaceProgram,
  type SourceWorkspaceProgramConfiguration,
} from "../source-control/workspace-assets.js";
import { makeThreadChangesCoordinator } from "../thread-changes/coordinator.js";
import { makeThreadChangesRepository } from "../thread-changes/repository-d1.js";
import {
  drainThreadDaemon,
  queueThreadChangesRefresh,
  startThreadDaemonActivation,
} from "../threads/daemon-client.js";
import { createWorkspaceActivity, type WorkspaceActivity } from "./activity.js";
import { dxSandboxTools, e2b } from "./e2b/adapter.js";
import {
  type DaemonGuestOutcome,
  ensureDaemonInGuest,
} from "./e2b/daemon-installer.js";
import {
  loadDaemonRelease,
  loadDaemonReleaseMetadata,
} from "./e2b/daemon-release.js";
import { loadE2BRequirements } from "./e2b/requirements.js";
import {
  connectExistingExecutionWorkspace,
  type ExecutionWorkspaceResidency,
  type ExecutionWorkspaceResolution,
  makeD1ExecutionWorkspaceCoordinator,
  makeD1ExecutionWorkspaceStateStore,
  pauseExecutionWorkspace,
  resolveExecutionWorkspace,
} from "./e2b/resolver.js";
import { withSourceCommandAdmission } from "./e2b/source-command-admission.js";
import { localSandboxFactory, requestLocalRuntime } from "./local/adapter.js";
import { resolveExecutionRunnerProfile } from "./runner-profiles/execution.js";
import { workspacePreparationFor } from "./workspace-preparation.js";
import {
  markExecutionWorkspaceReady,
  readExecutionWorkspaceReadiness,
  setExecutionWorkspacePreparationStatus,
} from "./workspace-readiness.js";

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
export interface DaemonCredential {
  readonly id: string;
  readonly key: Redacted.Redacted<string>;
}

interface EnsureDaemonInput {
  readonly threadId: ThreadId;
  readonly endpoint: string;
  readonly signal?: AbortSignal;
  /** A key minted for this activation, present only when none existed. */
  readonly credential?: DaemonCredential;
  /** Mint a key when the guest lost its configuration. */
  readonly mintCredential: () => Promise<DaemonCredential>;
  /**
   * Wait for the resident daemon to register on its own before any guest
   * command touches the installation. Returns true when it did.
   */
  readonly awaitRegistration: (timeoutMs: number) => Promise<boolean>;
}

interface DaemonInstallation {
  readonly releaseLoadedAt?: number;
  readonly installedAt?: number;
  /** Set when the guest was bootstrapped or reconfigured. */
  readonly bootstrapped: boolean;
}

const abortError = () => new Error("Daemon activation aborted.");

const throwIfAborted = (signal: AbortSignal | undefined) => {
  if (signal?.aborted) throw abortError();
};

const assertThreadLifecycleState = async (
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

const assertThreadActive = (db: D1Database, threadId: string) =>
  assertThreadLifecycleState(db, threadId, "active");

const prepareE2BRunner = async (
  bindings: Bindings,
  id: string,
  profile: E2BRunnerProfileConfiguration,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requirements = yield* loadE2BRequirements(
        bindings,
        profile.template,
      );
      const db = yield* decodeD1Binding(bindings.DB);
      yield* Effect.promise(() => assertThreadActive(db, id));
      return { db, profile, requirements };
    }),
  );

const observeE2BResolution =
  (
    bindings: Bindings,
    id: string,
    profile: E2BRunnerProfileConfiguration,
    requirements: {
      readonly template: string;
      readonly timeoutMs: number;
    },
  ) =>
  (observation: ExecutionWorkspaceResolution) =>
    recordRunnerUsage(bindings, {
      id: `e2b:${id}:${crypto.randomUUID()}`,
      kind: "runner",
      threadId: id,
      occurredAt: new Date().toISOString(),
      outcome: observation.outcome === "success" ? "success" : "error",
      durationMs: observation.durationMs,
      provider: "e2b",
      decision: observation.decision,
      runnerId: null,
      template: requirements.template,
      activeTimeoutMs: requirements.timeoutMs,
      resources: runnerResourceAttribution(
        profile,
        {
          ...(observation.cpuCores === null
            ? {}
            : { cpuCores: observation.cpuCores }),
          ...(observation.memoryMb === null
            ? {}
            : { memoryMb: observation.memoryMb }),
        },
        1,
      ),
    });

interface SourceWorkspaceLayerOptions {
  readonly broker?: SourceRuntimeBrokerShape;
  readonly program?: string;
  readonly verifyAssets?: SourceWorkspaceAssetVerification;
}

export const sourceWorkspaceLayer = (
  bindings: Bindings,
  db: D1Database,
  options?: SourceWorkspaceLayerOptions,
) => {
  const d1 = D1Client.layer({ db });
  const workspaces = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const settings = SettingsService.layer.pipe(Layer.provide(workspaces));
  const workspacePolicy = WorkspacePolicyService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workspaces,
        settings,
        WorkspacePolicyRepositoryD1(db),
        SettingsAudit.layer,
      ),
    ),
  );
  const authorizationPolicy = SourceAuthorizationPolicyLive.pipe(
    Layer.provide(workspacePolicy),
  );
  const githubBroker =
    options?.broker === undefined
      ? SourceRuntimeBrokerLive().pipe(
          Layer.provide(
            Layer.mergeAll(
              SourceAuthorityRepositoryD1(db),
              authorizationPolicy,
              GitHubRuntimeAdapterLive({ bindings }),
              SourceAuditD1(db),
            ),
          ),
          Layer.catchTag("ConfigError", () =>
            Layer.effect(
              SourceRuntimeBroker,
              Effect.fail(
                new SourceControlProviderFailure({
                  provider: "github",
                  retryable: false,
                }),
              ),
            ),
          ),
          Layer.catchTag("GitHubAppConfigurationInvalid", () =>
            Layer.effect(
              SourceRuntimeBroker,
              Effect.fail(
                new SourceControlProviderFailure({
                  provider: "github",
                  retryable: false,
                }),
              ),
            ),
          ),
        )
      : Layer.succeed(SourceRuntimeBroker, options.broker);
  const broker =
    options?.broker === undefined
      ? Layer.succeed(
          SourceRuntimeBroker,
          SourceRuntimeBroker.of({
            withCommandEnvironment: (
              threadId,
              actorUserId,
              request,
              callback,
              targetRepositoryId,
            ) =>
              Effect.gen(function* () {
                const source = yield* Effect.tryPromise({
                  try: () =>
                    db
                      .prepare(
                        "SELECT provider FROM thread_source_snapshot WHERE thread_id = ?",
                      )
                      .bind(threadId)
                      .first<{ provider: string }>(),
                  catch: () =>
                    new SourceControlProviderFailure({
                      provider: "bitbucket",
                      retryable: true,
                    }),
                });
                if (source?.provider === "bitbucket")
                  return yield* bitbucketRuntimeBroker(
                    db,
                    bindings,
                  ).withCommandEnvironment(
                    threadId,
                    actorUserId,
                    request,
                    callback,
                    targetRepositoryId,
                  );
                return yield* Effect.gen(function* () {
                  return yield* (yield* SourceRuntimeBroker).withCommandEnvironment(
                    threadId,
                    actorUserId,
                    request,
                    callback,
                    targetRepositoryId,
                  );
                }).pipe(Effect.provide(githubBroker));
              }),
          }),
        )
      : githubBroker;
  const deferredBroker = SourceRuntimeBroker.of({
    withCommandEnvironment: (
      threadId,
      actorUserId,
      request,
      callback,
      targetProviderRepositoryId,
    ) =>
      Effect.gen(function* () {
        return yield* (yield* SourceRuntimeBroker).withCommandEnvironment(
          threadId,
          actorUserId,
          request,
          callback,
          targetProviderRepositoryId,
        );
      }).pipe(Effect.provide(broker)),
  });
  const repository = SourceWorkspaceRepositoryD1(db);
  const configuration = loadSourceWorkspaceConfiguration(bindings);
  const workspace = SourceWorkspaceServiceWithBroker(
    deferredBroker,
    options?.program,
    options?.verifyAssets,
    configuration.shallowClone,
  ).pipe(Layer.provide(SourceWorkspaceRepositoryD1(db)));
  return {
    activation: Layer.mergeAll(workspace, repository),
    runtime: Layer.mergeAll(workspace, broker, repository),
  };
};

const activateSourceWorkspace = (
  bindings: Bindings,
  db: D1Database,
  threadId: string,
  sandbox: Parameters<typeof workspacePreparationFor>[0],
  runThreadHooks = true,
  options?: SourceWorkspaceLayerOptions,
  onPreparationPhase?: (
    phase: SourceWorkspacePreparationPhase,
  ) => Effect.Effect<void>,
  runResume = true,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* SourceWorkspaceService;
      const preparation = workspacePreparationFor(sandbox);
      return yield* runThreadHooks
        ? service.activate(threadId, preparation, onPreparationPhase, {
            runResume,
          })
        : service.prepare(threadId, preparation);
    }).pipe(
      Effect.provide(sourceWorkspaceLayer(bindings, db, options).activation),
    ),
  );

/**
 * Installs the dx `gh` wrapper when the Thread owner has connected GitHub,
 * whatever the Thread's source. It runs on every agent activation and on a
 * daemon bootstrap, never on a resident wake (the wrapper is already in that
 * immutable workspace), and never blocks activation: without it `gh` is
 * merely unauthenticated.
 */
const ensureGithubCliWrapper = async (
  db: D1Database,
  threadId: string,
  sandbox: {
    readonly commands: {
      readonly run: (
        command: string,
        options: {
          readonly envs: Record<string, string>;
          readonly timeoutMs: number;
        },
      ) => Promise<{ readonly exitCode?: number }>;
    };
  },
) => {
  try {
    const connected = await db
      .prepare(
        `SELECT 1 AS connected
           FROM threads t
           JOIN github_user_authorization a ON a.user_id = t.owner_user_id
          WHERE t.id = ? AND a.status = 'active'
            AND a.access_token_reference_id IS NOT NULL
          LIMIT 1`,
      )
      .bind(threadId)
      .first<{ connected: number }>();
    if (connected === null) return;
    const result = await sandbox.commands.run(
      GITHUB_CLI_WRAPPER_INSTALL_COMMAND,
      {
        envs: { DX_GH_WRAPPER: githubCliWrapper() },
        timeoutMs: 10_000,
      },
    );
    if ((result.exitCode ?? 0) !== 0)
      throw new Error("GitHub CLI wrapper installation failed.");
  } catch (error) {
    executionWorkspaceLogger.warn("GitHub CLI wrapper installation failed.", {
      event: "github_cli_wrapper",
      threadId,
      error: (error instanceof Error ? error.message : String(error)).slice(
        0,
        1_000,
      ),
    });
  }
};

const localSourceRuntimeBroker = SourceRuntimeBroker.of({
  withCommandEnvironment: () =>
    Effect.fail(
      new SourceControlProviderFailure({
        provider: "github",
        retryable: false,
      }),
    ),
});

const localSourceWorkspaceOptions = async (
  bindings: Bindings,
  threadId: string,
): Promise<SourceWorkspaceLayerOptions> => ({
  broker: localSourceRuntimeBroker,
  verifyAssets: () => Effect.succeed({ assets: "stale" }),
  program: createSourceWorkspaceProgram(
    await requestLocalRuntime<SourceWorkspaceProgramConfiguration>(
      bindings,
      threadId,
      "source",
      {},
    ),
  ),
});

const e2bSandboxFactory = {
  async createSandbox(
    { id }: SandboxRequest,
    profile: E2BRunnerProfileConfiguration,
    existingOnly = false,
  ): Promise<FlueSandbox> {
    const bindings = env as Bindings;
    const prepared = await prepareE2BRunner(bindings, id, profile);
    const threadId = Schema.decodeUnknownSync(ThreadId)(id);
    const needsFirstReadiness = !existingOnly
      ? await readExecutionWorkspaceReadiness(prepared.db, threadId)
          .then((readiness) => !readiness.ready)
          .catch(() => true)
      : false;
    if (needsFirstReadiness)
      await reportWorkspacePreparation(
        bindings,
        prepared.db,
        threadId,
        "Preparing workspace…",
      );
    let wakeStatusPublished = false;
    try {
      const stateStore = makeD1ExecutionWorkspaceStateStore(prepared.db);
      const resolve = existingOnly
        ? connectExistingExecutionWorkspace
        : resolveExecutionWorkspace;
      const residency: { value: ExecutionWorkspaceResidency } = {
        value: "unknown",
      };
      const sandbox = await Effect.runPromise(
        resolve({
          id,
          requirements: prepared.requirements,
          stateStore,
          coordination: makeD1ExecutionWorkspaceCoordinator(prepared.db),
          authorizeResolution: () => assertThreadActive(prepared.db, id),
          observeResolution: observeE2BResolution(
            bindings,
            id,
            prepared.profile,
            prepared.requirements,
          ),
          observeResidency: existingOnly
            ? undefined
            : async (observedResidency) => {
                residency.value = observedResidency;
                if (observedResidency === "paused" && !needsFirstReadiness) {
                  wakeStatusPublished = true;
                  await publishRealtimeWorkspaceStatus(
                    bindings,
                    threadId,
                    "waking",
                  );
                }
              },
        }),
      );
      void recordActiveSubmissionPhase(bindings, id, "workspace_resolved");
      if (needsFirstReadiness)
        await reportWorkspacePreparation(
          bindings,
          prepared.db,
          threadId,
          "Preparing source…",
        );
      // Source preparation runs on the raw sandbox, outside the agent's
      // command leases, and its setup and resume hooks can outlast the E2B
      // timeout that create/connect just set. Hold the Thread's activity
      // lease so the inactivity deadline keeps renewing until it ends.
      const preparation = activityFor(
        threadId,
        (durationMs) => sandbox.setTimeout(durationMs),
        prepared.requirements.inactivityMs,
      ).retain();
      let sourceCwd: string;
      try {
        sourceCwd = await activateSourceWorkspace(
          bindings,
          prepared.db,
          id,
          sandbox,
          true,
          undefined,
          needsFirstReadiness
            ? undefined
            : sourcePreparationReporter(bindings, prepared.db, threadId),
          residency.value !== "running" || needsFirstReadiness,
        );
        await ensureGithubCliWrapper(prepared.db, id, sandbox);
      } finally {
        preparation.release();
      }
      void recordActiveSubmissionPhase(bindings, id, "source_activated");
      if (wakeStatusPublished)
        await publishRealtimeWorkspaceStatus(bindings, threadId, "ready");
      if (needsFirstReadiness) {
        await reportWorkspacePreparation(
          bindings,
          prepared.db,
          threadId,
          "Starting workspace services…",
        );
        await markExecutionWorkspaceReady(prepared.db, threadId);
        await publishRealtimeInvalidation(
          bindings,
          threadId,
          "readiness.invalidated",
        );
      }
      kickDaemonActivation(bindings, threadId, activeSubmissionId(id));
      const runtimeLayer = sourceWorkspaceLayer(bindings, prepared.db).runtime;
      const factory = e2b(sandbox, sourceCwd);
      const environmentFactory = prepared.profile.capabilities.includes(
        "environment-variables",
      )
        ? withExecutionEnvironment(factory, (threadId) =>
            Effect.runPromise(resolveExecutionEnvironment(bindings, threadId)),
          )
        : factory;
      const changesFactory =
        sourceCwd === SOURCE_WORKSPACE_CWD && bindings.DX_STORAGE !== undefined
          ? withThreadChanges(environmentFactory, {
              db: prepared.db,
              bucket: bindings.DX_STORAGE,
              threadId,
              residentRefresh: residentRefreshFor(bindings, threadId),
              onInitialSyncSettled: () => {
                void recordActiveSubmissionPhase(
                  bindings,
                  id,
                  "changes_synced",
                );
              },
            })
          : environmentFactory;
      const flueSandbox = await withCommandActivity(
        withSourceCommandAdmission(
          changesFactory,
          (threadId) =>
            Effect.runPromise(
              Effect.gen(function* () {
                const decoded =
                  yield* Schema.decodeUnknownEffect(ThreadId)(threadId);
                return yield* (yield* SourceWorkspaceRepository).findByThreadId(
                  decoded,
                );
              }).pipe(Effect.provide(runtimeLayer)),
            ),
          (threadId, source, request, callback) =>
            Effect.runPromise(
              Effect.gen(function* () {
                return yield* (yield* SourceRuntimeBroker).withCommandEnvironment(
                  threadId,
                  source.actorUserId,
                  request,
                  (environment) => Effect.promise(() => callback(environment)),
                );
              }).pipe(Effect.provide(runtimeLayer)),
            ),
        ),
        () =>
          activityFor(
            threadId,
            (durationMs) => sandbox.setTimeout(durationMs),
            prepared.requirements.inactivityMs,
          ),
        prepared.requirements.timeoutMs,
        () => assertThreadActive(prepared.db, id),
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
        await reportWorkspacePreparation(bindings, prepared.db, threadId, null);
      else if (wakeStatusPublished)
        await publishRealtimeWorkspaceStatus(bindings, threadId, "ready");
      throw cause;
    }
  },
};

const e2bExistingSandboxFactory = {
  createSandbox(
    request: SandboxRequest,
    profile: E2BRunnerProfileConfiguration,
  ): Promise<FlueSandbox> {
    return e2bSandboxFactory.createSandbox(request, profile, true);
  },
};

const localPreparationTarget = (sandbox: Sandbox) => ({
  commands: {
    run: (
      command: string,
      options?: {
        readonly cwd?: string;
        readonly envs?: Record<string, string>;
        readonly timeoutMs?: number;
      },
    ) =>
      sandbox.exec(command, {
        cwd: options?.cwd,
        env: options?.envs,
        timeoutMs: options?.timeoutMs,
      }),
  },
  files: {
    write: (path: string, content: string) => sandbox.writeFile(path, content),
  },
});

const makeLocalSandboxFactory = (existingOnly: boolean): SandboxFactory => ({
  async createSandbox({ id }) {
    const bindings = env as Bindings;
    const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
    await assertThreadActive(db, id);
    const threadId = Schema.decodeUnknownSync(ThreadId)(id);
    if (!existingOnly)
      await reportWorkspacePreparation(
        bindings,
        db,
        threadId,
        "Preparing workspace…",
      );
    let primitive: Sandbox;
    let sourceOptions: SourceWorkspaceLayerOptions;
    try {
      primitive = await localSandboxFactory(
        bindings,
        existingOnly,
      ).createSandbox({ id });
      sourceOptions = await localSourceWorkspaceOptions(bindings, id);
      if (!existingOnly)
        await reportWorkspacePreparation(
          bindings,
          db,
          threadId,
          "Preparing source…",
        );
      await activateSourceWorkspace(
        bindings,
        db,
        id,
        localPreparationTarget(primitive),
        true,
        sourceOptions,
        existingOnly
          ? undefined
          : sourcePreparationReporter(bindings, db, threadId),
      );
      void recordActiveSubmissionPhase(bindings, id, "source_activated");
      if (!existingOnly) {
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
    } catch (cause) {
      if (!existingOnly)
        await reportWorkspacePreparation(bindings, db, threadId, null);
      throw cause;
    }
    const runtimeLayer = sourceWorkspaceLayer(
      bindings,
      db,
      sourceOptions,
    ).runtime;
    const environmentFactory = withExecutionEnvironment(
      { createSandbox: async () => primitive, tools: dxSandboxTools },
      (activeThreadId) =>
        Effect.runPromise(
          resolveExecutionEnvironment(bindings, activeThreadId),
        ),
    );
    const changesFactory =
      bindings.DX_STORAGE === undefined
        ? environmentFactory
        : await withThreadChangesIfSourced(environmentFactory, {
            db,
            bucket: bindings.DX_STORAGE,
            threadId,
            residentRefresh: residentRefreshFor(bindings, threadId),
            onInitialSyncSettled: () => {
              void recordActiveSubmissionPhase(bindings, id, "changes_synced");
            },
          });
    return withCommandActivity(
      withSourceCommandAdmission(
        changesFactory,
        (activeThreadId) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const decoded =
                yield* Schema.decodeUnknownEffect(ThreadId)(activeThreadId);
              return yield* (yield* SourceWorkspaceRepository).findByThreadId(
                decoded,
              );
            }).pipe(Effect.provide(runtimeLayer)),
          ),
        (activeThreadId, source, request, callback) =>
          Effect.runPromise(
            Effect.gen(function* () {
              return yield* (yield* SourceRuntimeBroker).withCommandEnvironment(
                activeThreadId,
                source.actorUserId,
                request,
                (environment) => Effect.promise(() => callback(environment)),
              );
            }).pipe(Effect.provide(runtimeLayer)),
          ),
      ),
      () => activityFor(threadId, async () => undefined),
      120_000,
      () => assertThreadActive(db, id),
    ).createSandbox({ id });
  },
  tools: dxSandboxTools,
});

const localAgentSandboxFactory = makeLocalSandboxFactory(false);
const localExistingSandboxFactory = makeLocalSandboxFactory(true);

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

const atDaemonInstallationStage = async <Value>(
  stage: DaemonInstallationStage,
  operation: Promise<Value>,
): Promise<Value> => {
  try {
    return await operation;
  } catch (cause) {
    throw new DaemonInstallationStageError(stage, cause);
  }
};

const ensureE2BDaemon = async (
  input: EnsureDaemonInput,
  profile: E2BRunnerProfileConfiguration,
): Promise<DaemonInstallation> => {
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
    guest?: DaemonGuestOutcome,
  ) =>
    threadDaemonLogger.info("Thread daemon installation timing.", {
      event: "thread_daemon_installation_timing",
      threadId: input.threadId,
      outcome,
      ...(guest === undefined ? {} : { guest }),
      totalMs: Date.now() - startedAt,
      ...timing,
    });
  const prepared = await prepareE2BRunner(bindings, input.threadId, profile);
  mark("prepare");
  let stage: DaemonInstallationStage = "workspace";
  try {
    throwIfAborted(input.signal);
    const [release, sandbox] = await Promise.all([
      atDaemonInstallationStage("release", loadDaemonReleaseMetadata(bindings)),
      atDaemonInstallationStage(
        "workspace",
        Effect.runPromise(
          connectExistingExecutionWorkspace({
            id: input.threadId,
            requirements: prepared.requirements,
            stateStore: makeD1ExecutionWorkspaceStateStore(prepared.db),
            coordination: makeD1ExecutionWorkspaceCoordinator(prepared.db),
            authorizeResolution: () =>
              assertThreadActive(prepared.db, input.threadId),
            observeResolution: observeE2BResolution(
              bindings,
              input.threadId,
              prepared.profile,
              prepared.requirements,
            ),
          }),
        ),
      ),
    ]);
    throwIfAborted(input.signal);
    mark("workspace");
    // The connect above set the sandbox's timeout to the connect timeout; a
    // wake runs no guest command that would publish the inactivity deadline
    // again, so an idle workspace would otherwise stay up for that timeout.
    const activity = () =>
      activityFor(
        input.threadId,
        (durationMs) => sandbox.setTimeout(durationMs),
        prepared.requirements.inactivityMs,
      );
    activity().deadlineReplaced();
    // The E2B resume above is what a paused guest was waiting for: its daemon
    // sees the clock step and re-registers within one round trip. A daemon
    // that registers proves this immutable workspace was already bootstrapped
    // (and its source verified), so a wake runs no guest command at all. A
    // key minted for this activation cannot be in any guest yet: skip the wait.
    const registered =
      input.credential === undefined &&
      (await input.awaitRegistration(DAEMON_SELF_REGISTRATION_WAIT_MS));
    mark("registrationWait");
    if (registered) {
      logTiming("registered");
      return { bootstrapped: false };
    }
    throwIfAborted(input.signal);
    // A bootstrap prepares source and installs dxd on the raw sandbox; hold
    // the activity lease so that work cannot outlast the connect timeout.
    const preparation = activity().retain();
    let releaseLoadedAt: number | undefined;
    let guest: DaemonGuestOutcome;
    try {
      stage = "source";
      await activateSourceWorkspace(
        bindings,
        prepared.db,
        input.threadId,
        sandbox,
        false,
      );
      throwIfAborted(input.signal);
      mark("source");
      await ensureGithubCliWrapper(prepared.db, input.threadId, sandbox);
      mark("githubCli");
      throwIfAborted(input.signal);
      stage = "guest";
      guest = await ensureDaemonInGuest(sandbox, {
        threadId: input.threadId,
        endpoint: input.endpoint,
        sha256: release.sha256,
        releaseUrl: release.url,
        credential: input.credential,
        mintCredential: input.mintCredential,
        loadBinary: async () => {
          stage = "release";
          const loaded = await loadDaemonRelease(bindings);
          releaseLoadedAt = Date.now();
          stage = "guest";
          return loaded.binary;
        },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } finally {
      preparation.release();
    }
    mark("install");
    logTiming("bootstrapped", guest);
    return {
      ...(releaseLoadedAt === undefined ? {} : { releaseLoadedAt }),
      installedAt: Date.now(),
      bootstrapped: true,
    };
  } catch (cause) {
    const failureStage =
      cause instanceof DaemonInstallationStageError ? cause.stage : stage;
    threadDaemonLogger.error("Thread daemon installation failed.", {
      event: "thread_daemon_installation",
      threadId: input.threadId,
      stage: failureStage,
    });
    throw cause instanceof DaemonInstallationStageError ? cause.failure : cause;
  }
};

interface ConfiguredRunnerAdapter {
  readonly sandboxFactory: typeof e2bSandboxFactory;
  readonly existingSandboxFactory: typeof e2bExistingSandboxFactory;
  readonly ensureDaemon: typeof ensureE2BDaemon;
}

const e2bRunnerAdapter = Object.freeze({
  sandboxFactory: e2bSandboxFactory,
  existingSandboxFactory: e2bExistingSandboxFactory,
  ensureDaemon: ensureE2BDaemon,
}) satisfies ConfiguredRunnerAdapter;

const configuredRunnerAdapter = (adapter: "e2b"): ConfiguredRunnerAdapter => {
  switch (adapter) {
    case "e2b":
      return e2bRunnerAdapter;
    default: {
      const exhaustive: never = adapter;
      return exhaustive;
    }
  }
};

const e2bProfile = (
  profile: E2BRunnerProfileConfiguration | LocalRunnerProfileConfiguration,
): E2BRunnerProfileConfiguration => {
  if (profile.adapter !== "e2b")
    throw new Error("Deployed execution requires an E2B runner profile.");
  return profile;
};

const sandboxFactory: SandboxFactory = {
  async createSandbox(request) {
    const profile = e2bProfile(
      await Effect.runPromise(
        resolveExecutionRunnerProfile(env as Bindings, request.id),
      ),
    );
    return configuredRunnerAdapter(
      profile.adapter,
    ).sandboxFactory.createSandbox(request, profile);
  },
  tools: dxSandboxTools,
};

const existingSandboxFactory: SandboxFactory = {
  async createSandbox(request) {
    const profile = e2bProfile(
      await Effect.runPromise(
        resolveExecutionRunnerProfile(env as Bindings, request.id),
      ),
    );
    return configuredRunnerAdapter(
      profile.adapter,
    ).existingSandboxFactory.createSandbox(request, profile);
  },
  tools: dxSandboxTools,
};

const pause = async (threadId: ThreadId) => {
  const bindings = env as Bindings;
  await drainThreadDaemon(bindings, threadId, "thread-archived");
  const requirements = await Effect.runPromise(loadE2BRequirements(bindings));
  const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
  await Effect.runPromise(
    pauseExecutionWorkspace({
      id: threadId,
      requirements,
      stateStore: makeD1ExecutionWorkspaceStateStore(db),
      coordination: makeD1ExecutionWorkspaceCoordinator(db),
      authorizePause: () =>
        assertThreadLifecycleState(db, threadId, "archived"),
    }),
  );
};

const ensureDaemon = async (input: EnsureDaemonInput) => {
  const bindings = env as Bindings;
  const profile = e2bProfile(
    await Effect.runPromise(
      resolveExecutionRunnerProfile(bindings, input.threadId),
    ),
  );
  return configuredRunnerAdapter(profile.adapter).ensureDaemon(input, profile);
};

const initializeResidentActivity = async (threadId: ThreadId) => {
  const bindings = env as Bindings;
  const profile = e2bProfile(
    await Effect.runPromise(resolveExecutionRunnerProfile(bindings, threadId)),
  );
  const prepared = await prepareE2BRunner(bindings, threadId, profile);
  const sandbox = await Effect.runPromise(
    connectExistingExecutionWorkspace({
      id: threadId,
      requirements: prepared.requirements,
      stateStore: makeD1ExecutionWorkspaceStateStore(prepared.db),
      coordination: makeD1ExecutionWorkspaceCoordinator(prepared.db),
      authorizeResolution: () => assertThreadActive(prepared.db, threadId),
      observeResolution: observeE2BResolution(
        bindings,
        threadId,
        prepared.profile,
        prepared.requirements,
      ),
    }),
  );
  activityFor(
    threadId,
    (durationMs) => sandbox.setTimeout(durationMs),
    prepared.requirements.inactivityMs,
  );
};

const recordResidentTerminalInput = async (threadId: ThreadId) => {
  if (!activities.has(threadId)) {
    let initialization = residentActivityInitializations.get(threadId);
    if (initialization === undefined) {
      initialization = initializeResidentActivity(threadId).finally(() => {
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

const deployedExecutionWorkspaces = Object.freeze({
  sandboxFactory,
  existingSandboxFactory,
  sourceWorkspaceOptions: async (
    _bindings: Bindings,
    _threadId: string,
  ): Promise<SourceWorkspaceLayerOptions | undefined> => undefined,
  pause,
  ensureDaemon,
  recordResidentTerminalInput,
  recordResidentTerminalHeartbeat,
});

const localPause = async (threadId: ThreadId) => {
  const bindings = env as Bindings;
  await drainThreadDaemon(bindings, threadId, "thread-archived");
  await requestLocalRuntime(bindings, threadId, "pause", {
    existingOnly: true,
  });
};

const ensureLocalDaemon = async (
  input: EnsureDaemonInput,
): Promise<DaemonInstallation> => {
  const bindings = env as Bindings;
  const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
  await assertThreadActive(db, input.threadId);
  const sandbox = await localSandboxFactory(bindings, true).createSandbox({
    id: input.threadId,
  });
  if (
    input.credential === undefined &&
    (await input.awaitRegistration(DAEMON_SELF_REGISTRATION_WAIT_MS))
  )
    return { bootstrapped: false };
  throwIfAborted(input.signal);
  const sourceOptions = await localSourceWorkspaceOptions(
    bindings,
    input.threadId,
  );
  await activateSourceWorkspace(
    bindings,
    db,
    input.threadId,
    localPreparationTarget(sandbox),
    false,
    sourceOptions,
  );
  throwIfAborted(input.signal);
  const request = (credential: DaemonCredential | undefined) =>
    requestLocalRuntime<{ readonly status: "running" | "credential-required" }>(
      bindings,
      input.threadId,
      "daemon",
      {
        existingOnly: true,
        endpoint: input.endpoint,
        ...(credential === undefined
          ? {}
          : { apiKey: Redacted.value(credential.key) }),
      },
    );
  let result = await request(input.credential);
  if (result.status === "credential-required")
    result = await request(await input.mintCredential());
  if (result.status !== "running")
    throw new Error("Local daemon is unavailable.");
  return { bootstrapped: true, installedAt: Date.now() };
};

const ensureLocalActivity = async (threadId: ThreadId) => {
  if (activities.has(threadId)) return;
  const bindings = env as Bindings;
  await localSandboxFactory(bindings, true).createSandbox({ id: threadId });
  activityFor(threadId, async () => undefined);
};

const recordLocalTerminalInput = async (threadId: ThreadId) => {
  await ensureLocalActivity(threadId);
  activities.get(threadId)?.activity.recordTerminalInput();
};

const recordLocalTerminalHeartbeat = (
  threadId: ThreadId,
  foregroundCommand: boolean | undefined,
) => {
  recordResidentTerminalHeartbeat(threadId, foregroundCommand);
};

const localExecutionWorkspaces = Object.freeze({
  sandboxFactory: localAgentSandboxFactory,
  existingSandboxFactory: localExistingSandboxFactory,
  sourceWorkspaceOptions: localSourceWorkspaceOptions,
  pause: localPause,
  ensureDaemon: ensureLocalDaemon,
  recordResidentTerminalInput: recordLocalTerminalInput,
  recordResidentTerminalHeartbeat: recordLocalTerminalHeartbeat,
}) satisfies typeof deployedExecutionWorkspaces;

export const makeExecutionWorkspaces = (
  bindings: Bindings,
  runtimes: {
    readonly local: typeof deployedExecutionWorkspaces;
    readonly deployed: typeof deployedExecutionWorkspaces;
  } = {
    local: localExecutionWorkspaces,
    deployed: deployedExecutionWorkspaces,
  },
) => selectWorkspaceRuntime(bindings, runtimes);

export const ExecutionWorkspaces = makeExecutionWorkspaces(env as Bindings);
