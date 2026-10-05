import { env } from "cloudflare:workers";
import { SourceControlProviderFailure } from "@dx/domain";
import type { Sandbox } from "@flue/runtime";
import { Effect, Redacted } from "effect";
import type { Bindings } from "../../http/types.js";
import type {
  DaemonCredential,
  ExecutionProvider,
  ExecutionWorkspaceHandle,
} from "../../plugins/execution/provider.js";
import { SourceRuntimeBroker } from "../../source-control/runtime.js";
import {
  createSourceWorkspaceProgram,
  type SourceWorkspaceProgramConfiguration,
} from "../../source-control/workspace-assets.js";
import { localSandboxFactory, requestLocalRuntime } from "./adapter.js";

const localSourceRuntimeBroker = SourceRuntimeBroker.of({
  withCommandEnvironment: () =>
    Effect.fail(
      new SourceControlProviderFailure({
        provider: "github",
        retryable: false,
      }),
    ),
});

/** The local runtime prepares source against its own fixture remote. */
const localSourceRuntime = async (bindings: Bindings, threadId: string) => ({
  broker: localSourceRuntimeBroker,
  verifyAssets: () => Effect.succeed({ assets: "stale" as const }),
  program: createSourceWorkspaceProgram(
    await requestLocalRuntime<SourceWorkspaceProgramConfiguration>(
      bindings,
      threadId,
      "source",
      {},
    ),
  ),
});

const localGuest = (sandbox: Sandbox) => ({
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
    write: (path: string, content: string | ArrayBuffer) =>
      sandbox.writeFile(
        path,
        typeof content === "string" ? content : new Uint8Array(content),
      ),
  },
});

const openLocalWorkspace = async (
  threadId: string,
  existingOnly: boolean,
): Promise<ExecutionWorkspaceHandle> => {
  const bindings = env as Bindings;
  const sandbox = await localSandboxFactory(
    bindings,
    existingOnly,
  ).createSandbox({ id: threadId });
  return {
    guest: localGuest(sandbox),
    // The local workspace is rooted at the source directory already.
    sandbox: async () => sandbox,
    // The local runtime has no idle deadline to renew.
    setIdleDeadline: async () => undefined,
    commandTimeoutMs: 120_000,
    development: { source: () => localSourceRuntime(bindings, threadId) },
  };
};

/**
 * Execution's development provider: the local workspace runtime. It has no
 * pause-resume: archiving stops the Thread's resident daemon process. It has
 * no delete operation either, so destroying also only stops the daemon and
 * the development workspace directory stays.
 */
export const localExecutionProvider: ExecutionProvider = {
  workspace: {
    create: (_context, { threadId }) => openLocalWorkspace(threadId, false),
    connect: (_context, { threadId }) => openLocalWorkspace(threadId, true),
    async release(_context, { threadId }) {
      await requestLocalRuntime(env as Bindings, threadId, "pause", {
        existingOnly: true,
      });
    },
  },
  residentDaemon: {
    async install(_context, _handle, input) {
      const request = (credential: DaemonCredential | undefined) =>
        requestLocalRuntime<{
          readonly status: "running" | "credential-required";
        }>(env as Bindings, input.threadId, "daemon", {
          existingOnly: true,
          endpoint: input.endpoint,
          ...(credential === undefined
            ? {}
            : { apiKey: Redacted.value(credential.key) }),
        });
      let result = await request(input.credential);
      if (result.status === "credential-required")
        result = await request(await input.mintCredential());
      if (result.status !== "running")
        throw new Error("Local daemon is unavailable.");
      return {};
    },
  },
};
