import type {
  FileStat,
  Sandbox,
  SandboxDriver,
  WorkspaceContextSnapshotResult,
} from "@flue/runtime";
import { sandboxFromDriver } from "@flue/runtime";
import type { ExecutionGuest } from "../../plugins/execution/provider.js";
import {
  decodeWorkspaceContextSnapshot,
  WORKSPACE_CONTEXT_TIMEOUT_MS,
  workspaceContextCommand,
} from "../workspace-context.js";
import type {
  OrbExecOptions,
  OrbExecResult,
  OrbFileStat,
} from "./orb-container.js";

/** The Orb container object's RPC surface, as Core calls it. */
export interface OrbContainerClient {
  exec(command: string, options?: OrbExecOptions): Promise<OrbExecResult>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  stat(path: string): Promise<OrbFileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  rm(
    path: string,
    options?: { readonly recursive?: boolean; readonly force?: boolean },
  ): Promise<void>;
}

const timedOut = (timeoutMs: number) =>
  new Error(`Command timed out after ${timeoutMs} ms.`);

/** Runs one command like E2B's `commands.run`: a timeout rejects. */
const run = async (
  client: OrbContainerClient,
  command: string,
  options: OrbExecOptions,
) => {
  const result = await client.exec(command, options);
  if (result.timedOut) throw timedOut(options.timeoutMs ?? 0);
  return result;
};

const bytes = (content: string | Uint8Array | ArrayBuffer) =>
  typeof content === "string"
    ? new TextEncoder().encode(content)
    : content instanceof Uint8Array
      ? content
      : new Uint8Array(content);

/**
 * Flue's `SandboxDriver` for a Cloudflare container: every operation is one
 * RPC to the Thread's Orb container object, which runs it with
 * `ctx.container.exec()`.
 */
class CloudflareSandboxDriver implements SandboxDriver {
  constructor(private readonly client: OrbContainerClient) {}

  async snapshotWorkspaceContext(
    root: string,
  ): Promise<WorkspaceContextSnapshotResult> {
    const result = await run(this.client, workspaceContextCommand, {
      env: { FLUE_WORKSPACE_CONTEXT_ROOT: root },
      timeoutMs: WORKSPACE_CONTEXT_TIMEOUT_MS,
    });
    if (result.exitCode !== 0)
      throw new Error("Cloudflare workspace-context operation failed.");
    return decodeWorkspaceContextSnapshot(result.stdout);
  }

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.client.readFile(path));
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    return this.client.readFile(path);
  }

  writeFile(path: string, content: string | Uint8Array): Promise<void> {
    return this.client.writeFile(path, bytes(content));
  }

  stat(path: string): Promise<FileStat> {
    return this.client.stat(path);
  }

  readdir(path: string): Promise<string[]> {
    return this.client.readdir(path);
  }

  exists(path: string): Promise<boolean> {
    return this.client.exists(path);
  }

  mkdir(path: string): Promise<void> {
    return this.client.mkdir(path);
  }

  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    return this.client.rm(path, {
      ...(options?.recursive === undefined
        ? {}
        : { recursive: options.recursive }),
      ...(options?.force === undefined ? {} : { force: options.force }),
    });
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
    // `signal` is Flue's to honor (sandboxFromDriver); the deadline is ours.
    const result = await run(this.client, command, {
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options?.env === undefined ? {} : { env: options.env }),
      ...(options?.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }
}

/** The agent's Flue sandbox over a Cloudflare container. */
export const cloudflareSandbox = (
  client: OrbContainerClient,
  cwd: string,
): Sandbox => sandboxFromDriver(new CloudflareSandboxDriver(client), cwd);

/** The raw guest Core's activation pipeline prepares. */
export const cloudflareGuest = (
  client: OrbContainerClient,
): ExecutionGuest & {
  readonly commands: {
    run(
      command: string,
      options?: {
        readonly cwd?: string;
        readonly envs?: Record<string, string>;
        readonly timeoutMs?: number;
      },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
} => ({
  commands: {
    run: async (command, options) => {
      const result = await run(client, command, {
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options?.envs === undefined ? {} : { env: options.envs }),
        ...(options?.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
  },
  files: {
    write: (path, content) => client.writeFile(path, bytes(content)),
  },
});
