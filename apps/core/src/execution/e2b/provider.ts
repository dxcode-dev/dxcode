import { env } from "cloudflare:workers";
import type { E2BRunnerProfileConfiguration } from "@dx/domain";
import type { Sandbox as E2BSandbox } from "e2b";
import { Effect } from "effect";
import type { Bindings } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import type {
  ExecutionContext,
  ExecutionProvider,
  ExecutionWorkspaceHandle,
} from "../../plugins/execution/provider.js";
import {
  recordRunnerUsage,
  runnerResourceAttribution,
} from "../../settings/usage/recorder.js";
import {
  assertThreadLifecycleState,
  atDaemonInstallationStage,
} from "../activation.js";
import {
  type DaemonGuest,
  ensureDaemonInGuest,
} from "../guest/daemon-installer.js";
import {
  loadDaemonRelease,
  loadDaemonReleaseMetadata,
} from "../guest/daemon-release.js";
import { e2b } from "./adapter.js";
import { loadE2BRequirements } from "./requirements.js";
import {
  connectExistingExecutionWorkspace,
  destroyExecutionWorkspace,
  type E2BResolverApi,
  type ExecutionWorkspaceResolution,
  makeConnectExistingExecutionWorkspace,
  makeD1ExecutionWorkspaceCoordinator,
  makeD1ExecutionWorkspaceStateStore,
  makeDestroyExecutionWorkspace,
  makePauseExecutionWorkspace,
  makeResolveExecutionWorkspace,
  pauseExecutionWorkspace,
  resolveExecutionWorkspace,
} from "./resolver.js";

/** An E2B sandbox as the raw workspace Core's pipeline prepares. */
interface E2BWorkspaceHandle extends ExecutionWorkspaceHandle {
  readonly guest: E2BSandbox & DaemonGuest;
}

const e2bProfile = (
  profile: ExecutionContext["profile"],
): E2BRunnerProfileConfiguration => {
  if (profile.adapter !== "e2b")
    throw new Error("E2B execution requires an E2B runner profile.");
  return profile;
};

/** E2B requirements for one operation, with the context's account key. */
const e2bRequirements = async (
  bindings: Bindings,
  context: ExecutionContext,
) => {
  const profile = e2bProfile(context.profile);
  if (context.credential === undefined)
    throw new Error("E2B execution requires an account key.");
  const requirements = await Effect.runPromise(
    loadE2BRequirements(bindings, profile.template),
  );
  return {
    profile,
    requirements: { ...requirements, apiKey: context.credential },
  };
};

const observeE2BResolution =
  (
    bindings: Bindings,
    id: string,
    profile: E2BRunnerProfileConfiguration,
    requirements: {
      readonly template: string;
      readonly timeoutMs: number;
    },
    credentialScope: ExecutionContext["account"]["scope"],
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
      // Who paid: deployment usage is dx-paid; personal and workspace keys
      // are paid by their owner (phase 5 prices it).
      credentialScope,
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

/**
 * Creates (or, after the first activation, reconnects to) the Thread's
 * sandbox, or only reconnects. Every resolution records a `runner` usage row.
 */
const openE2BWorkspace = async (
  resolvers: E2BResolvers,
  context: ExecutionContext,
  threadId: string,
  options: {
    readonly existingOnly: boolean;
    readonly authorize: () => Promise<void>;
    readonly observeResidency?: Parameters<
      typeof resolveExecutionWorkspace
    >[0]["observeResidency"];
  },
): Promise<E2BWorkspaceHandle> => {
  const bindings = env as Bindings;
  const { profile, requirements } = await e2bRequirements(bindings, context);
  const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
  const resolve = options.existingOnly
    ? resolvers.connectExisting
    : resolvers.resolve;
  const sandbox = await Effect.runPromise(
    resolve({
      id: threadId,
      requirements,
      stateStore: makeD1ExecutionWorkspaceStateStore(db),
      coordination: makeD1ExecutionWorkspaceCoordinator(db),
      authorizeResolution: options.authorize,
      observeResolution: observeE2BResolution(
        bindings,
        threadId,
        profile,
        requirements,
        context.account.scope,
      ),
      ...(options.observeResidency === undefined
        ? {}
        : { observeResidency: options.observeResidency }),
    }),
  );
  return {
    guest: sandbox,
    sandbox: (cwd) => e2b(sandbox, cwd).createSandbox({ id: threadId }),
    setIdleDeadline: (durationMs) => sandbox.setTimeout(durationMs),
    inactivityMs: requirements.inactivityMs,
    commandTimeoutMs: requirements.timeoutMs,
  };
};

interface E2BResolvers {
  readonly resolve: typeof resolveExecutionWorkspace;
  readonly connectExisting: typeof connectExistingExecutionWorkspace;
  readonly pause: typeof pauseExecutionWorkspace;
  readonly destroy: typeof destroyExecutionWorkspace;
}

const resolversFor = (api: E2BResolverApi | undefined): E2BResolvers =>
  api === undefined
    ? {
        resolve: (options) => resolveExecutionWorkspace(options),
        connectExisting: (options) =>
          connectExistingExecutionWorkspace(options),
        pause: (options) => pauseExecutionWorkspace(options),
        destroy: (options) => destroyExecutionWorkspace(options),
      }
    : {
        resolve: makeResolveExecutionWorkspace(api),
        connectExisting: makeConnectExistingExecutionWorkspace(api),
        pause: makePauseExecutionWorkspace(api),
        destroy: makeDestroyExecutionWorkspace(api),
      };

/**
 * The first Execution provider: E2B sandboxes. It claims
 * `execution.pause-resume` (processes and memory survive): archiving pauses
 * the sandbox, and destroying kills it. Tests pass a fake control-plane API.
 */
export const makeE2BExecutionProvider = (
  api?: E2BResolverApi,
): ExecutionProvider<E2BWorkspaceHandle> => {
  let memoized: E2BResolvers | undefined;
  const resolvers = () => {
    memoized ??= resolversFor(api);
    return memoized;
  };
  return {
    workspace: {
      create: (context, { threadId }, options) =>
        openE2BWorkspace(resolvers(), context, threadId, {
          existingOnly: false,
          authorize: options.authorize,
          observeResidency: options.observeResidency,
        }),
      connect: (context, { threadId }, options) =>
        openE2BWorkspace(resolvers(), context, threadId, {
          existingOnly: true,
          authorize: options.authorize,
        }),
      async release(context, { threadId }, mode) {
        const bindings = env as Bindings;
        const { requirements } = await e2bRequirements(bindings, context);
        const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
        const options = {
          id: threadId,
          requirements,
          stateStore: makeD1ExecutionWorkspaceStateStore(db),
          coordination: makeD1ExecutionWorkspaceCoordinator(db),
        };
        await Effect.runPromise(
          mode === "archive"
            ? resolvers().pause({
                ...options,
                authorizePause: () =>
                  assertThreadLifecycleState(db, threadId, "archived"),
              })
            : resolvers().destroy(options),
        );
      },
    },
    residentDaemon: {
      async install(_context, handle, input) {
        const bindings = env as Bindings;
        const release = await atDaemonInstallationStage(
          "release",
          loadDaemonReleaseMetadata(bindings),
        );
        let releaseLoadedAt: number | undefined;
        const guest = await ensureDaemonInGuest(handle.guest, {
          threadId: input.threadId,
          endpoint: input.endpoint,
          sha256: release.sha256,
          releaseUrl: release.url,
          credential: input.credential,
          mintCredential: input.mintCredential,
          loadBinary: async () => {
            const loaded = await atDaemonInstallationStage(
              "release",
              loadDaemonRelease(bindings),
            );
            releaseLoadedAt = Date.now();
            return loaded.binary;
          },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        return {
          guest,
          ...(releaseLoadedAt === undefined ? {} : { releaseLoadedAt }),
        };
      },
    },
  };
};

export const e2bExecutionProvider = makeE2BExecutionProvider();
