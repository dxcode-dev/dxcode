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
} from "../execution/e2b/source-tool-requirements.js";
import type { WorkspacePreparation } from "../execution/workspace-preparation.js";
import { sourceControlLogger } from "../logging.js";
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
  {},
) {}

export class SourceWorkspaceHookFailed extends Schema.TaggedError<SourceWorkspaceHookFailed>()(
  "SourceWorkspaceHookFailed",
  { hook: Schema.Literals(["setup", "resume"]) },
) {}

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
}

export type SourceWorkspacePreparationPhase =
  | "cloning-repository"
  | "running-setup";

export interface SourceWorkspaceActivationOptions {
  /** Skip the per-activation resume hook after a confirmed running reconnect. */
  readonly runResume?: boolean;
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
    | SourceWorkspaceHookFailed
    | Schema.SchemaError
    | unknown
  >;
  readonly prepare: (
    threadId: string,
    preparation: WorkspacePreparation,
  ) => Effect.Effect<
    string,
    | SourceWorkspaceConflict
    | SourceWorkspaceInitializationFailed
    | SourceWorkspaceHookFailed
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
 */
export const verifySourceWorkspaceAssets = Effect.fn(
  "verifySourceWorkspaceAssets",
)(function* (
  preparation: WorkspacePreparation,
  program: string,
  tools: ReadonlyArray<"git" | "gh" | "git-lfs">,
  operation?: SourceWorkspaceVerifiedOperation,
): Effect.fn.Return<
  SourceWorkspaceAssetVerificationResult,
  SourceWorkspaceInitializationFailed | SourceRuntimeToolUnavailable | unknown
> {
  const [helperDigest, programDigest] = yield* Effect.all(
    [sha256Hex(gitCredentialHelperProgram), sha256Hex(program)],
    { concurrency: 2 },
  );
  const verdictResult = yield* runCommand(
    preparation,
    withSourceLock(`node -e '${assetVerifierProgram}'`),
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
      action: "update-e2b-template",
    });
  if (verdictResult.exitCode === 43)
    return yield* new SourceWorkspaceInitializationFailed();
  if (verdict.assets === "stale" || verdictResult.exitCode === ASSET_STALE_EXIT)
    return { assets: "stale" };
  return {
    assets: "fresh",
    ...(verdict.operation === undefined
      ? {}
      : { operation: verdict.operation }),
  };
});

const commandFor = (action: string) =>
  withSourceLock(`node ${SOURCE_WORKSPACE_PROGRAM_PATH} ${action}`);

const bounded = (value: unknown) =>
  typeof value === "string" ? value.slice(0, 32_768) : "";

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
    catch: () => new SourceWorkspaceInitializationFailed(),
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
  return Effect.fail(new SourceWorkspaceInitializationFailed());
};

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
    catch: () => new SourceWorkspaceInitializationFailed(),
  });

const Modules = Schema.Array(
  Schema.Struct({
    key: Schema.String,
    path: Schema.String,
    repositoryName: Schema.String,
  }),
);

const CheckoutState = Schema.Struct({
  status: Schema.Literals(["ready", "absent", "conflict", "failed"]),
  modules: Modules,
  lfsNeeded: Schema.Boolean,
  shallow: Schema.Boolean,
  fullHistoryNeeded: Schema.Boolean,
});

const HooksState = Schema.Struct({
  status: Schema.Literals(["ready", "conflict", "hook-failed", "failed"]),
  hook: Schema.optional(Schema.Literals(["setup", "resume"])),
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
    catch: () => new SourceWorkspaceInitializationFailed(),
  });
});

const requireHooksSuccess = Effect.fn("requireHooksSuccess")(function* (
  result: CommandResult,
): Effect.fn.Return<
  void,
  | SourceWorkspaceConflict
  | SourceWorkspaceInitializationFailed
  | SourceWorkspaceHookFailed
> {
  const hooks = yield* Effect.try({
    try: () =>
      Schema.decodeUnknownSync(HooksState)(
        JSON.parse(result.stdout || "{}") as unknown,
      ),
    catch: () => new SourceWorkspaceInitializationFailed(),
  });
  if (hooks.status === "ready") return;
  if (hooks.status === "conflict") return yield* new SourceWorkspaceConflict();
  if (hooks.status === "hook-failed" && hooks.hook !== undefined)
    return yield* new SourceWorkspaceHookFailed({ hook: hooks.hook });
  return yield* new SourceWorkspaceInitializationFailed();
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
        const prepared = yield* Effect.tryPromise({
          try: () =>
            preparation.run(
              `mkdir -p -- ${SOURCE_WORKSPACE_CWD} && git -C ${SOURCE_WORKSPACE_CWD} init && git -C ${SOURCE_WORKSPACE_CWD} hash-object -w -t tree --stdin </dev/null`,
              {
                cwd: SCRATCH_WORKSPACE_CWD,
                timeoutMs: 10_000,
              },
            ),
          catch: () => new SourceWorkspaceInitializationFailed(),
        });
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
          : baseEnvironment(
              threadId,
              snapshot,
              invocationId,
              configDigest,
              shallowClone,
            );
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
                DX_RUN_RESUME: options?.runResume === false ? "false" : "true",
              },
              timeoutMs: runThreadHooks ? HOOKS_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
            },
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
        const initialized = yield* run(
          preparation,
          "initialize-anonymous",
          baseEnvironment(
            threadId,
            intent,
            invocationId,
            configDigest,
            shallowClone,
          ),
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
      const base = baseEnvironment(
        threadId,
        snapshot,
        invocationId,
        configDigest,
        shallowClone,
      );
      stage = "read-checkout-state";
      let prefetchedHooks: typeof HooksState.Type | undefined;
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
      } else {
        yield* requireSuccess(verifiedOperation);
        checkout = yield* decodeCheckoutState(verifiedOperation);
      }
      if (checkout.status === "absent") {
        stage = "initialize-checkout";
        if (onPreparationPhase !== undefined)
          yield* onPreparationPhase("cloning-repository");
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
              Effect.flatMap((result) => requireSuccess(result)),
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
        if (prefetchedHooks === undefined) {
          const hooks = yield* run(
            preparation,
            "hooks",
            {
              ...base,
              DX_RUN_RESUME: options?.runResume === false ? "false" : "true",
            },
            HOOKS_TIMEOUT_MS,
          );
          yield* requireSuccess(hooks);
          yield* requireHooksSuccess(hooks);
        } else {
          yield* requireHooksSuccess({
            stdout: JSON.stringify(prefetchedHooks),
            stderr: "",
            exitCode: 0,
          });
        }
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
      Effect.tapError(() =>
        Effect.sync(() =>
          sourceControlLogger.error("Source workspace activation failed.", {
            event: "source_workspace_activation",
            threadId: unsafeThreadId,
            stage,
            outcome: "error",
          }),
        ),
      ),
    );
  };
  return SourceWorkspaceService.of({
    activate: (threadId, preparation, onPreparationPhase, options) =>
      activate(threadId, preparation, true, onPreparationPhase, options),
    prepare: (threadId, preparation) => activate(threadId, preparation, false),
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
