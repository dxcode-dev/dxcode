import type {
  FileStat,
  Sandbox,
  SandboxDriver,
  SandboxFactory,
  WorkspaceContextSnapshotResult,
} from "@flue/runtime";
import { sandboxFromDriver } from "@flue/runtime";
import { Redacted } from "effect";
import type { Bindings } from "../../http/types.js";

const LOCAL_WORKSPACE_CWD = "/home/user/workspace/repo";

interface LocalRuntimeRequirements {
  readonly url: string;
  readonly token: Redacted.Redacted<string>;
}

const requirements = (bindings: Bindings): LocalRuntimeRequirements => {
  const rawUrl = bindings.DX_LOCAL_RUNTIME_URL;
  const token = bindings.DX_LOCAL_RUNTIME_TOKEN;
  if (rawUrl === undefined || token === undefined || token.length < 32)
    throw new Error("Local workspace runtime is unavailable.");
  const url = new URL(rawUrl);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("Local workspace runtime is unavailable.");
  return { url: url.toString(), token: Redacted.make(token) };
};

export const validateLocalRuntimeConfiguration = (bindings: Bindings): void => {
  requirements(bindings);
};

const encodeBytes = (value: string | Uint8Array) => {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const decodeBytes = (value: string) => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

class LocalSandboxDriver implements SandboxDriver {
  constructor(
    private readonly threadId: string,
    private readonly runtime: LocalRuntimeRequirements,
  ) {}

  async request<Result>(
    operation: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Result> {
    const response = await fetch(
      new URL(
        `/v1/workspaces/${encodeURIComponent(this.threadId)}/${operation}`,
        this.runtime.url,
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${Redacted.value(this.runtime.token)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!response.ok) throw new Error("Local workspace operation failed.");
    return (await response.json()) as Result;
  }

  snapshotWorkspaceContext(
    root: string,
  ): Promise<WorkspaceContextSnapshotResult> {
    if (root !== LOCAL_WORKSPACE_CWD)
      return Promise.resolve({ kind: "declined" });
    return this.request("snapshot", {});
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
    return decodeBytes(result.contents);
  }

  writeFile(path: string, content: string | Uint8Array): Promise<void> {
    return this.request("write", { path, contents: encodeBytes(content) });
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
    return (
      await this.request<{ readonly entries: string[] }>("readdir", { path })
    ).entries;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.request("mkdir", {
      path,
      recursive: options?.recursive === true,
    });
  }

  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    return this.request("rm", {
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
    return this.request(
      "exec",
      {
        command,
        cwd: options?.cwd,
        env: options?.env,
        timeoutMs: options?.timeoutMs,
      },
      options?.signal,
    );
  }
}

export const localSandboxFactory = (
  bindings: Bindings,
  existingOnly = false,
): SandboxFactory => ({
  async createSandbox({ id }): Promise<Sandbox> {
    const runtime = requirements(bindings);
    const driver = new LocalSandboxDriver(id, runtime);
    await driver.request("ensure", {
      existingOnly,
      prepareSourceWorkspace: !existingOnly,
    });
    return sandboxFromDriver(driver, LOCAL_WORKSPACE_CWD);
  },
});

export const requestLocalRuntime = async <Result>(
  bindings: Bindings,
  threadId: string,
  operation: string,
  body: unknown,
): Promise<Result> => {
  const runtime = requirements(bindings);
  const response = await fetch(
    new URL(
      `/v1/workspaces/${encodeURIComponent(threadId)}/${operation}`,
      runtime.url,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${Redacted.value(runtime.token)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) throw new Error("Local workspace runtime is unavailable.");
  return (await response.json()) as Result;
};
