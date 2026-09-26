import { runInNewContext } from "node:vm";
import type { SourceWorkspaceRecord } from "@dx/domain";
import type { Sandbox, SandboxFactory } from "@flue/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  classifySourceCommand,
  withSourceCommandAdmission,
} from "./source-command-admission.js";

const source = {
  actorUserId: "user-117",
  snapshot: {
    provider: "github",
    providerRepositoryId: "7117",
    repositoryName: "owner/repository",
    cloneUrl: "https://github.com/owner/repository.git",
  },
  privateSubmodules: [],
} as unknown as SourceWorkspaceRecord;
const projectlessSource = {
  ...source,
  snapshot: undefined,
} as SourceWorkspaceRecord;

const factory = (exec: Sandbox["exec"]): SandboxFactory => ({
  createSandbox: async () =>
    ({
      cwd: "/home/user/workspace/repo",
      exec,
    }) as Sandbox,
});

describe("source command admission", () => {
  it.each([
    "",
    "oauth_token: secret",
    "authorization = secret",
    "https://secret@github.com/owner/repo",
  ])("executes the generated residue check against %s", async (contents) => {
    let checked = false;
    const exec = vi.fn(async (command: string) => {
      if (command.startsWith("node -e '")) {
        checked = true;
        const exit = vi.fn();
        runInNewContext(command.slice(9, -1), {
          require: (name: string) =>
            name === "node:fs"
              ? {
                  existsSync: (path: string) => path.endsWith(".git/config"),
                  readFileSync: () => contents,
                }
              : { join: (...parts: string[]) => parts.join("/") },
          process: { cwd: () => "/repo", exit },
        });
        expect(exit.mock.calls).toEqual(contents ? [[41]] : []);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const sandbox = await withSourceCommandAdmission(
      factory(exec),
      async () => source,
      async (_thread, _source, _request, callback) => callback({}),
    ).createSandbox({ id: "thread-117" });
    await sandbox.exec("gh repo view");
    expect(checked).toBe(true);
  });

  it("leaves all Git grammar to Git and admits bounded gh reads", () => {
    for (const command of [
      "git fetch --prune origin",
      "command git fetch origin",
      "command git commit -m signed",
      "git fetch https://attacker.invalid/repo",
      "git ls-remote origin refs/heads/main",
      "git fetch origin; env",
      "git commit -m 'signed change'",
      "git commit -am 'bypass staging'",
      "git -c user.name=attacker commit -m bypass",
      "git push -u origin feature",
      "git push --force origin main",
    ])
      expect(classifySourceCommand(command)).toEqual({ kind: "none" });
    expect(classifySourceCommand("gh pr checks 12")).toMatchObject({
      kind: "read",
      request: { operation: "checks-status-read" },
    });
    expect(classifySourceCommand("gh auth status")).toMatchObject({
      kind: "read",
      request: { operation: "provider-auth-read" },
    });
    expect(classifySourceCommand("gh auth login")).toEqual({
      kind: "denied",
      reason: "persistent-auth-disabled",
    });
    expect(
      classifySourceCommand("gh auth status --hostname=evil.test"),
    ).toEqual({
      kind: "denied",
      reason: "unsupported-auth-command",
    });
    for (const command of [
      "gh auth status --show-token",
      "gh auth status -t",
      "gh auth status --show-token --json hosts --template token",
    ])
      expect(classifySourceCommand(command)).toEqual({
        kind: "denied",
        reason: "unsupported-auth-command",
      });
    expect(classifySourceCommand("gh repo view owner/other-repo")).toEqual({
      kind: "denied",
      reason: "use-semantic-source-tool",
    });
    for (const command of [
      "gh pr view owner/other-repo",
      "gh issue view owner/other-repo",
      "gh run view owner/other-repo",
    ])
      expect(classifySourceCommand(command)).toEqual({
        kind: "denied",
        reason: "use-semantic-source-tool",
      });
    expect(
      classifySourceCommand("gh pr view https://github.com/other/repo/pull/1"),
    ).toEqual({ kind: "denied", reason: "arbitrary-repository" });
    expect(classifySourceCommand("gh pr view 1 --hostname=evil.test")).toEqual({
      kind: "denied",
      reason: "arbitrary-host",
    });
    expect(classifySourceCommand("gh api graphql")).toEqual({
      kind: "denied",
      reason: "raw-api-disabled",
    });
    expect(classifySourceCommand("gh pr create")).toEqual({
      kind: "denied",
      reason: "use-semantic-source-tool",
    });
  });

  it("runs a model Git commit as a native Bash command", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const admitted = withSourceCommandAdmission(
      factory(exec),
      async () => source,
      async (_thread, _source, _request, callback) => callback({}),
    );
    const activityWrapped: SandboxFactory = {
      async createSandbox(request) {
        const sandbox = await admitted.createSandbox(request);
        return {
          ...sandbox,
          exec: async (command, options) =>
            Promise.resolve().then(() => sandbox.exec(command, options)),
        };
      },
    };
    const sandbox = await activityWrapped.createSandbox({ id: "thread-117" });
    await expect(
      sandbox.exec("git commit -m 'exact message'"),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(exec).toHaveBeenCalledWith("git commit -m 'exact message'", {
      env: {
        GIT_CONFIG_GLOBAL: "/home/user/.local/state/dx-terminal/gitconfig",
      },
    });
  });

  it("runs projectless Git commits natively while denying provider commands", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const sandbox = await withSourceCommandAdmission(
      factory(exec),
      async () => projectlessSource,
      async (_thread, _source, _request, callback) => callback({}),
    ).createSandbox({ id: "thread-117" });

    await expect(
      sandbox.exec("git commit -m 'signed change'"),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(sandbox.exec("gh repo view")).rejects.toThrow(
      "source authority unavailable",
    );
    expect(exec).toHaveBeenCalledOnce();
  });

  it("merges protected lease variables after caller environment", async () => {
    const exec = vi.fn(async () => ({ stdout: "{}", stderr: "", exitCode: 0 }));
    const withLease = vi.fn(async (_thread, _source, _request, callback) =>
      callback({
        GH_TOKEN: "lease-token",
        GITHUB_TOKEN: "",
        GH_ENTERPRISE_TOKEN: "",
        GITHUB_ENTERPRISE_TOKEN: "",
        GH_DEBUG: "",
        GH_HOST: "github.com",
        GH_REPO: "owner/repository",
        GIT_CONFIG_PARAMETERS: "",
        GIT_PROXY_COMMAND: "",
        GIT_TRACE_CURL: "",
        GIT_CURL_VERBOSE: "",
        GIT_TRACE_REDACT: "1",
      }),
    );
    const sandbox = await withSourceCommandAdmission(
      factory(exec),
      async () => source,
      withLease,
    ).createSandbox({ id: "thread-117" });

    await sandbox.exec("gh repo view", {
      env: {
        GH_TOKEN: "configured-token",
        GH_HOST: "attacker.invalid",
        GH_REPO: "other/repository",
        GITHUB_TOKEN: "fallback-token",
        GH_ENTERPRISE_TOKEN: "enterprise-token",
        GITHUB_ENTERPRISE_TOKEN: "enterprise-fallback-token",
        GH_DEBUG: "api",
        GIT_CONFIG_PARAMETERS: "'http.extraHeader=token'",
        GIT_PROXY_COMMAND: "exfiltrate",
        GIT_EXEC_PATH: "/tmp/fake-git-core",
        HTTPS_PROXY: "http://attacker.invalid",
        GIT_TRACE_CURL: "1",
        GIT_TRACE2_EVENT: "/tmp/git-trace",
        GIT_CURL_VERBOSE: "1",
      },
    });

    expect(exec).toHaveBeenNthCalledWith(
      1,
      "gh repo view",
      expect.objectContaining({
        env: expect.objectContaining({
          GH_TOKEN: "lease-token",
          GH_HOST: "github.com",
          GH_REPO: "owner/repository",
          GITHUB_TOKEN: "",
          GH_ENTERPRISE_TOKEN: "",
          GITHUB_ENTERPRISE_TOKEN: "",
          GH_DEBUG: "",
          GIT_CONFIG_PARAMETERS: "",
          GIT_PROXY_COMMAND: "",
          GIT_EXEC_PATH: "",
          HTTPS_PROXY: "",
          GIT_TRACE_CURL: "",
          GIT_TRACE2_EVENT: "",
          GIT_CURL_VERBOSE: "",
          GIT_TRACE_REDACT: "1",
        }),
      }),
    );
    expect(withLease).toHaveBeenCalledOnce();
  });

  it("keeps ordinary local Git commands writable without source authority or a lease", async () => {
    const exec = vi.fn(async () => ({
      stdout: " M README.md\n",
      stderr: "",
      exitCode: 0,
    }));
    const withLease = vi.fn();
    const sandbox = await withSourceCommandAdmission(
      factory(exec),
      async () => ({ ...source, authority: undefined }),
      withLease,
    ).createSandbox({ id: "thread-117" });

    for (const command of [
      "git status --short",
      "git diff",
      "git add README.md",
      "git branch feature",
    ])
      await expect(sandbox.exec(command)).resolves.toMatchObject({
        stdout: " M README.md\n",
        exitCode: 0,
      });
    expect(withLease).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(4);
    for (const [, options] of exec.mock.calls as unknown as Parameters<
      Sandbox["exec"]
    >[])
      expect(options).toEqual({
        env: {
          GIT_CONFIG_GLOBAL: "/home/user/.local/state/dx-terminal/gitconfig",
        },
      });
  });

  it("preserves the terminal Git config for model Bash without resolving authority", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const resolveSource = vi.fn(async () => source);
    const withLease = vi.fn();
    const sandbox = await withSourceCommandAdmission(
      factory(exec),
      resolveSource,
      withLease,
    ).createSandbox({ id: "thread-117" });

    const options = {
      cwd: "/home/user/workspace/repo",
      env: {
        GIT_CONFIG_GLOBAL: "/home/user/.local/state/dx-terminal/gitconfig",
      },
    };
    await sandbox.exec("git push origin topic", options);
    expect(exec).toHaveBeenCalledWith("git push origin topic", {
      ...options,
      env: {
        GIT_CONFIG_GLOBAL: "/home/user/.local/state/dx-terminal/gitconfig",
      },
    });
    expect(resolveSource).not.toHaveBeenCalled();
    expect(withLease).not.toHaveBeenCalled();
  });

  it("redacts the callback credential from results and failures and always finalizes", async () => {
    const token = "lease-token-echoed-by-process";
    const successExec = vi.fn(async (command: string) =>
      command.startsWith("node -e")
        ? { stdout: "", stderr: "", exitCode: 0 }
        : { stdout: `out:${token}`, stderr: `err:${token}`, exitCode: 0 },
    );
    const lease = async <A>(
      _thread: string,
      _source: SourceWorkspaceRecord,
      _request: unknown,
      callback: (environment: Readonly<Record<string, string>>) => Promise<A>,
    ) => callback({ GH_TOKEN: token });
    const successful = await withSourceCommandAdmission(
      factory(successExec),
      async () => source,
      lease,
    ).createSandbox({ id: "thread-117" });

    await expect(successful.exec("gh repo view")).resolves.toEqual({
      stdout: "out:[REDACTED]",
      stderr: "err:[REDACTED]",
      exitCode: 0,
    });
    expect(successExec).toHaveBeenCalledTimes(2);

    const nonzeroExec = vi.fn(async (command: string) =>
      command.startsWith("node -e")
        ? { stdout: "", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: `failed:${token}`, exitCode: 1 },
    );
    const nonzero = await withSourceCommandAdmission(
      factory(nonzeroExec),
      async () => source,
      lease,
    ).createSandbox({ id: "thread-117" });
    await expect(nonzero.exec("gh repo view")).resolves.toEqual({
      stdout: "",
      stderr: "failed:[REDACTED]",
      exitCode: 1,
    });
    expect(nonzeroExec).toHaveBeenCalledTimes(2);

    const failureExec = vi.fn(async (command: string) => {
      if (command.startsWith("node -e"))
        return { stdout: "", stderr: "", exitCode: 0 };
      throw new Error(`transport failed with ${token}`);
    });
    const failing = await withSourceCommandAdmission(
      factory(failureExec),
      async () => source,
      lease,
    ).createSandbox({ id: "thread-117" });
    const failure = await failing.exec("gh repo view").catch((cause) => cause);
    expect(String(failure)).toContain("[REDACTED]");
    expect(String(failure)).not.toContain(token);
    expect(failureExec).toHaveBeenCalledTimes(2);
  });

  it("removes configured GitHub credentials from unsupported commands", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const sandbox = await withSourceCommandAdmission(
      factory(exec),
      async () => source,
      vi.fn(),
    ).createSandbox({ id: "thread-117" });

    await sandbox.exec("env", {
      env: {
        GH_TOKEN: "configured-token",
        GITHUB_TOKEN: "fallback-token",
        GH_ENTERPRISE_TOKEN: "enterprise-token",
        GITHUB_ENTERPRISE_TOKEN: "enterprise-fallback-token",
        GH_DEBUG: "api",
        GIT_CONFIG_PARAMETERS: "'http.extraHeader=token'",
        GIT_PROXY_COMMAND: "exfiltrate",
        GIT_EXEC_PATH: "/tmp/fake-git-core",
        HTTPS_PROXY: "http://attacker.invalid",
        GIT_TRACE_CURL: "1",
        GIT_TRACE2_EVENT: "/tmp/git-trace",
        GIT_CURL_VERBOSE: "1",
      },
    });

    expect(exec).toHaveBeenCalledWith(
      "env",
      expect.objectContaining({
        env: expect.objectContaining({
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          GH_ENTERPRISE_TOKEN: "",
          GITHUB_ENTERPRISE_TOKEN: "",
          GH_DEBUG: "",
          GIT_CONFIG_PARAMETERS: "",
          GIT_PROXY_COMMAND: "",
          GIT_EXEC_PATH: "",
          HTTPS_PROXY: "",
          GIT_TRACE_CURL: "",
          GIT_TRACE2_EVENT: "",
          GIT_CURL_VERBOSE: "",
          GIT_TRACE_REDACT: "1",
        }),
      }),
    );
  });
});
