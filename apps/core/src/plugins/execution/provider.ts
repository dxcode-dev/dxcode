import {
  type CloudflareRunnerProfileConfiguration,
  type E2BRunnerProfileConfiguration,
  type ExecutionCapabilityId,
  type ExecutionPauseResumePreserves,
  executionCapabilitiesForRunnerProfile,
  type LocalRunnerProfileConfiguration,
  type PluginProviderId,
  type RunnerProfile,
  type ThreadId,
} from "@dx/domain";
import type { Sandbox, SandboxFactory } from "@flue/runtime";
import { Effect, Redacted, Schema } from "effect";
import {
  type ExecutionCredentialUnavailableReason,
  type ExecutionTargetCredential,
  resolveExecutionTarget,
} from "../../execution/runner-profiles/execution.js";
import type { SourceWorkspaceRuntimeOptions } from "../../execution/source-preparation.js";
import type { Bindings } from "../../http/types.js";
import { orbProvidersLogger } from "../../logging.js";
import { drainThreadDaemon } from "../../threads/daemon-client.js";
import {
  deploymentProviders,
  findPlugin,
  findProvider,
  providerCapabilities,
} from "../registry.js";
import { executionWorkspaceTools } from "./tools.js";

/**
 * The Execution ("Orb") plugin's provider contract. A provider implements
 * `execution.workspace` and, optionally, `execution.resident-daemon`, as raw
 * handles: Core owns the activation pipeline that turns a handle into the
 * agent's prepared workspace.
 * `execution.pause-resume` is a guarantee about what `release(…, "archive")`
 * and idleness keep. `execution.snapshot`, `execution.usage`, and
 * `execution.display` have IDs but no operations yet, so no provider has
 * them; wiki/plugin-platform-direction.md "Execution roadmap" describes the
 * operations they will add.
 */
export type ExecutionProviderId = Extract<
  PluginProviderId,
  "e2b" | "cloudflare" | "local"
>;

/**
 * Whose provider account holds the workspace, and therefore who pays.
 * `providerAccount` names the account a person's or workspace's key belongs
 * to (the E2B team), which the Thread pinned at creation.
 */
export type ExecutionAccount =
  | { readonly scope: "deployment" }
  | {
      readonly scope: "workspace";
      readonly workspaceId: string;
      readonly providerAccount: string;
    }
  | {
      readonly scope: "personal";
      readonly userId: string;
      readonly providerAccount: string;
    };

export type ExecutionProfile =
  | E2BRunnerProfileConfiguration
  | CloudflareRunnerProfileConfiguration
  | LocalRunnerProfileConfiguration;

/**
 * Resolved by Core for each provider operation; providers never pick an
 * account or read a key from bindings themselves. The account is the one
 * the Thread pinned at creation: the deployment's, or a person's or
 * workspace's own key for a key-based provider (E2B).
 */
export interface ExecutionContext {
  readonly account: ExecutionAccount;
  /** Undefined only for credential-less providers (the local runtime). */
  readonly credential: Redacted.Redacted<string> | undefined;
  /** The Thread's runner profile; its adapter is this provider. */
  readonly profile: ExecutionProfile;
}

export interface DaemonCredential {
  readonly id: string;
  readonly key: Redacted.Redacted<string>;
}

export interface EnsureDaemonInput {
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

export interface DaemonInstallation {
  readonly releaseLoadedAt?: number;
  readonly installedAt?: number;
  /** Set when the guest was bootstrapped or reconfigured. */
  readonly bootstrapped: boolean;
  /** The Thread's pinned provider; set by composition. */
  readonly provider?: ExecutionProviderId;
  /** The workspace handle's `processesStartedAt`, when it reports one. */
  readonly processesStartedAt?: number;
}

type SandboxRequest = Parameters<SandboxFactory["createSandbox"]>[0];
type FlueSandbox = Awaited<ReturnType<SandboxFactory["createSandbox"]>>;

/**
 * Whose workspace it is. Today always a Thread; 4e adds the warm workspace
 * a project snapshot is captured from.
 */
export interface ExecutionWorkspaceOwner {
  readonly threadId: ThreadId;
}

/**
 * A provider snapshot that seeds a new workspace (4e). Only a provider that
 * claims `execution.snapshot` receives one; none does yet.
 */
export interface ExecutionWorkspaceSeed {
  readonly snapshotId: string;
}

/** Whether an existing workspace was running or paused when reached. */
export type ExecutionWorkspaceResidency = "running" | "paused" | "unknown";

export interface ExecutionWorkspaceOpenOptions {
  /**
   * Core's lifecycle admission. A provider that serializes creation runs it
   * again under its own lock, so an archived Thread never gets a workspace.
   */
  readonly authorize: () => Promise<void>;
}

export interface ExecutionWorkspaceCreateOptions
  extends ExecutionWorkspaceOpenOptions {
  readonly seed?: ExecutionWorkspaceSeed;
  /**
   * Called before an existing workspace is resumed, so Core can tell the
   * browser a paused workspace is waking.
   */
  readonly observeResidency?: (
    residency: ExecutionWorkspaceResidency,
  ) => void | Promise<void>;
}

/** The raw guest Core prepares: source, the `gh` wrapper, dxd bootstrap. */
export interface ExecutionGuest {
  readonly commands: {
    readonly run: (
      command: string,
      options?: {
        readonly cwd?: string;
        readonly envs?: Record<string, string>;
        readonly timeoutMs?: number;
      },
    ) => Promise<{
      readonly stdout?: string;
      readonly stderr?: string;
      readonly exitCode?: number;
    }>;
  };
  readonly files: {
    readonly write: (
      path: string,
      content: string | ArrayBuffer,
    ) => Promise<unknown>;
  };
}

/**
 * A provider's raw workspace. Core runs the activation pipeline over it
 * ([`activation.ts`](../../execution/activation.ts)): source preparation,
 * the `gh` wrapper, readiness, the daemon kick, and the environment,
 * Changes, and activity decoration.
 */
export interface ExecutionWorkspaceHandle {
  readonly guest: ExecutionGuest;
  /** The agent's Flue sandbox, rooted at the prepared source directory. */
  readonly sandbox: (cwd: string) => Promise<Sandbox>;
  /**
   * Moves the provider's idle deadline (E2B's sandbox timeout) to
   * `durationMs` from now. Core renews it while the workspace is in use.
   */
  readonly setIdleDeadline: (durationMs: number) => Promise<void>;
  /** How long an idle workspace stays up; Core's default when undefined. */
  readonly inactivityMs?: number;
  /**
   * When the workspace's processes last started (epoch ms), reported only by
   * a provider whose pause and resume restart them (`preserves:
   * "filesystem"`). A Terminal shell that was ready before this time died
   * with the workspace, not on its own.
   */
  readonly processesStartedAt?: number;
  /** Default limit for one agent command. */
  readonly commandTimeoutMs: number;
  /**
   * Only the local development runtime: it prepares source against its own
   * fixture remote instead of the brokered source runtime, so Core installs
   * no `gh` wrapper and keeps scratch Threads out of Changes.
   */
  readonly development?: {
    readonly source: () => Promise<SourceWorkspaceRuntimeOptions>;
  };
}

/** `execution.workspace`: every provider implements it. */
export interface ExecutionWorkspaceProvider<
  Handle extends ExecutionWorkspaceHandle = ExecutionWorkspaceHandle,
> {
  /**
   * The owner's workspace: created on its first activation and returned
   * again afterwards, so it is fixed for the owner's lifetime.
   */
  create(
    context: ExecutionContext,
    owner: ExecutionWorkspaceOwner,
    options: ExecutionWorkspaceCreateOptions,
  ): Promise<Handle>;
  /** Reconnects to the owner's existing workspace; never creates one. */
  connect(
    context: ExecutionContext,
    owner: ExecutionWorkspaceOwner,
    options: ExecutionWorkspaceOpenOptions,
  ): Promise<Handle>;
  /**
   * Core has drained the resident daemon. `archive`: release what the
   * workspace holds; a provider claiming `execution.pause-resume` pauses it
   * so the next activation resumes it. `destroy`: remove the workspace for
   * good.
   */
  release(
    context: ExecutionContext,
    owner: ExecutionWorkspaceOwner,
    mode: "archive" | "destroy",
  ): Promise<void>;
}

export interface DaemonInstallInput {
  readonly threadId: ThreadId;
  readonly endpoint: string;
  readonly signal?: AbortSignal;
  readonly credential?: DaemonCredential;
  readonly mintCredential: () => Promise<DaemonCredential>;
}

/** What one bootstrap did, for Core's installation timing log. */
export interface DaemonInstallOutcome {
  readonly releaseLoadedAt?: number;
  readonly guest?: string;
}

/**
 * `execution.resident-daemon`: install and start dxd in a prepared
 * workspace when it did not register on its own. The dxd protocol, the
 * Thread execution object, and the registration wait stay core.
 */
export interface ExecutionResidentDaemonProvider<
  Handle extends ExecutionWorkspaceHandle = ExecutionWorkspaceHandle,
> {
  install(
    context: ExecutionContext,
    handle: Handle,
    input: DaemonInstallInput,
  ): Promise<DaemonInstallOutcome>;
}

export interface ExecutionProvider<
  Handle extends ExecutionWorkspaceHandle = ExecutionWorkspaceHandle,
> {
  readonly workspace: ExecutionWorkspaceProvider<Handle>;
  readonly residentDaemon?: ExecutionResidentDaemonProvider<Handle>;
}

/**
 * Core's activation pipeline over one provider's raw handles. Composition
 * gates the daemon operations by capability before calling them.
 */
export interface ExecutionActivation {
  readonly activate: (
    context: ExecutionContext,
    request: SandboxRequest,
  ) => Promise<FlueSandbox>;
  readonly reconnect: (
    context: ExecutionContext,
    request: SandboxRequest,
  ) => Promise<FlueSandbox>;
  readonly ensureDaemon: (
    context: ExecutionContext,
    input: EnsureDaemonInput,
  ) => Promise<DaemonInstallation>;
  /**
   * Terminal input renews the workspace's idle deadline. It runs on every
   * input batch, so the context is loaded only when the workspace must be
   * reached.
   */
  readonly recordResidentTerminalInput: (
    loadContext: () => Promise<ExecutionContext>,
    threadId: ThreadId,
  ) => Promise<void>;
  /** In-memory activity bookkeeping; reaches no provider API. */
  readonly recordResidentTerminalHeartbeat: (
    threadId: ThreadId,
    foregroundCommand: boolean | undefined,
  ) => void;
}

export type ExecutionActivationFactory = (
  provider: ExecutionProvider,
) => ExecutionActivation;

export class ExecutionProviderUnavailable extends Schema.TaggedError<ExecutionProviderUnavailable>()(
  "ExecutionProviderUnavailable",
  {},
) {}

/**
 * The Thread's pinned credential no longer resolves to its pinned account:
 * the key was removed, policy now denies it, the key belongs to another
 * account, or the owner left the workspace. Never retried on another key.
 */
export class ExecutionCredentialUnavailable extends Schema.TaggedError<ExecutionCredentialUnavailable>()(
  "ExecutionCredentialUnavailable",
  {
    reason: Schema.Literals([
      "removed",
      "policy-denied",
      "account-changed",
      "not-a-member",
      "local-runtime",
    ]),
  },
) {}

export class ExecutionCapabilityUnavailable extends Schema.TaggedError<ExecutionCapabilityUnavailable>()(
  "ExecutionCapabilityUnavailable",
  { capability: Schema.String },
) {}

const isExecutionProviderId = (
  providerId: PluginProviderId,
): providerId is ExecutionProviderId =>
  providerId === "e2b" || providerId === "cloudflare" || providerId === "local";

export interface ResolvedExecutionProvider {
  readonly providerId: ExecutionProviderId;
  readonly capabilities: ReadonlyArray<ExecutionCapabilityId>;
  /** What `execution.pause-resume` keeps, when the provider claims it. */
  readonly pauseResumePreserves?: ExecutionPauseResumePreserves;
}

/**
 * The deployment's Execution providers, from bindings: E2B when
 * `E2B_API_KEY` is set and Cloudflare Containers when the `ORB_CONTAINER`
 * namespace is bound (both may be), or the local runtime in development.
 * Empty when none resolves; readiness then fails closed.
 */
export const resolveExecutionProviders = (
  bindings: Bindings,
): ReadonlyArray<ResolvedExecutionProvider> => {
  const plugin = findPlugin("execution");
  if (plugin === undefined) return [];
  return deploymentProviders(plugin, bindings).flatMap((providerId) => {
    if (!isExecutionProviderId(providerId)) return [];
    const capabilities = providerCapabilities(plugin, providerId).filter(
      (capability): capability is ExecutionCapabilityId =>
        capability.startsWith("execution."),
    );
    if (!capabilities.includes("execution.workspace")) return [];
    const preserves = findProvider(plugin, providerId)?.pauseResumePreserves;
    return [
      {
        providerId,
        capabilities,
        ...(preserves === undefined ||
        !capabilities.includes("execution.pause-resume")
          ? {}
          : { pauseResumePreserves: preserves }),
      },
    ];
  });
};

/**
 * A runner profile is an Execution configuration: its adapter names the
 * provider, and it may rely only on capabilities that provider claims.
 */
export const providerServesProfile = (
  provider: ResolvedExecutionProvider,
  profile: Pick<RunnerProfile, "adapter" | "capabilities">,
): boolean => {
  if (profile.adapter !== provider.providerId) return false;
  const required = executionCapabilitiesForRunnerProfile(profile.capabilities);
  return (
    required?.every((capability) =>
      provider.capabilities.includes(capability),
    ) ?? false
  );
};

/**
 * What Core uses: the deployment's providers, each gated by what it
 * implements. Every operation dispatches to the provider the Thread's runner
 * profile names.
 */
export interface ExecutionWorkspaces {
  readonly providers: ReadonlyArray<ResolvedExecutionProvider>;
  readonly sandboxFactory: SandboxFactory;
  readonly existingSandboxFactory: SandboxFactory;
  /** Thread archived: drain dxd, then release the workspace. */
  readonly archive: (threadId: ThreadId) => Promise<void>;
  /** Thread deleted: drain dxd, then destroy the workspace. */
  readonly destroy: (threadId: ThreadId) => Promise<void>;
  readonly ensureDaemon: (
    input: EnsureDaemonInput,
  ) => Promise<DaemonInstallation>;
  readonly recordResidentTerminalInput: (threadId: ThreadId) => Promise<void>;
  readonly recordResidentTerminalHeartbeat: (
    threadId: ThreadId,
    foregroundCommand: boolean | undefined,
  ) => void;
}

/** What one D1 read per operation resolves for a Thread. */
export interface ExecutionTarget {
  readonly profile: ExecutionProfile;
  readonly credential: ExecutionTargetCredential;
}

/**
 * Loads a Thread's runner profile and pinned credential in one D1 read;
 * releasing skips admission.
 */
export type ExecutionTargetResolver = (
  bindings: Bindings,
  threadId: string,
  options: { readonly admission: boolean },
) => Promise<ExecutionTarget>;

const executionTarget: ExecutionTargetResolver = (
  bindings,
  threadId,
  options,
) => Effect.runPromise(resolveExecutionTarget(bindings, threadId, options));

const skippedRelease = (
  threadId: string,
  entry: { readonly provider: ResolvedExecutionProvider },
  mode: "archive" | "destroy",
  reason: ExecutionCredentialUnavailableReason,
) =>
  orbProvidersLogger.warn("Execution workspace release skipped.", {
    event: "execution_release_skipped",
    threadId,
    provider: entry.provider.providerId,
    mode,
    reason,
  });

/** Capabilities with operations; the rest exist only as reserved IDs. */
const implementedCapabilities = (
  implementation: ExecutionProvider,
): ReadonlyArray<ExecutionCapabilityId> => [
  "execution.workspace",
  "execution.pause-resume",
  ...(implementation.residentDaemon === undefined
    ? []
    : (["execution.resident-daemon"] as const)),
];

/**
 * Composes the resolved providers into what Core uses: Core's activation
 * pipeline over each provider's raw handles. Core resolves the context
 * (deployment account, key, the Thread's runner profile) once per operation
 * and dispatches to the provider the profile names, so the provider never
 * chooses an account and a Thread never changes provider. A profile on a
 * provider that does not resolve, or no provider at all, fails closed. A
 * capability the provider does not both claim and implement is unavailable.
 * There is no fallback to another provider.
 */
export const composeExecutionWorkspaces = (
  bindings: Bindings,
  providers: Readonly<Partial<Record<ExecutionProviderId, ExecutionProvider>>>,
  activation: ExecutionActivationFactory,
  resolved: ReadonlyArray<ResolvedExecutionProvider> = resolveExecutionProviders(
    bindings,
  ),
  resolveTarget: ExecutionTargetResolver = executionTarget,
): ExecutionWorkspaces => {
  const plugin = findPlugin("execution");
  const entries = new Map(
    resolved.flatMap((provider) => {
      const implementation = providers[provider.providerId];
      if (implementation === undefined) return [];
      const implemented = implementedCapabilities(implementation);
      const capabilities = provider.capabilities.filter((capability) =>
        implemented.includes(capability),
      );
      const residentDaemon = capabilities.includes("execution.resident-daemon");
      const secret =
        plugin === undefined
          ? undefined
          : findProvider(plugin, provider.providerId)?.deploymentSecret;
      return [
        [
          provider.providerId,
          {
            provider: { ...provider, capabilities },
            implementation,
            residentDaemon,
            secret,
            pipeline: activation(
              residentDaemon
                ? implementation
                : { workspace: implementation.workspace },
            ),
          },
        ] as const,
      ];
    }),
  );
  if (entries.size === 0) {
    const unavailable = () =>
      Promise.reject(new ExecutionProviderUnavailable());
    return {
      providers: [],
      sandboxFactory: {
        createSandbox: unavailable,
        tools: executionWorkspaceTools,
      },
      existingSandboxFactory: {
        createSandbox: unavailable,
        tools: executionWorkspaceTools,
      },
      archive: unavailable,
      destroy: unavailable,
      ensureDaemon: unavailable,
      recordResidentTerminalInput: unavailable,
      recordResidentTerminalHeartbeat: () => {},
    };
  }
  type Entry = typeof entries extends Map<unknown, infer Value> ? Value : never;
  // A Thread's provider never changes, so the provider a context named is
  // remembered for terminal input, which must not load a context per batch.
  const threadProviders = new Map<string, Entry>();
  const resolve = async (threadId: string, admission: boolean) => {
    const target = await resolveTarget(bindings, threadId, { admission });
    const entry = entries.get(target.profile.adapter as ExecutionProviderId);
    if (entry === undefined) throw new ExecutionProviderUnavailable();
    threadProviders.set(threadId, entry);
    return { entry, target };
  };
  const contextFor = (
    entry: Entry,
    { profile, credential }: ExecutionTarget,
  ): ExecutionContext => {
    if (credential.scope === "unavailable")
      throw new ExecutionCredentialUnavailable({ reason: credential.reason });
    if (credential.scope === "deployment") {
      const key =
        entry.secret === undefined ? "" : (bindings[entry.secret] ?? "").trim();
      if (entry.secret !== undefined && key === "")
        throw new ExecutionProviderUnavailable();
      return {
        account: { scope: "deployment" },
        credential: key === "" ? undefined : Redacted.make(key),
        profile,
      };
    }
    // Only a key-based provider runs in a person's or workspace's account.
    if (entry.secret === undefined) throw new ExecutionProviderUnavailable();
    return {
      account:
        credential.scope === "personal"
          ? {
              scope: "personal",
              userId: credential.ownerId,
              providerAccount: credential.account,
            }
          : {
              scope: "workspace",
              workspaceId: credential.ownerId,
              providerAccount: credential.account,
            },
      credential: credential.key,
      profile,
    };
  };
  const context = async (
    threadId: string,
    admission: boolean,
  ): Promise<{ readonly context: ExecutionContext; readonly entry: Entry }> => {
    const { entry, target } = await resolve(threadId, admission);
    return { entry, context: contextFor(entry, target) };
  };
  const daemonUnavailable = () =>
    Promise.reject(
      new ExecutionCapabilityUnavailable({
        capability: "execution.resident-daemon",
      }),
    );
  const release = async (threadId: ThreadId, mode: "archive" | "destroy") => {
    const { entry, target } = await resolve(threadId, false);
    // Only a provider that hosts dxd can have a resident daemon to drain.
    // Draining is core (the Thread's execution object), so it runs even when
    // the provider credential is gone.
    if (entry.residentDaemon)
      await drainThreadDaemon(
        bindings,
        threadId,
        mode === "archive" ? "thread-archived" : "thread-deleted",
      );
    if (target.credential.scope === "unavailable") {
      // Releasing never fails for a missing key: the provider's own idle
      // timeout pauses the workspace (E2B does not bill paused sandboxes).
      skippedRelease(threadId, entry, mode, target.credential.reason);
      return;
    }
    await entry.implementation.workspace.release(
      contextFor(entry, target),
      { threadId },
      mode,
    );
  };
  const residentEntries = [...entries.values()].filter(
    ({ residentDaemon }) => residentDaemon,
  );
  return {
    providers: [...entries.values()].map(({ provider }) => provider),
    sandboxFactory: {
      createSandbox: async (request) => {
        const { context: resolvedContext, entry } = await context(
          request.id,
          true,
        );
        return entry.pipeline.activate(resolvedContext, request);
      },
      tools: executionWorkspaceTools,
    },
    existingSandboxFactory: {
      createSandbox: async (request) => {
        const { context: resolvedContext, entry } = await context(
          request.id,
          true,
        );
        return entry.pipeline.reconnect(resolvedContext, request);
      },
      tools: executionWorkspaceTools,
    },
    archive: (threadId) => release(threadId, "archive"),
    destroy: (threadId) => release(threadId, "destroy"),
    ensureDaemon:
      residentEntries.length === 0
        ? daemonUnavailable
        : async (input) => {
            const { context: resolvedContext, entry } = await context(
              input.threadId,
              true,
            );
            if (!entry.residentDaemon) return daemonUnavailable();
            const installation = await entry.pipeline.ensureDaemon(
              resolvedContext,
              input,
            );
            return { ...installation, provider: entry.provider.providerId };
          },
    recordResidentTerminalInput:
      residentEntries.length === 0
        ? daemonUnavailable
        : async (threadId) => {
            // Known (or the only daemon provider): the pipeline loads the
            // context only when it must reach the workspace.
            const known =
              threadProviders.get(threadId) ??
              (residentEntries.length === 1 ? residentEntries[0] : undefined);
            if (known !== undefined) {
              if (!known.residentDaemon) return daemonUnavailable();
              return known.pipeline.recordResidentTerminalInput(async () => {
                const loaded = await context(threadId, true);
                if (loaded.entry !== known)
                  throw new ExecutionProviderUnavailable();
                return loaded.context;
              }, threadId);
            }
            const loaded = await context(threadId, true);
            if (!loaded.entry.residentDaemon) return daemonUnavailable();
            return loaded.entry.pipeline.recordResidentTerminalInput(
              async () => loaded.context,
              threadId,
            );
          },
    // In-memory bookkeeping shared by every pipeline; reaches no provider.
    recordResidentTerminalHeartbeat:
      residentEntries[0]?.pipeline.recordResidentTerminalHeartbeat ??
      (() => {}),
  };
};
