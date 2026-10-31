import {
  type SourceWorkspaceRecord,
  SourceWorkspaceRepository,
  type SourceWorkspaceRepositoryShape,
  ThreadId,
  type ThreadSourceIntent,
  type ThreadSourceSnapshot,
} from "@dx/domain";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import {
  SOURCE_TOOL_VERSION_CONTRACT,
  SourceRuntimeToolUnavailable,
} from "../execution/guest/source-tool-requirements.js";
import type { WorkspacePreparation } from "../execution/workspace-preparation.js";
import { sourceControlLogger } from "../logging.js";
import {
  isDiskFullText,
  parseWorkspaceDiskReading,
  type WorkspaceDiskReading,
  workspaceDiskBlocksStart,
  workspaceDiskFullFailure,
  workspaceDiskGuard,
} from "../orb-disk/guard.js";
import { markRunFailure } from "../runtime/run-failure.js";
import {
  SourceRuntimeBroker,
  type SourceRuntimeBrokerShape,
} from "./runtime.js";
import {
  assetInstallerProgram,
  assetVerifierProgram,
  GIT_CREDENTIAL_HELPER_PATH,
  gitCredentialHelperProgram,
  SOURCE_WORKSPACE_PROGRAM_PATH,
  sourceWorkspaceProgram,
} from "./workspace-assets.js";

export const SOURCE_WORKSPACE_CWD = "/home/user/workspace/repo";
export const SCRATCH_WORKSPACE_CWD = "/home/user";
const SOURCE_STATE_DIRECTORY = "/home/user/.local/state/dx";
const LOCK_PATH = `${SOURCE_STATE_DIRECTORY}/source-control.lock`;
const COMMAND_TIMEOUT_MS = 360_000;
// The merged hooks action can run a 300 s setup hook followed by a 300 s
// resume hook inside one guest command.
const HOOKS_TIMEOUT_MS = 660_000;
// Digest plus tool-version verification of the template-baked assets.
const ASSET_VERIFIER_TIMEOUT_MS = 20_000;
const ASSET_STALE_EXIT = 42;

const withSourceLock = (command: string) =>
  `if test -L ${SOURCE_STATE_DIRECTORY} || { test -e ${SOURCE_STATE_DIRECTORY} && ! test -d ${SOURCE_STATE_DIRECTORY}; }; then exit 1; fi
install -d -m 0700 ${SOURCE_STATE_DIRECTORY}
flock -x ${LOCK_PATH} ${command}`;

export class SourceWorkspaceConflict extends Schema.TaggedError<SourceWorkspaceConflict>()(
  "SourceWorkspaceConflict",
  {},
) {}

export class SourceWorkspaceInitializationFailed extends Schema.TaggedError<SourceWorkspaceInitializationFailed>()(
  "SourceWorkspaceInitializationFailed",
  {
    /** The failed guest command's exit code, when it exited. */
    exitCode: Schema.optional(Schema.Int),
    /** The end of its stderr (or the transport error), redacted. */
    stderrTail: Schema.optional(Schema.String),
    /** Set, as a run-failure stamp, when the platform caused it. */
    message: Schema.optional(Schema.String),
  },
) {}

const STDERR_TAIL_CHARS = 2_000;

/**
 * The workspace's disk is full: a retry frees nothing, so it is not retried,
 * and the person (or the agent, once it can start) frees space.
 */
const diskFull = (totalBytes?: number) =>
  new SourceWorkspaceInitializationFailed({
    message: workspaceDiskFullFailure(totalBytes),
  });

/**
 * The end of a command's stderr, fit for a log: credentials in URLs, tokens,
 * and secret-looking assignments are removed, control characters replaced.
 */
const stderrTail = (value: string) =>
  value
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,})/g,
      "[redacted]",
    )
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(
      /\b([A-Za-z_]*(?:token|secret|password|passwd|credential|api_?key)[A-Za-z_]*)(\s*[=:]\s*)\S+/gi,
      "$1$2[redacted]",
    )
    .replace(/\p{Cc}/gu, (char) =>
      char === "\n" || char === "\t" ? char : "?",
    )
    .trim()
    .slice(-STDERR_TAIL_CHARS);

const commandFailed = (result: {
  readonly exitCode?: number;
  readonly stderr?: string;
}) =>
  new SourceWorkspaceInitializationFailed({
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.stderr === undefined || result.stderr === ""
      ? {}
      : { stderrTail: stderrTail(result.stderr) }),
  });

/**
 * A hooks run that failed in dx's own machinery (the source lock, a guest
 * exec that failed or timed out, the program's state) rather than in the
 * user's hooks, whose failures are only warnings: Flue retries the run.
 * An invalid input is dx's bug, and a retry repeats it.
 */
const asInfrastructureFailure = (error: SourceWorkspaceInitializationFailed) =>
  /^invalid-input\b/.test(error.stderrTail ?? "")
    ? error
    : new SourceWorkspaceInitializationFailed({
        ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
        ...(error.stderrTail === undefined
          ? {}
          : { stderrTail: error.stderrTail }),
        message: markRunFailure({
          class: "platform",
          code: "WORKSPACE_SETUP_INTERRUPTED",
          message:
            "The workspace's setup was interrupted before your hooks could finish.",
          retryable: true,
        }),
      });

export class SourceWorkspaceHistoryUnavailable extends Schema.TaggedError<SourceWorkspaceHistoryUnavailable>()(
  "SourceWorkspaceHistoryUnavailable",
  {},
) {}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface SourceWorkspaceVerifiedOperation {
  readonly action: "snapshot" | "activate";
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

interface SourceWorkspaceAssetVerificationResult {
  readonly assets: "fresh" | "stale";
  readonly operation?: CommandResult;
  /** The disk guard's reading, when the verifier ran it first. */
  readonly disk?: WorkspaceDiskReading;
}

export type SourceWorkspacePreparationPhase =
  | "cloning-repository"
  | "running-setup";

/** The disk guard each activation runs before anything dx writes. */
export interface SourceWorkspaceDiskOptions {
  /** Keep a reserve file to free when the disk fills (not on a developer's disk). */
  readonly reserve: boolean;
  readonly onReading?: (reading: WorkspaceDiskReading) => void;
}

export interface SourceWorkspaceActivationOptions {
  readonly disk?: SourceWorkspaceDiskOptions;
}

export interface SourceWorkspaceServiceShape {
  readonly activate: (
    threadId: string,
    preparation: WorkspacePreparation,
    onPreparationPhase?: (
      phase: SourceWorkspacePreparationPhase,
    ) => Effect.Effect<void>,
    options?: SourceWorkspaceActivationOptions,
  ) => Effect.Effect<
    string,
    | SourceWorkspaceConflict
    | SourceWorkspaceInitializationFailed
    | Schema.SchemaError
    | unknown
  >;
  readonly prepare: (
    threadId: string,
    preparation: WorkspacePreparation,
    disk?: SourceWorkspaceDiskOptions,
  ) => Effect.Effect<
    string,
    | SourceWorkspaceConflict
    | SourceWorkspaceInitializationFailed
    | Schema.SchemaError
    | unknown
  >;
  readonly unshallow: (
    threadId: string,
    preparation: WorkspacePreparation,
  ) => Effect.Effect<string, SourceWorkspaceHistoryUnavailable | unknown>;
}

export class SourceWorkspaceService extends Context.Service<
  SourceWorkspaceService,
  SourceWorkspaceServiceShape
>()("@dx/core/source-control/SourceWorkspaceService") {}

const requiredToolsFor = (_provider: ThreadSourceSnapshot["provider"]) =>
  ["git"] as const;

export type SourceWorkspaceAssetVerification = (
  preparation: WorkspacePreparation,
  program: string,
  tools: ReadonlyArray<"git" | "gh" | "git-lfs">,
  operation?: SourceWorkspaceVerifiedOperation,
  disk?: SourceWorkspaceDiskOptions,
) => Effect.Effect<
  SourceWorkspaceAssetVerificationResult,
  SourceWorkspaceInitializationFailed | SourceRuntimeToolUnavailable | unknown,
  never
>;

const sha256Hex = (value: string) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  });

const AssetVerdict = Schema.Struct({
  assets: Schema.Literals(["fresh", "stale"]),
  tools: Schema.Array(
    Schema.Struct({
      tool: Schema.Literals(["git", "gh", "git-lfs"]),
      status: Schema.Literals([
        "ok",
        "missing",
        "unsupported-version",
        "invalid-output",
      ]),
    }),
  ),
  operation: Schema.optional(
    Schema.Struct({
      stdout: Schema.String,
      stderr: Schema.String,
      exitCode: Schema.Int,
    }),
  ),
});

/**
 * One guest command verifies the template-baked helper and program digests
 * plus tool versions. When requested, that same process invokes only the
 * verified program under the source lock; drift returns without invocation.
 * Exit protocol: 0 fresh, 42 stale assets (reinstall), 43 tool contract
 * failure (typed template error), anything else is an initialization failure.
 * With `disk`, the same command first runs the disk guard; a disk that is
 * still full after it fails as WORKSPACE_DISK_FULL.
 */
export const verifySourceWorkspaceAssets = Effect.fn(
  "verifySourceWorkspaceAssets",
)(function* (
  preparation: WorkspacePreparation,
  program: string,
  tools: ReadonlyArray<"git" | "gh" | "git-lfs">,
  operation?: SourceWorkspaceVerifiedOperation,
  disk?: SourceWorkspaceDiskOptions,
): Effect.fn.Return<
  SourceWorkspaceAssetVerificationResult,
  SourceWorkspaceInitializationFailed | SourceRuntimeToolUnavailable | unknown
> {
  const [helperDigest, programDigest] = yield* Effect.all(
    [sha256Hex(gitCredentialHelperProgram), sha256Hex(program)],
    { concurrency: 2 },
  );
  const verifier = withSourceLock(`node -e '${assetVerifierProgram}'`);
  const verdictResult = yield* runCommand(
    preparation,
    disk === undefined
      ? verifier
      : `${workspaceDiskGuard(disk.reserve)}${verifier}`,
    {
      DX_ASSET_HELPER_PATH: GIT_CREDENTIAL_HELPER_PATH,
      DX_ASSET_PROGRAM_PATH: SOURCE_WORKSPACE_PROGRAM_PATH,
      DX_ASSET_HELPER_DIGEST: helperDigest,
      DX_ASSET_PROGRAM_DIGEST: programDigest,
      DX_ASSET_STATE_DIRECTORY: SOURCE_STATE_DIRECTORY,
      DX_ASSET_TOOLS: JSON.stringify(tools),
      DX_ASSET_TOOL_CONTRACT: JSON.stringify(SOURCE_TOOL_VERSION_CONTRACT),
      ...(operation === undefined
        ? {}
        : {
            ...operation.environment,
            DX_ASSET_ACTION: operation.action,
            DX_ASSET_ACTION_TIMEOUT_MS: String(operation.timeoutMs),
          }),
    },
    (operation?.timeoutMs ?? 0) + ASSET_VERIFIER_TIMEOUT_MS,
    [0, ASSET_STALE_EXIT, 43],
    "verify-assets",
  );
  const reading = parseWorkspaceDiskReading(verdictResult.stderr);
  if (reading !== undefined) {
    disk?.onReading?.(reading);
    if (workspaceDiskBlocksStart(reading))
      return yield* diskFull(reading.totalBytes);
  }
  if (
    verdictResult.exitCode !== 0 &&
    verdictResult.exitCode !== ASSET_STALE_EXIT &&
    verdictResult.exitCode !== 43
  )
    return yield* new SourceWorkspaceInitializationFailed();
  const verdict = yield* Effect.try({
    try: () =>
      Schema.decodeUnknownSync(AssetVerdict)(
        JSON.parse(verdictResult.stdout || "{}") as unknown,
      ),
    catch: () => new SourceWorkspaceInitializationFailed(),
  });
  const reportedTools = new Set(verdict.tools.map((item) => item.tool));
  if (
    verdict.tools.length !== tools.length ||
    reportedTools.size !== tools.length ||
    [...reportedTools].some((tool) => !tools.includes(tool))
  )
    return yield* new SourceWorkspaceInitializationFailed();
  const broken = verdict.tools.find((item) => item.status !== "ok");
  if (broken !== undefined && broken.status !== "ok")
    return yield* new SourceRuntimeToolUnavailable({
      tool: broken.tool,
      reason: broken.status,
      action: "update-orb-template",
    });
  if (verdictResult.exitCode === 43)
    return yield* new SourceWorkspaceInitializationFailed();
  if (verdict.assets === "stale" || verdictResult.exitCode === ASSET_STALE_EXIT)
    return {
      assets: "stale",
      ...(reading === undefined ? {} : { disk: reading }),
    };
  return {
    assets: "fresh",
    ...(verdict.operation === undefined
      ? {}
      : { operation: verdict.operation }),
    ...(reading === undefined ? {} : { disk: reading }),
  };
});

const commandFor = (action: string) =>
  withSourceLock(`node ${SOURCE_WORKSPACE_PROGRAM_PATH} ${action}`);

const bounded = (value: unknown) =>
  typeof value === "string" ? value.slice(0, 32_768) : "";

/**
 * The guest exec itself failed (the container object restarted, or the call
 * was lost or timed out), not the command: its error stands in for stderr,
 * and Flue retries the run at any stage.
 */
const guestExecLost = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  const failed = commandFailed({ stderr: message });
  return new SourceWorkspaceInitializationFailed({
    ...(failed.stderrTail === undefined
      ? {}
      : { stderrTail: failed.stderrTail }),
    message: message.includes("(dx_failure:")
      ? message
      : markRunFailure({
          class: "platform",
          code: "WORKSPACE_COMMAND_LOST",
          message: "The workspace lost a setup command before it finished.",
          retryable: true,
        }),
  });
};

const runCommand = (
  preparation: WorkspacePreparation,
  command: string,
  environment: Readonly<Record<string, string>> | undefined,
  timeoutMs: number,
  successfulExitCodes: ReadonlyArray<number> = [0],
  action: string = command,
) =>
  Effect.tryPromise({
    try: async (): Promise<CommandResult> => {
      try {
        const result = await preparation.run(command, {
          cwd: SCRATCH_WORKSPACE_CWD,
          environment,
          timeoutMs,
        });
        const commandResult = {
          stdout: bounded(result.stdout),
          stderr: bounded(result.stderr),
          exitCode: result.exitCode ?? 0,
        };
        if (!successfulExitCodes.includes(commandResult.exitCode))
          sourceControlLogger.error("Source workspace command failed.", {
            event: "source_workspace_command",
            action,
            exitCode: commandResult.exitCode,
            outcome: "error",
          });
        return commandResult;
      } catch (cause) {
        const result = cause as {
          stdout?: string;
          stderr?: string;
          exitCode?: number;
        };
        if (typeof result.exitCode === "number") {
          const commandResult = {
            stdout: bounded(result.stdout),
            stderr: bounded(result.stderr),
            exitCode: result.exitCode,
          };
          if (!successfulExitCodes.includes(commandResult.exitCode))
            sourceControlLogger.error("Source workspace command failed.", {
              event: "source_workspace_command",
              action,
              exitCode: commandResult.exitCode,
              outcome: "error",
            });
          return commandResult;
        }
        throw cause;
      }
    },
    catch: guestExecLost,
  });

const run = (
  preparation: WorkspacePreparation,
  action: string,
  environment: Readonly<Record<string, string>>,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
) =>
  runCommand(
    preparation,
    commandFor(action),
    environment,
    timeoutMs,
    [0],
    action,
  );

const baseEnvironment = (
  threadId: string,
  source: ThreadSourceSnapshot | ThreadSourceIntent,
  invocationId: string,
  configDigest: string,
  shallowClone: boolean,
) => ({
  DX_THREAD_ID: threadId,
  DX_SOURCE_PROVIDER: source.provider,
  DX_REPOSITORY_NAME: source.repositoryName,
  DX_CLONE_URL: source.cloneUrl,
  DX_BINDING_REVISION: String(source.bindingRevision),
  DX_INVOCATION_ID: invocationId,
  DX_SOURCE_CONFIG_DIGEST: configDigest,
  DX_SOURCE_SHALLOW_CLONE: shallowClone ? "true" : "false",
  ...("sourceRevision" in source
    ? {
        DX_SOURCE_SHA: source.sourceRevision,
        DX_DEFAULT_BRANCH: source.defaultBranch,
      }
    : {}),
});

const requireSuccess = (
  result: CommandResult,
): Effect.Effect<
  void,
  | SourceWorkspaceConflict
  | SourceWorkspaceHistoryUnavailable
  | SourceWorkspaceInitializationFailed
> => {
  if (result.exitCode === 0) return Effect.void;
  if (result.exitCode === 20) return Effect.fail(new SourceWorkspaceConflict());
  if (result.exitCode === 50)
    return Effect.fail(new SourceWorkspaceHistoryUnavailable());
  if (result.exitCode === 60 || isDiskFullText(result.stderr))
    return Effect.fail(diskFull());
  return Effect.fail(commandFailed(result));
};

/** A project script for the guest program's environment: UTF-8, base64. */
const encodedProjectScript = (body: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(body))
    binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** The pre-setup script for every command that can run setup. */
const preSetupEnvironment = (
  source: SourceWorkspaceRecord,
): Record<string, string> =>
  source.orbScripts?.preSetup === undefined
    ? {}
    : { DX_PRE_SETUP_SCRIPT: encodedProjectScript(source.orbScripts.preSetup) };

/**
 * The Desktop resume script for /opt/dx/desktop/resume. Every source command
 * carries it, or an empty value that removes a copy an earlier start left.
 */
const desktopResumeEnvironment = (
  source: SourceWorkspaceRecord,
): Record<string, string> => ({
  DX_DESKTOP_RESUME_SYNC: "true",
  DX_DESKTOP_RESUME_SCRIPT:
    source.orbScripts?.desktopResume === undefined
      ? ""
      : encodedProjectScript(source.orbScripts.desktopResume),
});

const PreCloneState = Schema.Struct({
  status: Schema.Literals(["skipped", "success", "failed"]),
  exitCode: Schema.optional(Schema.Int),
  timedOut: Schema.optional(Schema.Boolean),
  output: Schema.optional(Schema.String),
});

const PRE_CLONE_REPORTED_OUTPUT = 600;

/**
 * The project's pre-clone script failed. The person fixes it in Project
 * Settings, so a retry without that change fails again: not retried.
 */
const preCloneFailed = (state: typeof PreCloneState.Type) => {
  const how =
    state.timedOut === true
      ? "did not finish within 5 minutes"
      : state.exitCode === undefined
        ? "could not run"
        : `exited with code ${state.exitCode}`;
  const output = stderrTail(state.output ?? "").slice(
    -PRE_CLONE_REPORTED_OUTPUT,
  );
  return new SourceWorkspaceInitializationFailed({
    message: markRunFailure({
      class: "internal",
      code: "PRE_CLONE_SCRIPT_FAILED",
      message: `The project's pre-clone script ${how}, so dx did not clone the repository. Fix it in Project Settings, Orb, then retry.${
        output === "" ? "" : ` Its output ended with: ${output}`
      }`,
      retryable: false,
    }),
  });
};

/**
 * Runs the project's pre-clone script, when it has one, right before dx
 * clones the repository. Its failure stops preparation.
 */
const runPreClone = (
  preparation: WorkspacePreparation,
  source: SourceWorkspaceRecord,
  environment: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const body = source.orbScripts?.preClone;
    if (body === undefined) return;
    const result = yield* run(preparation, "pre-clone", {
      ...environment,
      DX_PRE_CLONE_SCRIPT: encodedProjectScript(body),
    });
    yield* requireSuccess(result);
    const state = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(PreCloneState)(
          JSON.parse(result.stdout || "{}") as unknown,
        ),
      catch: () => commandFailed(result),
    });
    if (state.status === "failed") return yield* preCloneFailed(state);
  });

const installPrograms = (
  preparation: WorkspacePreparation,
  invocationId: string,
  program: string,
) =>
  Effect.tryPromise({
    try: async () => {
      const helperTemporary = `${GIT_CREDENTIAL_HELPER_PATH}.${invocationId}.tmp`;
      const programTemporary = `${SOURCE_WORKSPACE_PROGRAM_PATH}.${invocationId}.tmp`;
      const argumentsList = `${helperTemporary} ${GIT_CREDENTIAL_HELPER_PATH} ${programTemporary} ${SOURCE_WORKSPACE_PROGRAM_PATH} ${SOURCE_STATE_DIRECTORY}`;
      const installer = withSourceLock(`node -e '${assetInstallerProgram}'`);
      try {
        await preparation.run(`${installer} prepare ${argumentsList}`, {
          cwd: SCRATCH_WORKSPACE_CWD,
          timeoutMs: 10_000,
        });
        await preparation.writeFile(
          helperTemporary,
          gitCredentialHelperProgram,
        );
        await preparation.writeFile(programTemporary, program);
        await preparation.run(`${installer} finalize ${argumentsList}`, {
          cwd: SCRATCH_WORKSPACE_CWD,
          timeoutMs: 10_000,
        });
      } catch (cause) {
        await preparation
          .run(`${installer} cleanup ${argumentsList}`, {
            cwd: SCRATCH_WORKSPACE_CWD,
            timeoutMs: 10_000,
          })
          .catch(() => undefined);
        throw cause;
      }
    },
    catch: guestExecLost,
  });

const Modules = Schema.Array(
  Schema.Struct({
    key: Schema.String,
    path: Schema.String,
    repositoryName: Schema.String,
  }),
);

const CheckoutState = Schema.Struct({
  status: Schema.Literals([
    "ready",
    "absent",
    "conflict",
    "disk-full",
    "failed",
  ]),
  modules: Modules,
  lfsNeeded: Schema.Boolean,
  shallow: Schema.Boolean,
  fullHistoryNeeded: Schema.Boolean,
});

const HookName = Schema.Literals(["pre-setup", "setup", "resume"]);

const HooksState = Schema.Struct({
  status: Schema.Literals([
    "ready",
    "conflict",
    "disk-full",
    "hook-failed",
    "failed",
  ]),
  hook: Schema.optional(HookName),
  /** Hooks that failed. The workspace is still ready: the agent carries on. */
  failed: Schema.optional(Schema.Array(HookName)),
});

const ActivationState = Schema.Struct({
  checkout: CheckoutState,
  hooks: Schema.optional(HooksState),
});

const decodeCheckoutState = Effect.fn("decodeCheckoutState")(function* (
  result: CommandResult,
): Effect.fn.Return<
  Schema.Schema.Type<typeof CheckoutState>,
  SourceWorkspaceInitializationFailed
> {
  return yield* Effect.try({
    try: () =>
      Schema.decodeUnknownSync(CheckoutState)(
        JSON.parse(result.stdout || "{}") as unknown,
      ),
    catch: () => commandFailed(result),
  });
});

/**
 * Settles a hooks run. Setup and resume only prepare the workspace for
 * convenience, so a failing hook is logged and the workspace stays usable;
 * the agent can finish that work itself.
 */
const requireHooksSuccess = Effect.fn("requireHooksSuccess")(function* (
  threadId: string,
  result: CommandResult,
): Effect.fn.Return<
  void,
  SourceWorkspaceConflict | SourceWorkspaceInitializationFailed
> {
  const hooks = yield* Effect.try({
    try: () =>
      Schema.decodeUnknownSync(HooksState)(
        JSON.parse(result.stdout || "{}") as unknown,
      ),
    catch: () => commandFailed(result),
  });
  if (hooks.status === "conflict") return yield* new SourceWorkspaceConflict();
  if (hooks.status === "disk-full") return yield* diskFull();
  // The program wrote its failure kind to stderr.
  if (hooks.status === "failed") return yield* commandFailed(result);
  const failed = hooks.failed ?? (hooks.hook === undefined ? [] : [hooks.hook]);
  if (failed.length > 0)
    sourceControlLogger.warn("Source workspace hooks failed; continuing.", {
      event: "source_workspace_hooks_failed",
      threadId,
      hooks: failed,
    });
});

/** Git LFS is best-effort: objects dx could not fetch stay pointer files. */
const LfsState = Schema.Struct({
  status: Schema.Literals(["complete", "incomplete"]),
  reason: Schema.optional(
    Schema.Literals(["unavailable", "install", "fetch", "checkout"]),
  ),
});

const requireLfsResult = Effect.fn("requireLfsResult")(function* (
  threadId: string,
  result: CommandResult,
): Effect.fn.Return<
  void,
  | SourceWorkspaceConflict
  | SourceWorkspaceHistoryUnavailable
  | SourceWorkspaceInitializationFailed
> {
  yield* requireSuccess(result);
  const lfs = yield* Effect.try({
    try: () =>
      Schema.decodeUnknownSync(LfsState)(
        JSON.parse(result.stdout || "{}") as unknown,
      ),
    catch: () => new SourceWorkspaceInitializationFailed(),
  });
  if (lfs.status === "incomplete")
    sourceControlLogger.warn(
      "Source workspace LFS objects incomplete; continuing.",
      {
        event: "source_workspace_lfs_incomplete",
        threadId,
        reason: lfs.reason ?? "unknown",
      },
    );
});

const AnonymousDiscovery = Schema.Struct({
  sourceRevision: Schema.String.check(
    Schema.isMinLength(40),
    Schema.isMaxLength(40),
    Schema.isPattern(/^[a-f0-9]{40}$/),
  ),
  defaultBranch: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
  initialRef: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(512),
  ),
});

const makeSourceWorkspaceService = (
  repository: SourceWorkspaceRepositoryShape,
  broker: SourceRuntimeBrokerShape,
  program: string,
  verifyAssets: SourceWorkspaceAssetVerification,
  shallowClone = false,
) => {
  const sourceConfigurationDigest = (
    privateSubmodules: SourceWorkspaceRecord["privateSubmodules"],
  ) =>
    Effect.promise(async () => {
      const configuration = [...privateSubmodules]
        .sort((left, right) =>
          left.providerRepositoryId.localeCompare(right.providerRepositoryId),
        )
        .map((item) => [item.providerRepositoryId, item.repositoryName]);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(configuration)),
      );
      return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    });
  const unshallowSource = (
    threadId: ThreadId,
    source: SourceWorkspaceRecord,
    snapshot: ThreadSourceSnapshot,
    preparation: WorkspacePreparation,
    invocationId: string,
    configDigest: string,
    invocationSource: "setup-hook" | "system",
  ) => {
    const environment = baseEnvironment(
      threadId,
      snapshot,
      invocationId,
      configDigest,
      shallowClone,
    );
    if (source.authority === undefined)
      return run(preparation, "unshallow-anonymous", environment).pipe(
        Effect.flatMap(requireSuccess),
      );
    return broker.withCommandEnvironment(
      threadId,
      source.actorUserId,
      { operation: "fetch", invocationSource },
      (credential) =>
        run(preparation, "unshallow", {
          ...environment,
          ...credential,
        }).pipe(Effect.flatMap(requireSuccess)),
    );
  };
  const unshallow = (
    unsafeThreadId: string,
    preparation: WorkspacePreparation,
  ) =>
    Effect.gen(function* () {
      const threadId =
        yield* Schema.decodeUnknownEffect(ThreadId)(unsafeThreadId);
      const source = yield* repository.findByThreadId(threadId);
      if (source.snapshot === undefined)
        return yield* new SourceWorkspaceHistoryUnavailable();
      const invocationId = crypto.randomUUID();
      const configDigest = yield* sourceConfigurationDigest(
        source.privateSubmodules,
      );
      const assetState = yield* verifyAssets(
        preparation,
        program,
        requiredToolsFor(source.snapshot.provider),
      );
      if (assetState.assets === "stale")
        yield* installPrograms(preparation, invocationId, program);
      yield* unshallowSource(
        threadId,
        source,
        source.snapshot,
        preparation,
        invocationId,
        configDigest,
        "system",
      );
      return SOURCE_WORKSPACE_CWD;
    });
  const activate = (
    unsafeThreadId: string,
    preparation: WorkspacePreparation,
    runThreadHooks: boolean,
    onPreparationPhase?: (
      phase: SourceWorkspacePreparationPhase,
    ) => Effect.Effect<void>,
    options?: SourceWorkspaceActivationOptions,
  ): Effect.Effect<string, unknown> => {
    let stage = "load-source";
    return Effect.gen(function* () {
      const threadId =
        yield* Schema.decodeUnknownEffect(ThreadId)(unsafeThreadId);
      const source = yield* repository.findByThreadId(threadId);
      if (source.snapshot === undefined && source.intent === undefined) {
        stage = "prepare-empty-workspace";
        const disk = options?.disk;
        const prepared = yield* Effect.tryPromise({
          try: () =>
            preparation.run(
              `${disk === undefined ? "" : workspaceDiskGuard(disk.reserve)}mkdir -p -- ${SOURCE_WORKSPACE_CWD} && git -C ${SOURCE_WORKSPACE_CWD} init && git -C ${SOURCE_WORKSPACE_CWD} hash-object -w -t tree --stdin </dev/null`,
              {
                cwd: SCRATCH_WORKSPACE_CWD,
                timeoutMs: 10_000,
              },
            ),
          catch: guestExecLost,
        });
        const reading = parseWorkspaceDiskReading(prepared.stderr ?? "");
        if (reading !== undefined) {
          disk?.onReading?.(reading);
          if (workspaceDiskBlocksStart(reading))
            return yield* diskFull(reading.totalBytes);
        }
        yield* requireSuccess({
          stdout: bounded(prepared.stdout),
          stderr: bounded(prepared.stderr),
          exitCode: prepared.exitCode ?? 0,
        });
        return SOURCE_WORKSPACE_CWD;
      }
      stage = "verify-assets";
      const provider = (source.snapshot ?? source.intent)?.provider;
      if (provider === undefined)
        return yield* new SourceWorkspaceInitializationFailed();
      const invocationId = crypto.randomUUID();
      const configDigest = yield* sourceConfigurationDigest(
        source.privateSubmodules,
      );
      let snapshot = source.snapshot;
      const prefetchedBase =
        snapshot === undefined
          ? undefined
          : {
              ...baseEnvironment(
                threadId,
                snapshot,
                invocationId,
                configDigest,
                shallowClone,
              ),
              ...desktopResumeEnvironment(source),
            };
      let setupPhasePublished = false;
      if (
        prefetchedBase !== undefined &&
        runThreadHooks &&
        onPreparationPhase !== undefined
      ) {
        yield* onPreparationPhase("running-setup");
        setupPhasePublished = true;
      }
      const assetVerification = yield* verifyAssets(
        preparation,
        program,
        requiredToolsFor(provider),
        prefetchedBase === undefined
          ? undefined
          : {
              action: runThreadHooks ? "activate" : "snapshot",
              environment: {
                ...prefetchedBase,
                ...(runThreadHooks ? preSetupEnvironment(source) : {}),
              },
              timeoutMs: runThreadHooks ? HOOKS_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
            },
        options?.disk,
      );
      if (assetVerification.assets === "stale") {
        stage = "install-programs";
        sourceControlLogger.warn(
          "Source workspace template assets are stale.",
          {
            event: "source_workspace_assets",
            outcome: "stale",
          },
        );
        yield* installPrograms(preparation, invocationId, program);
      } else {
        sourceControlLogger.info(
          "Source workspace template assets are fresh.",
          {
            event: "source_workspace_assets",
            outcome: "fresh",
          },
        );
      }
      if (snapshot === undefined) {
        const intent = source.intent;
        if (intent === undefined)
          return yield* new SourceWorkspaceInitializationFailed();
        stage = "initialize-anonymous-checkout";
        if (onPreparationPhase !== undefined)
          yield* onPreparationPhase("cloning-repository");
        const anonymousBase = {
          ...baseEnvironment(
            threadId,
            intent,
            invocationId,
            configDigest,
            shallowClone,
          ),
          ...desktopResumeEnvironment(source),
        };
        stage = "pre-clone";
        yield* runPreClone(preparation, source, anonymousBase);
        stage = "initialize-anonymous-checkout";
        const initialized = yield* run(
          preparation,
          "initialize-anonymous",
          anonymousBase,
        );
        yield* requireSuccess(initialized);
        const discovered = yield* Effect.try({
          try: () => JSON.parse(initialized.stdout || "{}") as unknown,
          catch: () => new SourceWorkspaceInitializationFailed(),
        }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(AnonymousDiscovery)));
        stage = "finalize-anonymous-source";
        snapshot = yield* repository.finalizeAnonymous(intent, {
          ...discovered,
          capturedAt: yield* DateTime.now,
        });
      }
      const base = {
        ...baseEnvironment(
          threadId,
          snapshot,
          invocationId,
          configDigest,
          shallowClone,
        ),
        ...desktopResumeEnvironment(source),
      };
      stage = "read-checkout-state";
      let prefetchedHooks: typeof HooksState.Type | undefined;
      let prefetchedHooksStderr = "";
      let checkout: typeof CheckoutState.Type;
      const verifiedOperation = assetVerification.operation;
      if (verifiedOperation === undefined) {
        const checkoutResult = yield* run(preparation, "snapshot", base);
        yield* requireSuccess(checkoutResult);
        checkout = yield* decodeCheckoutState(checkoutResult);
      } else if (runThreadHooks) {
        yield* requireSuccess(verifiedOperation);
        const activation = yield* Effect.try({
          try: () =>
            Schema.decodeUnknownSync(ActivationState)(
              JSON.parse(verifiedOperation.stdout || "{}") as unknown,
            ),
          catch: () => new SourceWorkspaceInitializationFailed(),
        });
        checkout = activation.checkout;
        prefetchedHooks = activation.hooks;
        prefetchedHooksStderr = verifiedOperation.stderr;
      } else {
        yield* requireSuccess(verifiedOperation);
        checkout = yield* decodeCheckoutState(verifiedOperation);
      }
      if (checkout.status === "absent") {
        if (onPreparationPhase !== undefined)
          yield* onPreparationPhase("cloning-repository");
        stage = "pre-clone";
        yield* runPreClone(preparation, source, base);
        stage = "initialize-checkout";
        const checkoutResult =
          source.authority === undefined
            ? yield* run(preparation, "initialize-exact-anonymous", base)
            : yield* broker.withCommandEnvironment(
                threadId,
                source.actorUserId,
                { operation: "checkout", invocationSource: "checkout" },
                (credential) =>
                  run(preparation, "initialize", { ...base, ...credential }),
              );
        yield* requireSuccess(checkoutResult);
        checkout = yield* decodeCheckoutState(checkoutResult);
      }
      if (checkout.status === "conflict")
        return yield* new SourceWorkspaceConflict();
      if (checkout.status === "disk-full") return yield* diskFull();
      if (checkout.status !== "ready")
        return yield* new SourceWorkspaceInitializationFailed();
      // dx initializes only the private submodules the Project selected, and
      // only on GitHub. Every other submodule stays the user's to manage.
      for (const module of provider === "github" ? checkout.modules : []) {
        const selected = source.privateSubmodules.find(
          (candidate) =>
            candidate.repositoryName.toLowerCase() ===
            module.repositoryName.toLowerCase(),
        );
        if (selected === undefined || source.authority === undefined) continue;
        stage = "initialize-submodule";
        yield* broker.withCommandEnvironment(
          threadId,
          source.actorUserId,
          { operation: "checkout", invocationSource: "checkout" },
          (credential) =>
            run(preparation, "submodule", {
              ...base,
              ...credential,
              DX_SUBMODULE_KEY: module.key,
              DX_SUBMODULE_PATH: module.path,
              DX_SUBMODULE_NAME: module.repositoryName,
            }).pipe(Effect.flatMap((result) => requireSuccess(result))),
          selected.providerRepositoryId,
        );
      }

      // Anonymous sources have no credential to fetch LFS objects with; the
      // pointer files stay in place for the user to pull.
      if (checkout.lfsNeeded && source.authority !== undefined) {
        stage = "initialize-lfs";
        yield* broker.withCommandEnvironment(
          threadId,
          source.actorUserId,
          { operation: "fetch", invocationSource: "checkout" },
          (credential) =>
            run(preparation, "lfs", { ...base, ...credential }).pipe(
              Effect.flatMap((result) => requireLfsResult(threadId, result)),
            ),
        );
      }
      if (runThreadHooks) {
        if (checkout.fullHistoryNeeded) {
          stage = "unshallow";
          yield* unshallowSource(
            threadId,
            source,
            snapshot,
            preparation,
            invocationId,
            configDigest,
            "setup-hook",
          );
        }
        stage = "run-hooks";
        if (!setupPhasePublished && onPreparationPhase !== undefined)
          yield* onPreparationPhase("running-setup");
        const hooksSettled =
          prefetchedHooks === undefined
            ? run(
                preparation,
                "hooks",
                {
                  ...base,
                  ...preSetupEnvironment(source),
                },
                HOOKS_TIMEOUT_MS,
              ).pipe(
                Effect.tap(requireSuccess),
                Effect.flatMap((hooks) => requireHooksSuccess(threadId, hooks)),
              )
            : requireHooksSuccess(threadId, {
                stdout: JSON.stringify(prefetchedHooks),
                stderr: prefetchedHooksStderr,
                exitCode: 0,
              });
        yield* hooksSettled.pipe(
          Effect.mapError((error) =>
            error instanceof SourceWorkspaceInitializationFailed
              ? asInfrastructureFailure(error)
              : error,
          ),
        );
        sourceControlLogger.info("Source workspace activated.", {
          event: "source_workspace_activation",
          threadId,
          provider: snapshot.provider,
          bindingRevision: snapshot.bindingRevision,
          outcome: "ready",
        });
      } else if (!checkout.fullHistoryNeeded) {
        // Preparation without hooks still finishes dx's provisioning; from now
        // on the checkout belongs to the user. A pending unshallow waits for
        // the hooks that need it.
        stage = "mark-provisioned";
        yield* requireSuccess(
          yield* run(preparation, "mark-provisioned", base),
        );
      }
      return SOURCE_WORKSPACE_CWD;
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() =>
          sourceControlLogger.error("Source workspace activation failed.", {
            event: "source_workspace_activation",
            threadId: unsafeThreadId,
            stage,
            outcome: "error",
            ...(error instanceof SourceWorkspaceInitializationFailed
              ? {
                  error: error._tag,
                  ...(error.exitCode === undefined
                    ? {}
                    : { exitCode: error.exitCode }),
                  ...(error.stderrTail === undefined
                    ? {}
                    : { stderrTail: error.stderrTail }),
                  retryable: error.message.includes("(dx_failure:platform:"),
                }
              : {}),
          }),
        ),
      ),
    );
  };
  return SourceWorkspaceService.of({
    activate: (threadId, preparation, onPreparationPhase, options) =>
      activate(threadId, preparation, true, onPreparationPhase, options),
    prepare: (threadId, preparation, disk) =>
      activate(
        threadId,
        preparation,
        false,
        undefined,
        disk === undefined ? undefined : { disk },
      ),
    unshallow,
  });
};

export const SourceWorkspaceServiceLive = Layer.effect(
  SourceWorkspaceService,
  Effect.gen(function* () {
    return makeSourceWorkspaceService(
      yield* SourceWorkspaceRepository,
      yield* SourceRuntimeBroker,
      sourceWorkspaceProgram,
      verifySourceWorkspaceAssets,
    );
  }),
);

export const SourceWorkspaceServiceWithBroker = (
  broker: SourceRuntimeBrokerShape,
  program = sourceWorkspaceProgram,
  verifyAssets: SourceWorkspaceAssetVerification = verifySourceWorkspaceAssets,
  shallowClone = false,
) =>
  Layer.effect(
    SourceWorkspaceService,
    Effect.gen(function* () {
      const repository = yield* SourceWorkspaceRepository;
      return makeSourceWorkspaceService(
        repository,
        broker,
        program,
        verifyAssets,
        shallowClone,
      );
    }),
  );
