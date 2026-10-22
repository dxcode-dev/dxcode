// flue-blueprint: sandbox/e2b@1
// Based on Flue 2.0.7 and extended with its patched workspace-context seam:
// https://github.com/withastro/flue/blob/@flue/runtime@2.0.7/blueprints/sandbox--e2b.md
/**
 * E2B adapter for Flue.
 *
 * Wraps an already-initialized E2B sandbox into Flue's SandboxFactory
 * interface. The user creates and configures the sandbox using the E2B
 * SDK directly — Flue just adapts it.
 */

import type {
  FileStat,
  Sandbox,
  SandboxDriver,
  SandboxFactory,
  WorkspaceContextSnapshotResult,
} from "@flue/runtime";
import {
  SandboxOperationUnsupportedError,
  sandboxFromDriver,
} from "@flue/runtime";
import type { Sandbox as E2BSandbox } from "e2b";
import { SandboxNotFoundError, TimeoutError } from "e2b";
import { executionWorkspaceTools } from "../../plugins/execution/tools.js";
import {
  decodeWorkspaceContextSnapshot,
  WORKSPACE_CONTEXT_TIMEOUT_MS,
  workspaceContextCommand,
} from "../workspace-context.js";

/**
 * A paused sandbox refuses envd traffic before the operation runs: a command
 * fails with `SandboxNotFoundError` before it starts, and a file operation
 * with E2B's "sandbox timeout" `TimeoutError` (HTTP 502). A command whose
 * stream breaks mid-run fails with that `TimeoutError` too, but it may have
 * run, so only file operations treat it as paused.
 */
const refusedWhilePaused = (error: unknown, kind: "command" | "file") =>
  // By name, not class: the SDK ships ESM and CommonJS builds, and an error
  // from the other build fails \`instanceof\`.
  error instanceof Error &&
  (error.name === SandboxNotFoundError.name ||
    (kind === "file" &&
      error.name === TimeoutError.name &&
      error.message.includes("sandbox timeout")));

/** Implements SandboxDriver by wrapping the E2B v2 TypeScript SDK. */
class E2BSandboxDriver implements SandboxDriver {
  #resuming: Promise<void> | undefined;

  constructor(
    private sandbox: E2BSandbox,
    private resume?: () => Promise<void>,
  ) {}

  /**
   * Runs one operation; when the sandbox refused it because it is paused,
   * resumes that same sandbox and runs the operation once more. The handle
   * stays valid across a resume. Concurrent refusals share one resume.
   */
  async #run<A>(kind: "command" | "file", operation: () => Promise<A>) {
    try {
      return await operation();
    } catch (error) {
      if (this.resume === undefined || !refusedWhilePaused(error, kind))
        throw error;
      this.#resuming ??= this.resume().finally(() => {
        this.#resuming = undefined;
      });
      await this.#resuming;
      return operation();
    }
  }

  async snapshotWorkspaceContext(
    root: string,
  ): Promise<WorkspaceContextSnapshotResult> {
    const result = await this.#run("command", () =>
      this.sandbox.commands.run(workspaceContextCommand, {
        envs: { FLUE_WORKSPACE_CONTEXT_ROOT: root },
        timeoutMs: WORKSPACE_CONTEXT_TIMEOUT_MS,
      }),
    );
    if (result.exitCode !== 0)
      throw new Error("E2B workspace-context operation failed.");
    return decodeWorkspaceContextSnapshot(result.stdout ?? "");
  }

  async readFile(path: string): Promise<string> {
    return this.#run("file", () => this.sandbox.files.read(path));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return this.#run("file", () =>
      this.sandbox.files.read(path, { format: "bytes" }),
    );
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    if (typeof content === "string") {
      await this.#run("file", () => this.sandbox.files.write(path, content));
    } else {
      const ab = content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer;
      await this.#run("file", () => this.sandbox.files.write(path, ab));
    }
  }

  async stat(path: string): Promise<FileStat> {
    const info = await this.#run("file", () =>
      this.sandbox.files.getInfo(path),
    );
    const isDirectory = info.type === "dir";
    return {
      isFile: info.type === "file",
      isDirectory,
      isSymbolicLink:
        typeof info.symlinkTarget === "string" && info.symlinkTarget.length > 0,
    };
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.#run("file", () =>
      this.sandbox.files.list(path),
    );
    return entries.map((entry) => entry.name);
  }

  async exists(path: string): Promise<boolean> {
    return this.#run("file", () => this.sandbox.files.exists(path));
  }

  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    await this.#run("file", () => this.sandbox.files.makeDir(path));
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    const unsupported = [
      options?.recursive ? "recursive" : undefined,
      options?.force ? "force" : undefined,
    ].filter((option): option is string => option !== undefined);
    if (unsupported.length > 0) {
      throw new SandboxOperationUnsupportedError({
        operation: "rm",
        provider: "E2B",
        options: unsupported,
      });
    }
    await this.#run("file", () => this.sandbox.files.remove(path));
  }

  async exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await this.#run("command", () =>
      this.sandbox.commands.run(command, {
        cwd: options?.cwd,
        envs: options?.env,
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
      }),
    );
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
    };
  }
}

/**
 * Create a Flue sandbox factory from an initialized E2B sandbox. `resume`
 * wakes that same sandbox when it refuses an operation because it is paused.
 */
export function e2b(
  sandbox: E2BSandbox,
  sandboxCwd = "/home/user",
  resume?: () => Promise<void>,
): SandboxFactory {
  return {
    async createSandbox(): Promise<Sandbox> {
      const driver = new E2BSandboxDriver(sandbox, resume);
      return sandboxFromDriver(driver, sandboxCwd);
    },
    tools: executionWorkspaceTools,
  };
}
