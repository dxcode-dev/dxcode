import { env } from "cloudflare:workers";
import type {
  FileStat,
  Sandbox,
  SandboxDriver,
  WorkspaceContextSnapshotResult,
} from "@flue/runtime";
import { sandboxFromDriver } from "@flue/runtime";
import { getLogger } from "@logtape/logtape";
import { Redacted } from "effect";
import { decodeBase64, encodeBase64 } from "../../encoding/base64.js";
import type { Bindings } from "../../http/types.js";
import type {
  DaemonCredential,
  ExecutionContext,
  ExecutionProvider,
  ExecutionWorkspaceHandle,
} from "../../plugins/execution/provider.js";
import { runnerCall } from "../../runners/client.js";
import {
  type RunnerOperation,
  RunnerOperationError,
} from "../../runners/protocol.js";

const logger = getLogger(["dx", "execution", "runner"]);

/** Core's guest paths; the runner maps `/home/user` to the Thread's folder. */
const RUNNER_WORKSPACE_CWD = "/home/user/workspace/repo";
/** One Thread's snapshot in R2 while it is archived on its machine. */
export const runnerArchiveKey = (threadId: string) =>
  `runner-archives/${threadId}.json`;
export const runnerArchivePath = (threadId: string) =>
  `/v1/runner/archives/${encodeURIComponent(threadId)}`;

const COMMAND_TIMEOUT_MS = 120_000;
/** Operations whose second run after a lost reply changes nothing. */
const REPEATABLE: ReadonlySet<RunnerOperation> = new Set([
  "ensure",
  "read",
  "write",
  "stat",
  "readdir",
  "mkdir",
  "daemon",
  "pause",
]);
/** A command's own limit, plus time for the reply to travel back. */
const replyGraceMs = 30_000;

const machineOf = (context: ExecutionContext): string => {
  const machine = (context.profile as { readonly machine?: unknown }).machine;
  if (typeof machine !== "string")
    throw new RunnerOperationError(
      "invalid",
      "This Thread names no runner machine.",
    );
  return machine;
};

const encodeBytes = (value: string | Uint8Array) =>
  encodeBase64(
    typeof value === "string" ? new TextEncoder().encode(value) : value,
  );

class RunnerSandboxDriver implements SandboxDriver {
  constructor(
    private readonly bindings: Bindings,
    private readonly machineId: string,
    private readonly threadId: string,
  ) {}

  async request<Result>(
    op: RunnerOperation,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Result> {
    const call = () =>
      runnerCall<Result>(
        this.bindings,
        this.machineId,
        op,
        this.threadId,
        body,
        timeoutMs,
      );
    try {
      return await call();
    } catch (error) {
      // A machine's connection resets now and then (Wi-Fi, sleep); it
      // redials within seconds, and the session waits for it. An operation
      // that is safe to repeat goes again once; a command never does.
      if (
        !(error instanceof RunnerOperationError) ||
        error.code !== "offline" ||
        !(REPEATABLE.has(op) || (op === "rm" && body.force === true))
      )
        throw error;
      return await call();
    }
  }

  // The Thread's folder lives on the person's machine; dx keeps no
  // workspace context snapshot of it.
  snapshotWorkspaceContext(): Promise<WorkspaceContextSnapshotResult> {
    return Promise.resolve({ kind: "declined" });
  }

  async readFile(path: string): Promise<string> {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await this.readFileBuffer(path),
    );
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const result = await this.request<{ readonly contents: string }>("read", {
      path,
    });
    return decodeBase64(result.contents);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.request("write", { path, contents: encodeBytes(content) });
  }

  async stat(path: string): Promise<FileStat> {
    const result = await this.request<{
      readonly file: boolean;
      readonly directory: boolean;
      readonly symlink: boolean;
    }>("stat", { path });
    return {
      isFile: result.file,
      isDirectory: result.directory,
      isSymbolicLink: result.symlink,
    };
  }

  async readdir(path: string): Promise<string[]> {
    const { entries } = await this.request<{
      readonly entries: ReadonlyArray<string | { readonly name: string }>;
    }>("readdir", { path });
    return entries.map((entry) =>
      typeof entry === "string" ? entry : entry.name,
    );
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.request("mkdir", {
      path,
      recursive: options?.recursive === true,
    });
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    await this.request("rm", {
      path,
      recursive: options?.recursive === true,
      force: options?.force === true,
    });
  }

  exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
    return this.request(
      "exec",
      {
        command,
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options?.env === undefined ? {} : { env: options.env }),
        timeoutMs,
      },
      timeoutMs + replyGraceMs,
    );
  }
}

const runnerGuest = (sandbox: Sandbox) => ({
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

const archived = async (bindings: Bindings, threadId: string) =>
  (await bindings.DX_STORAGE?.head(runnerArchiveKey(threadId))) != null;

const openRunnerWorkspace = async (
  context: ExecutionContext,
  threadId: string,
  existingOnly: boolean,
): Promise<ExecutionWorkspaceHandle> => {
  const bindings = env as Bindings;
  const machineId = machineOf(context);
  const driver = new RunnerSandboxDriver(bindings, machineId, threadId);
  // As the local runtime: a new Thread gets its home, and the source
  // program clones into a workspace/repo it creates itself.
  const ensure = (restore: boolean) =>
    driver.request(
      "ensure",
      {
        existingOnly,
        prepareSourceWorkspace: !existingOnly,
        ...(restore ? { restore: { path: runnerArchivePath(threadId) } } : {}),
      },
      10 * 60_000,
    );
  // An archived Thread's folder was deleted on its machine; its snapshot in
  // R2 brings it back, on reconnect (Files after unarchiving) as on a run,
  // as resuming a paused Orb would.
  if (!existingOnly) await ensure(await archived(bindings, threadId));
  else
    await ensure(false).catch(async (error: unknown) => {
      if (
        !(error instanceof RunnerOperationError) ||
        error.code !== "not-found" ||
        !(await archived(bindings, threadId))
      )
        throw error;
      await ensure(true);
    });
  const sandbox = sandboxFromDriver(driver, RUNNER_WORKSPACE_CWD);
  return {
    guest: runnerGuest(sandbox),
    sandbox: async () => sandbox,
    // A person's machine has no idle deadline: it never sleeps on dx's say.
    setIdleDeadline: async () => undefined,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
    hostMachine: true,
  };
};

/**
 * Orb provider `runner`: a person's own Mac or Linux machine. `dxd runner`
 * there holds a connection to the machine's {@link RunnerSessionObject}
 * and serves each Thread's folder under `~/.dx/threads`. Archiving saves a
 * git snapshot of the folder to R2 and deletes it on the machine; the next
 * activation restores it. A machine that is offline when its Thread is
 * archived keeps the folder.
 */
export const runnerExecutionProvider: ExecutionProvider = {
  workspace: {
    create: (context, { threadId }) =>
      openRunnerWorkspace(context, threadId, false),
    connect: (context, { threadId }) =>
      openRunnerWorkspace(context, threadId, true),
    async release(context, { threadId }, mode) {
      const bindings = env as Bindings;
      const machineId = machineOf(context);
      try {
        if (mode === "destroy") {
          await runnerCall(bindings, machineId, "destroy", threadId, {});
          await bindings.DX_STORAGE?.delete(runnerArchiveKey(threadId));
          return;
        }
        await runnerCall(
          bindings,
          machineId,
          "archive",
          threadId,
          { uploadPath: runnerArchivePath(threadId) },
          10 * 60_000,
        );
        await runnerCall(bindings, machineId, "pause", threadId, {});
      } catch (cause) {
        const error = RunnerOperationError.from(cause);
        // Archive never waits on a machine that is away: its folder stays,
        // and the Thread picks it up again when it comes back.
        if (error.code === "offline" || error.code === "not-found") {
          logger.info("Runner release skipped.", {
            event: "runner_release_skipped",
            threadId,
            machineId,
            mode,
            code: error.code,
          });
          if (mode === "destroy")
            await bindings.DX_STORAGE?.delete(runnerArchiveKey(threadId));
          return;
        }
        throw error;
      }
    },
  },
  residentDaemon: {
    async install(context, _handle, input) {
      const bindings = env as Bindings;
      const machineId = machineOf(context);
      const request = (credential: DaemonCredential | undefined) =>
        runnerCall<{ readonly status: "running" | "credential-required" }>(
          bindings,
          machineId,
          "daemon",
          input.threadId,
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
        throw new Error("The runner could not start the Thread's daemon.");
      return {};
    },
  },
};
