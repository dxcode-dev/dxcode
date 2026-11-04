import { env, waitUntil } from "cloudflare:workers";
import { SourceControlAccessDenied, ThreadId } from "@dx/domain";
import { FlueError, type SandboxFactory } from "@flue/runtime";
import { Effect, Schema } from "effect";
import { RESERVED_SKILL_NAMES } from "../agents/built-in-skill-names.js";
import type { Bindings } from "../http/types.js";
import { executionWorkspaceLogger, threadDaemonLogger } from "../logging.js";
import {
  activeSubmissionId,
  recordActiveSubmissionPhase,
} from "../observability/startup-runtime.js";
import { stepTiming } from "../observability/step-timing.js";
import { observeCall, traceSpan } from "../observability/tracing.js";
import { rememberWorkspaceDisk } from "../orb-disk/note.js";
import {
  isWorkspaceReadOnlyFailure,
  rememberWorkspaceRecovery,
  savedAtText,
  WORKSPACE_READ_ONLY_CODE,
} from "../orb-disk/read-only.js";
import { takeOrbRestartNoteFor } from "../orb-restart/execution-object.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import type {
  DaemonInstallation,
  DaemonInstallOutcome,
  EnsureDaemonInput,
  ExecutionActivation,
  ExecutionActivationFactory,
  ExecutionContext,
  ExecutionGuest,
  ExecutionProvider,
  ExecutionRunAdmission,
  ExecutionWorkspaceCreateOptions,
  ExecutionWorkspaceHandle,
  ExecutionWorkspaceRecovery,
} from "../plugins/execution/provider.js";
import { executionWorkspaceTools } from "../plugins/execution/tools.js";
import {
  publishRealtimeInvalidation,
  publishRealtimeWorkspaceStatus,
} from "../realtime/publication.js";
import { resolveExecutionEnvironment } from "../settings/environment-variables/execution.js";
import { withExecutionEnvironment } from "../settings/environment-variables/sandbox.js";
import { authorizeRunStart } from "../source-control/admission.js";
import {
  SOURCE_WORKSPACE_CWD,
  type SourceWorkspacePreparationPhase,
} from "../source-control/source-workspace.js";
import {
  MUTATION_LEASE_MS,
  makeThreadChangesCoordinator,
} from "../thread-changes/coordinator.js";
import {
  makeThreadChangesRepository,
  type ThreadChangesMutationLease,
} from "../thread-changes/repository-d1.js";
import {
  queueThreadChangesRefresh,
  startThreadDaemonActivation,
} from "../threads/daemon-client.js";
import { createWorkspaceActivity, type WorkspaceActivity } from "./activity.js";
import type {
  CloudflareOpenPhase,
  CloudflareOpenPhaseReporter,
} from "./cloudflare/provider.js";
import { runWithCommandLease, takeCommandLease } from "./command-lease.js";
import {
  authorizeActiveThread,
  commandEnvironmentRevision,
} from "./command-preflight.js";
import { rememberDxFilesSandbox } from "./dx-files-sandbox.js";
import {
  noOrbBilling,
  type OrbBillingPolicy,
  withOrbBilling,
} from "./orb-billing.js";
import {
  rescueUnsavedWork,
  restoreUnsavedWork,
  type UnsavedWorkRescue,
} from "./read-only-rescue.js";
import {
  activateSourceWorkspace,
  cloneAdditionalRepositories,
  ensureGithubCliWrapper,
  githubCliConnected,
  installSourceWorkspaceAssets,
  readAdditionalRepositories,
  readSourceWorkspace,
  withSourceRuntimeAdmission,
} from "./source-preparation.js";
import { prepareWhileOrbAnswers } from "./unresponsive-orb.js";
import { withoutRepositorySkills } from "./workspace-context.js";
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
 * in; nothing here adds a provider call to the wake path, and the only D1
 * read beyond the lifecycle check is a connected source's live grant.
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

const openPreparationStatus = {
  "starting-machine": "Starting machine…",
  "waiting-for-machine": "Still starting machine…",
} satisfies Record<CloudflareOpenPhase, string>;

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

/**
 * One activation's status publications, off its critical path: each starts
 * after the previous one settles, so the browser sees them in order, and
 * each publisher logs its own failure.
 */
const statusPublications = () => {
  let last: Promise<unknown> = Promise.resolve();
  return (publish: () => Promise<void>) => {
    last = last.then(publish).catch(() => undefined);
  };
};

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

/**
 * Command authorization for a Thread whose commands Changes coordinates: a
 * command that can write files also takes its mutation lease in the same D1
 * batch, written only while the Thread is active (one round trip instead of
 * two). mkdir takes no lease, since directories never show in Changes.
 */
export const authorizeCommandWithChangesLease =
  (
    db: D1Database,
    threadId: ThreadId,
    /** The run's own admission, which every command also waits for. */
    admitted?: Promise<unknown>,
  ) =>
  async (kind: SandboxCommandKind) => {
    if (kind === "mkdir") {
      await Promise.all([authorizeActiveThread(db, threadId), admitted]);
      return undefined;
    }
    // A refused run takes no lease: its admission settles first (it started
    // with the run, so it has usually settled already).
    await admitted;
    const begin = makeThreadChangesRepository(db).beginMutationStatements(
      threadId,
      MUTATION_LEASE_MS,
      { whenActive: true },
    );
    return begin.lease(
      await authorizeActiveThread(db, threadId, begin.statements),
    );
  };

/** A sandbox command that authorization admits. */
export type SandboxCommandKind = "exec" | "writeFile" | "mkdir" | "rm";

export const withCommandActivity = (
  factory: SandboxFactory,
  activityForCommand: () => WorkspaceActivity,
  defaultTimeoutMs: number,
  /**
   * Refuses a command for an inactive Thread. It may also take the Changes
   * mutation lease the command will need, in the same round trip; the
   * command then runs with it (see `takeCommandLease`).
   */
  authorizeCommand: (
    kind: SandboxCommandKind,
  ) => Promise<ThreadChangesMutationLease | undefined | void>,
): SandboxFactory => ({
  async createSandbox(request) {
    const sandbox = await factory.createSandbox(request);
    const admitted = async <A>(
      kind: SandboxCommandKind,
      run: () => Promise<A>,
    ) => {
      const lease = await authorizeCommand(kind);
      return lease === undefined || lease === null
        ? run()
        : runWithCommandLease(lease, run);
    };
    return {
      ...sandbox,
      exec: (command, options) =>
        admitted("exec", () =>
          activityForCommand().runCommand(
            options?.timeoutMs ?? defaultTimeoutMs,
            () => sandbox.exec(command, options),
          ),
        ),
      writeFile: (path, content) =>
        admitted("writeFile", () =>
          activityForCommand().runCommand(defaultTimeoutMs, () =>
            sandbox.writeFile(path, content),
          ),
        ),
      mkdir: (path, options) =>
        admitted("mkdir", () =>
          activityForCommand().runCommand(defaultTimeoutMs, () =>
            sandbox.mkdir(path, options),
          ),
        ),
      rm: (path, options) =>
        admitted("rm", () =>
          activityForCommand().runCommand(defaultTimeoutMs, () =>
            sandbox.rm(path, options),
          ),
        ),
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
    readonly waitUntil?: Parameters<
      typeof makeThreadChangesCoordinator
    >[0]["waitUntil"];
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
      // The lease this command's authorization took, if it took one.
      const lease = takeCommandLease();
      await initialSync;
      return changes.runMutation(
        operation,
        lease === undefined ? options : { ...options, lease },
      );
    };
    return {
      ...sandbox,
      exec: (command, options) =>
        runMutation(() => sandbox.exec(command, options), {
          detectUnchanged: true,
        }),
      writeFile: (path, content) =>
        runMutation(() => sandbox.writeFile(path, content)),
      // Directories alone never show in Changes (Git tracks files), and
      // mkdir changes no file, so it needs no Changes coordination.
      mkdir: (path, options) => sandbox.mkdir(path, options),
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

/** Also reads the environment revision in the same round trip (#1493). */
export const assertThreadActive = async (db: D1Database, threadId: string) => {
  await authorizeActiveThread(db, threadId);
};

/**
 * A run's Orb start: `authorizeRunStart`, with a source refusal as the run's
 * error. Flue keeps a `FlueError`'s type, message, details, and meta on the
 * failed settlement, so the Thread can say why; the message stays in history.
 */
const admitRunStart = async (db: D1Database, threadId: string) => {
  try {
    await authorizeRunStart(db, threadId);
  } catch (cause) {
    if (!(cause instanceof SourceControlAccessDenied)) throw cause;
    throw new FlueError({
      type: "source_authorization_denied",
      message: "dx can't access this project's source.",
      details:
        "The source connection this Thread uses was revoked or changed. Reconnect or rebind the project's source, then retry.",
      dev: "",
      meta: {
        code: "SOURCE_AUTHORIZATION_DENIED",
        reason: cause.reason,
        action: cause.action,
      },
    });
  }
};

/**
 * Starts a run's own checks: its source admission and whether its workspace
 * still needs a first preparation. Each settles on its own; the activation
 * awaits them, so an early start leaves no unhandled rejection.
 */
const startRunAdmission = (
  db: D1Database,
  threadId: string,
): ExecutionRunAdmission => {
  const admitted = admitRunStart(db, threadId);
  admitted.catch(() => undefined);
  const firstPreparation = readExecutionWorkspaceReadiness(
    db,
    Schema.decodeUnknownSync(ThreadId)(threadId),
  )
    .then((readiness) => !readiness.ready)
    .catch(() => true);
  return { admitted, firstPreparation };
};

/** Starts a run's checks from the deployment's D1. */
export const admitExecutionRun = (threadId: string): ExecutionRunAdmission =>
  startRunAdmission(
    Effect.runSync(decodeD1Binding((env as Bindings).DB)),
    threadId,
  );

/**
 * Starts a daemon activation's Thread check (`assertThreadActive`) beside
 * its target resolution. It settles on its own, so an early start leaves no
 * unhandled rejection; the activation awaits it before the Orb resumes.
 */
export const admitDaemonActivation = (threadId: string): Promise<void> => {
  const active = assertThreadActive(
    Effect.runSync(decodeD1Binding((env as Bindings).DB)),
    threadId,
  );
  active.catch(() => undefined);
  return active;
};

/**
 * A source preparation that failed in a way the person fixes, as the run's
 * error: Flue settles other activation failures as a generic internal error,
 * so the Thread could not say the disk is full or the project's pre-clone
 * script failed.
 */
const PERSON_FIXED_SOURCE_FAILURES = [
  { code: "WORKSPACE_DISK_FULL", type: "workspace_disk_full" },
  { code: "PRE_CLONE_SCRIPT_FAILED", type: "pre_clone_script_failed" },
] as const;

const asSourceRunError = (cause: unknown): never => {
  const message = cause instanceof Error ? cause.message : "";
  const failure = PERSON_FIXED_SOURCE_FAILURES.find(({ code }) =>
    message.includes(`:${code})`),
  );
  if (failure === undefined) throw cause;
  throw new FlueError({
    type: failure.type,
    message,
    details: "",
    dev: "",
    meta: { code: failure.code },
  });
};

/**
 * The Orb's disk became read-only, as the run's error: the Thread names the
 * cause and what dx did, instead of a generic internal error.
 */
const readOnlyRunError = (details: string) =>
  new FlueError({
    type: "workspace_read_only",
    message: "The Orb's disk became read-only.",
    details,
    dev: "",
    meta: { code: WORKSPACE_READ_ONLY_CODE },
  });

const stillReadOnly = (recovery: ExecutionWorkspaceRecovery) =>
  `${
    recovery.files === "kept"
      ? "dx restarted the Orb, keeping its files"
      : recovery.files === "earlier"
        ? `dx restarted the Orb from its last save${savedAtText(recovery.savedAt)}`
        : "dx started the Orb over from a fresh image"
  }, but its disk is still read-only. Retry to restart it again.`;

/**
 * Restarts a read-only Orb through its provider, or fails the run saying
 * why it could not. Only a run's own activation restarts one: a reconnect
 * (a Terminal, a run reading its output) never does. The checkout's unsaved
 * work is copied out first, and the provider may drop the Orb's current
 * files only when that copy worked.
 */
const recoverReadOnlyWorkspace = async (
  provider: ExecutionProvider,
  context: ExecutionContext,
  threadId: ThreadId,
  guest: ExecutionGuest,
  existingOnly: boolean,
): Promise<{
  readonly recovery: ExecutionWorkspaceRecovery;
  readonly rescue: UnsavedWorkRescue;
}> => {
  const recover = provider.workspace.recover;
  if (existingOnly || recover === undefined) {
    executionWorkspaceLogger.error("The Orb's disk became read-only.", {
      event: "workspace_read_only",
      threadId,
      outcome: existingOnly ? "reconnect" : "unsupported",
      provider: context.profile.adapter,
    });
    throw readOnlyRunError(
      existingOnly
        ? "dx restarts it when the Thread's next turn starts."
        : "dx can't restart this Orb automatically, so its turns fail until it restarts. Copy out what you need from the Terminal, then start a new Thread.",
    );
  }
  const rescue = await rescueUnsavedWork(guest);
  executionWorkspaceLogger.warn(
    "The Orb's disk became read-only; restarting it.",
    {
      event: "workspace_read_only",
      threadId,
      outcome: "recovering",
      provider: context.profile.adapter,
      rescue: rescue.kind,
      ...(rescue.kind === "archive"
        ? {
            rescueBytes: rescue.bytes.byteLength,
            changes: rescue.changes,
            commits: rescue.commits,
          }
        : {}),
      ...(rescue.kind === "failed" ? { rescueError: rescue.reason } : {}),
    },
  );
  let recovery: ExecutionWorkspaceRecovery;
  try {
    recovery = await recover.call(
      provider.workspace,
      context,
      { threadId },
      { discardUnsaved: rescue.kind !== "failed" },
    );
  } catch (cause) {
    executionWorkspaceLogger.error("The read-only Orb's restart failed.", {
      event: "workspace_read_only",
      threadId,
      outcome: "recovery_failed",
      error: cause instanceof Error ? cause.message.slice(0, 500) : "failed",
    });
    throw readOnlyRunError(
      "dx tried to restart the Orb, but the restart failed. Retry to try again.",
    );
  }
  if (recovery.files === "unsaved") {
    executionWorkspaceLogger.error(
      "The read-only Orb was not restarted: its unsaved work would be lost.",
      {
        event: "workspace_read_only",
        threadId,
        outcome: "unsaved",
        ...(rescue.kind === "failed" ? { rescueError: rescue.reason } : {}),
      },
    );
    throw readOnlyRunError(
      `dx didn't restart the Orb: it can't save the Orb's files, and ${
        rescue.kind === "failed"
          ? rescue.reason
          : "it couldn't copy out the unsaved work"
      }, so a restart would lose that work. The Orb's files can still be read: copy out what you need from the Terminal, then start a new Thread.`,
    );
  }
  return { recovery, rescue };
};

export interface ExecutionActivationHooks {
  /**
   * Between source preparation and the workspace's first use, for 4e's warm
   * snapshot capture. Nothing registers one yet.
   */
  readonly prepared?: (event: {
    readonly context: ExecutionContext;
    readonly threadId: ThreadId;
    readonly handle: ExecutionWorkspaceHandle;
    readonly firstPreparation: boolean;
  }) => Promise<void>;
  /** Admits and meters every Orb start; `noOrbBilling` by default. */
  readonly orbBilling?: OrbBillingPolicy;
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
export const makeExecutionActivation = (
  hooks: ExecutionActivationHooks = {},
): ExecutionActivationFactory =>
  Object.assign(activationFor(hooks), {
    admit: admitExecutionRun,
    admitDaemon: admitDaemonActivation,
  });

const activationFor =
  (hooks: ExecutionActivationHooks) =>
  (unbilledProvider: ExecutionProvider): ExecutionActivation => {
    const provider = withOrbBilling(
      unbilledProvider,
      hooks.orbBilling ?? noOrbBilling,
    );
    const open = async (
      context: ExecutionContext,
      { id }: SandboxRequest,
      existingOnly: boolean,
      started?: ExecutionRunAdmission,
    ): Promise<FlueSandbox> => {
      const bindings = env as Bindings;
      const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
      const threadId = Schema.decodeUnknownSync(ThreadId)(id);
      // A run's source admission reads beside the provider's own reads and
      // gates the Orb start through `authorize`, which every provider runs
      // before it starts or resumes an Orb.
      const admission = existingOnly
        ? undefined
        : (started ?? startRunAdmission(db, id));
      const authorize = async () => {
        await Promise.all([assertThreadActive(db, id), admission?.admitted]);
      };
      const publish = statusPublications();
      const reportPreparation = (status: string | null) =>
        publish(() =>
          reportWorkspacePreparation(bindings, db, threadId, status),
        );
      // The reads of the preparation after source activation start now, so
      // their round trips overlap the checks and the workspace open.
      const githubConnected = githubCliConnected(db, id);
      githubConnected.catch(() => undefined);
      const additionalRepositories = readAdditionalRepositories(db, id);
      // A person's Restart Orb since the last run, which this run's agent
      // tells the Thread about (#1592).
      const restartNote = existingOnly
        ? Promise.resolve(undefined)
        : takeOrbRestartNoteFor(bindings.THREAD_EXECUTION, id);
      const timing = stepTiming(
        executionWorkspaceLogger,
        "execution_activation_timing",
        {
          threadId,
          provider: context.profile.adapter,
          operation: existingOnly ? "connect" : "create",
        },
      );
      // A reconnect only checks the Thread; a run also its source.
      if (existingOnly) await timing.step("admission", authorize);
      const needsFirstReadiness =
        admission === undefined
          ? false
          : await timing.step("readiness", () => admission.firstPreparation);
      timing.set("firstPreparation", needsFirstReadiness);
      if (needsFirstReadiness) reportPreparation("Preparing workspace…");
      let wakeStatusPublished = false;
      try {
        const openWorkspace = () =>
          existingOnly
            ? observeCall(
                "execution.activation.workspace",
                "phase",
                { "dx.operation": "connect" },
                () =>
                  provider.workspace.connect(
                    context,
                    { threadId },
                    { authorize },
                  ),
              )
            : observeCall(
                "execution.activation.workspace",
                "phase",
                { "dx.operation": "create" },
                () => {
                  const options: ExecutionWorkspaceCreateOptions &
                    CloudflareOpenPhaseReporter = {
                    authorize,
                    // A provider that waits on a container start says so;
                    // only a first preparation has a status line to show it.
                    ...(needsFirstReadiness
                      ? {
                          onPreparationPhase: (phase: CloudflareOpenPhase) =>
                            reportPreparation(openPreparationStatus[phase]),
                        }
                      : {}),
                    observeResidency: (observed) => {
                      if (
                        observed === "paused" &&
                        !needsFirstReadiness &&
                        !wakeStatusPublished
                      ) {
                        wakeStatusPublished = true;
                        publish(() =>
                          publishRealtimeWorkspaceStatus(
                            bindings,
                            threadId,
                            "waking",
                          ),
                        );
                      }
                    },
                  };
                  return provider.workspace.create(
                    context,
                    { threadId },
                    options,
                  );
                },
              );
        // The Thread's source is read while the Orb opens; a second
        // preparation after a restart reads it again.
        let sourceRecord: ReturnType<typeof readSourceWorkspace> | undefined =
          readSourceWorkspace(db, id);
        const prepareSource = async (handle: ExecutionWorkspaceHandle) => {
          const source = await handle.development?.source();
          const loadedSource = sourceRecord;
          sourceRecord = undefined;
          // Source preparation runs on the raw guest, outside the agent's
          // command leases, and its setup and resume hooks can outlast the
          // provider deadline that create/connect just set. Hold the Thread's
          // activity lease so the idle deadline keeps renewing until it ends.
          const preparation = handleActivity(threadId, handle).retain();
          const sourceStartedAt = Date.now();
          try {
            const sourceCwd = await observeCall(
              "execution.activation.source",
              "phase",
              {},
              () =>
                activateSourceWorkspace(
                  bindings,
                  db,
                  id,
                  handle.guest,
                  true,
                  source,
                  // Only a first preparation has a status to show; a ready
                  // workspace's row no longer takes one.
                  needsFirstReadiness
                    ? (phase) =>
                        Effect.sync(() =>
                          reportPreparation(sourcePreparationStatus[phase]),
                        )
                    : undefined,
                  {
                    reserve: context.profile.adapter !== "local",
                    // The turn this activation starts tells its agent.
                    onReading: (reading) =>
                      rememberWorkspaceDisk(threadId, reading),
                  },
                  loadedSource,
                ),
            ).catch(asSourceRunError);
            timing.set("sourceMs", Date.now() - sourceStartedAt);
            // Independent: the `gh` wrapper and the clones write different
            // paths, and neither throws.
            if (source === undefined)
              await Promise.all([
                ensureGithubCliWrapper(db, id, handle.guest, githubConnected),
                cloneAdditionalRepositories(
                  bindings,
                  db,
                  id,
                  handle.guest,
                  undefined,
                  additionalRepositories,
                ),
              ]);
            await hooks.prepared?.({
              context,
              threadId,
              handle,
              firstPreparation: needsFirstReadiness,
            });
            return { source, sourceCwd };
          } finally {
            preparation.release();
          }
        };
        let handle = await timing.step("workspace", () =>
          openWorkspace().catch(async (cause: unknown) => {
            // A refused admission reports itself, however the provider
            // wrapped the refusal.
            await admission?.admitted;
            throw cause;
          }),
        );
        void recordActiveSubmissionPhase(bindings, id, "workspace_resolved");
        // Before preparation, so a restart this activation makes itself is
        // the one the agent hears about.
        const restarted = await restartNote;
        if (restarted !== undefined)
          rememberWorkspaceRecovery(threadId, {
            files: restarted.files,
            cause: "manual",
            by: restarted.by,
            ...(restarted.savedAt === undefined
              ? {}
              : { savedAt: restarted.savedAt }),
            ...(restarted.restored === undefined
              ? {}
              : { restored: restarted.restored }),
          });
        if (needsFirstReadiness) reportPreparation("Preparing source…");
        let prepared: Awaited<ReturnType<typeof prepareSource>>;
        try {
          // A wedged Orb hangs preparation for good (#1584): restart it.
          prepared = await timing.step("prepare", () =>
            prepareWhileOrbAnswers({
              provider,
              context,
              threadId,
              existingOnly,
              handle,
              prepare: prepareSource,
              reopen: async () => {
                if (needsFirstReadiness)
                  reportPreparation("Restarting machine…");
                else if (!wakeStatusPublished) {
                  wakeStatusPublished = true;
                  publish(() =>
                    publishRealtimeWorkspaceStatus(
                      bindings,
                      threadId,
                      "waking",
                    ),
                  );
                }
                handle = await openWorkspace();
                return handle;
              },
            }),
          );
        } catch (cause) {
          if (!isWorkspaceReadOnlyFailure(cause)) throw cause;
          // Every write fails until the Orb restarts: restart it once and
          // prepare it again, so this turn runs.
          const { recovery, rescue } = await recoverReadOnlyWorkspace(
            provider,
            context,
            threadId,
            handle.guest,
            existingOnly,
          );
          if (needsFirstReadiness) reportPreparation("Restarting machine…");
          else if (!wakeStatusPublished) {
            wakeStatusPublished = true;
            publish(() =>
              publishRealtimeWorkspaceStatus(bindings, threadId, "waking"),
            );
          }
          handle = await openWorkspace();
          try {
            prepared = await prepareSource(handle);
          } catch (again) {
            if (!isWorkspaceReadOnlyFailure(again)) throw again;
            executionWorkspaceLogger.error(
              "The Orb's disk is still read-only after a restart.",
              {
                event: "workspace_read_only",
                threadId,
                outcome: "still_read_only",
                files: recovery.files,
              },
            );
            // Its files are gone either way: keep the copy in Thread storage.
            const kept =
              recovery.files !== "kept" && rescue.kind === "archive"
                ? await restoreUnsavedWork(
                    bindings,
                    threadId,
                    handle.guest,
                    rescue,
                  )
                : undefined;
            throw readOnlyRunError(
              `${stillReadOnly(recovery)}${
                kept?.storageFileId === undefined
                  ? ""
                  : ` A copy of its unsaved work is in the Thread's storage as ${kept.name}.`
              }`,
            );
          }
          // The restart dropped work dx copied out: put the copy back in
          // reach, in the new Orb and in Thread storage.
          const restored =
            recovery.files !== "kept" && rescue.kind === "archive"
              ? await restoreUnsavedWork(
                  bindings,
                  threadId,
                  handle.guest,
                  rescue,
                )
              : undefined;
          executionWorkspaceLogger.info(
            "The Orb was restarted after its disk became read-only.",
            {
              event: "workspace_read_only",
              threadId,
              outcome: "recovered",
              files: recovery.files,
              restored: restored !== undefined,
            },
          );
          rememberWorkspaceRecovery(
            threadId,
            restored === undefined ? recovery : { ...recovery, restored },
          );
        }
        const { source, sourceCwd } = prepared;
        void recordActiveSubmissionPhase(bindings, id, "source_activated");
        if (wakeStatusPublished)
          publish(() =>
            publishRealtimeWorkspaceStatus(bindings, threadId, "ready"),
          );
        if (needsFirstReadiness)
          // Off the agent's path. A status still queued after this matches no
          // row: readiness clears the status and only an unready row takes
          // one. A failed write leaves the next run to prepare it again.
          publish(() =>
            markExecutionWorkspaceReady(db, threadId).then(
              () =>
                publishRealtimeInvalidation(
                  bindings,
                  threadId,
                  "readiness.invalidated",
                ),
              (cause: unknown) => {
                executionWorkspaceLogger.warn(
                  "The workspace's readiness could not be recorded.",
                  {
                    event: "workspace_readiness_record_failed",
                    threadId,
                    error:
                      cause instanceof Error ? cause.message : String(cause),
                  },
                );
              },
            ),
          );
        kickDaemonActivation(bindings, threadId, activeSubmissionId(id));
        const factory: SandboxFactory = {
          createSandbox: () => handle.sandbox(sourceCwd),
          tools: executionWorkspaceTools,
        };
        rememberDxFilesSandbox(
          threadId,
          await withCommandActivity(
            factory,
            () => handleActivity(threadId, handle),
            handle.commandTimeoutMs,
            authorize,
          ).createSandbox({ id }),
        );
        const environmentFactory = context.profile.capabilities.includes(
          "environment-variables",
        )
          ? withExecutionEnvironment(
              factory,
              (activeThreadId) =>
                Effect.runPromise(
                  resolveExecutionEnvironment(bindings, activeThreadId),
                ),
              (activeThreadId) =>
                commandEnvironmentRevision(
                  bindings,
                  Schema.decodeUnknownSync(ThreadId)(activeThreadId),
                ),
            )
          : factory;
        const changesInput = {
          db,
          threadId,
          residentRefresh: residentRefreshFor(bindings, threadId),
          waitUntil,
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
        // A command Changes coordinates takes its mutation lease in its
        // authorization's batch, written only while the Thread is active:
        // one round trip instead of two. mkdir takes no lease.
        const authorizeCommand =
          changesFactory === environmentFactory
            ? authorize
            : authorizeCommandWithChangesLease(
                db,
                threadId,
                admission?.admitted,
              );
        const flueSandbox = await timing.step("sandbox", () =>
          withCommandActivity(
            withSourceRuntimeAdmission(changesFactory, bindings, db, source),
            () => handleActivity(threadId, handle),
            handle.commandTimeoutMs,
            authorizeCommand,
          ).createSandbox({ id }),
        );
        timing.log("ready");
        const snapshotWorkspaceContext = flueSandbox.snapshotWorkspaceContext;
        // No repository skill may shadow a skill dx mounts itself.
        if (snapshotWorkspaceContext === undefined)
          return withoutRepositorySkills(flueSandbox, RESERVED_SKILL_NAMES);
        return withoutRepositorySkills(
          {
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
          },
          RESERVED_SKILL_NAMES,
        );
      } catch (cause) {
        timing.log("error");
        if (needsFirstReadiness) reportPreparation(null);
        // Queued after waking, ready clears it in the browser.
        else if (wakeStatusPublished)
          publish(() =>
            publishRealtimeWorkspaceStatus(bindings, threadId, "ready"),
          );
        throw cause;
      }
    };

    const ensureDaemon = async (
      context: ExecutionContext,
      input: EnsureDaemonInput,
      admission?: Promise<void>,
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
      // The Thread's checks, started beside its target (the Thread is active,
      // and the workspace policy admits it), gate the Orb's resume through
      // `authorize`: a provider that declares `connectAuthorizes` runs it
      // beside its own record read and before it resumes an Orb; any other
      // is called only after them. A provider that retries checks the
      // Thread again.
      const admitted = admission ?? assertThreadActive(db, input.threadId);
      admitted.catch(() => undefined);
      let authorized = false;
      const authorize = () => {
        if (authorized) return assertThreadActive(db, input.threadId);
        authorized = true;
        return admitted;
      };
      let stage: DaemonInstallationStage = "workspace";
      try {
        // A key minted for this activation is stored before the Orb is
        // reached, so a resumed dxd never meets an authority without it.
        const credential = await input.credential;
        // A provider that doesn't run `authorize` itself gets the checks
        // finished before it is called.
        if (provider.workspace.connectAuthorizes !== true) await authorize();
        mark("prepare");
        throwIfAborted(input.signal);
        const handle = await atDaemonInstallationStage(
          "workspace",
          provider.workspace.connect(
            context,
            { threadId: input.threadId },
            { authorize },
          ),
        );
        // A provider that never ran `authorize` still installs nothing
        // before the checks pass.
        await atDaemonInstallationStage("workspace", admitted);
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
          credential === undefined &&
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
            undefined,
            { reserve: context.profile.adapter !== "local" },
          );
          throwIfAborted(input.signal);
          mark("source");
          if (source === undefined) {
            await ensureGithubCliWrapper(db, input.threadId, handle.guest);
            mark("githubCli");
            await cloneAdditionalRepositories(
              bindings,
              db,
              input.threadId,
              handle.guest,
            );
            mark("additionalRepositories");
          }
          throwIfAborted(input.signal);
          stage = "guest";
          outcome = await residentDaemon.install(context, handle, {
            threadId: input.threadId,
            endpoint: input.endpoint,
            credential,
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
      options?: { readonly wake?: boolean },
    ) => {
      if (!activities.has(threadId)) {
        // Starting to track reaches the provider, which may resume a
        // paused workspace.
        if (options?.wake === false) return;
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
      activate: (context, request, admission) =>
        traceSpan(
          "execution.activation.open",
          "phase",
          { "dx.thread_id": request.id, "dx.operation": "activate" },
          () => open(context, request, false, admission),
        ),
      reconnect: (context, request) =>
        traceSpan(
          "execution.activation.open",
          "phase",
          { "dx.thread_id": request.id, "dx.operation": "reconnect" },
          () => open(context, request, true),
        ),
      prestart: async (context, threadId) => {
        const db = await Effect.runPromise(
          decodeD1Binding((env as Bindings).DB),
        );
        const admission = startRunAdmission(db, threadId);
        const timing = stepTiming(
          executionWorkspaceLogger,
          "execution_prestart_timing",
          { threadId, provider: context.profile.adapter },
        );
        try {
          const handle = await timing.step("workspace", () =>
            provider.workspace
              .create(
                context,
                { threadId },
                {
                  // The run's own checks gate this start too.
                  authorize: async () => {
                    await Promise.all([
                      assertThreadActive(db, threadId),
                      admission.admitted,
                    ]);
                  },
                },
              )
              .catch(async (cause: unknown) => {
                await admission.admitted;
                throw cause;
              }),
          );
          // A new Orb's first guest command is slow (E2B) and its programs
          // may need installing: do that now. The run's activation checks
          // them again under the same guest lock; a failure here is its to
          // report.
          if (handle.development === undefined)
            await timing
              .step("assets", () =>
                installSourceWorkspaceAssets(
                  env as Bindings,
                  db,
                  threadId,
                  handle.guest,
                ),
              )
              .catch(() => timing.set("assetsFailed", true));
          timing.log("ready");
        } catch (cause) {
          timing.log("error");
          throw cause;
        }
      },
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
