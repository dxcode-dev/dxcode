import { runInNewContext } from "node:vm";
import type {
  SourceOperationRequestType,
  SourceWorkspaceRecord,
} from "@dx/domain";
import type { Sandbox, SandboxFactory } from "@flue/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  executeTrustedLocalCommand,
  executeTrustedSourceCommand,
  nativeCommandEnvironment,
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
const repositoryRead: SourceOperationRequestType = {
  operation: "repository-read",
  invocationSource: "agent-command",
};

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
    await executeTrustedSourceCommand(sandbox, "gh repo view", repositoryRead);
    expect(checked).toBe(true);
  });

  it("runs every agent command natively without parsing, authority, or a lease", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const resolveSource = vi.fn(async () => source);
    const withLease = vi.fn();
    const sandbox = await withSourceCommandAdmission(
      factory(exec),
      resolveSource,
      withLease,
    ).createSandbox({ id: "thread-117" });

    const commands = [
      "git push -u origin feature",
      "command git fetch origin",
      "cd /home/user/workspace/repo && git push origin topic",
      "gh pr create --fill",
      "gh api repos/owner/repository",
      "gh auth status",
      "npm run release",
    ];
    for (const command of commands)
      await expect(sandbox.exec(command)).resolves.toMatchObject({
        exitCode: 0,
      });
    expect(exec.mock.calls).toEqual(
      commands.map((command) => [command, { env: nativeCommandEnvironment }]),
    );
    expect(nativeCommandEnvironment).toEqual({
      PATH: "/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/home/user/.local/state/dx-terminal/gitconfig",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
    });
    expect(resolveSource).not.toHaveBeenCalled();
    expect(withLease).not.toHaveBeenCalled();
  });

  it("keeps the caller environment and applies only the dx Git configuration after it", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const sandbox = await withSourceCommandAdmission(
      factory(exec),
      async () => projectlessSource,
      vi.fn(),
    ).createSandbox({ id: "thread-117" });
    const options = {
      cwd: "/home/user/workspace/repo",
      env: {
        GH_TOKEN: "user-configured-token",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "url.https://user:token@git.example/.insteadOf",
        GIT_CONFIG_VALUE_0: "https://git.example/",
        GIT_CONFIG_GLOBAL: "/tmp/other",
        GIT_TERMINAL_PROMPT: "1",
      },
    };

    await sandbox.exec("git push origin topic", options);
    expect(exec).toHaveBeenCalledWith("git push origin topic", {
      ...options,
      env: { ...options.env, ...nativeCommandEnvironment },
    });
  });

  it("runs trusted local commands without authority or a native credential", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const withLease = vi.fn();
    const sandbox = await withSourceCommandAdmission(
      factory(exec),
      async () => source,
      withLease,
    ).createSandbox({ id: "thread-117" });

    await executeTrustedLocalCommand(sandbox, "git rev-parse HEAD");
    await executeTrustedLocalCommand(sandbox, "test -d .git");
    expect(exec).toHaveBeenNthCalledWith(1, "git rev-parse HEAD", {
      env: nativeCommandEnvironment,
    });
    expect(exec).toHaveBeenNthCalledWith(
      2,
      "test -d .git",
      expect.objectContaining({
        env: expect.objectContaining({
          GH_TOKEN: "",
          GIT_CONFIG_GLOBAL: "/dev/null",
        }),
      }),
    );
    expect(withLease).not.toHaveBeenCalled();
  });

  it("denies a trusted provider command without source authority", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const sandbox = await withSourceCommandAdmission(
      factory(exec),
      async () => projectlessSource,
      vi.fn(),
    ).createSandbox({ id: "thread-117" });

    await expect(
      executeTrustedSourceCommand(sandbox, "gh repo view", repositoryRead),
    ).rejects.toThrow("source authority unavailable");
    expect(exec).not.toHaveBeenCalled();
  });

  it("merges protected lease variables after caller environment for trusted provider commands", async () => {
    const exec = vi.fn(async () => ({ stdout: "{}", stderr: "", exitCode: 0 }));
    const withLease = vi.fn(async (_thread, _source, request, callback) => {
      expect(request).toEqual(repositoryRead);
      return callback({
        GH_TOKEN: "lease-token",
        GH_HOST: "github.com",
        GH_REPO: "owner/repository",
      });
    });
    const sandbox = await withSourceCommandAdmission(
      factory(exec),
      async () => source,
      withLease,
    ).createSandbox({ id: "thread-117" });

    await executeTrustedSourceCommand(sandbox, "gh repo view", repositoryRead, {
      env: {
        GH_TOKEN: "configured-token",
        GH_HOST: "attacker.invalid",
        GH_REPO: "other/repository",
        GITHUB_TOKEN: "fallback-token",
        GH_DEBUG: "api",
        GIT_CONFIG_PARAMETERS: "'http.extraHeader=token'",
        HTTPS_PROXY: "http://attacker.invalid",
        GIT_TRACE_CURL: "1",
      },
    });

    expect(exec).toHaveBeenNthCalledWith(
      1,
      "gh repo view",
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: "/usr/local/bin:/usr/bin:/bin",
          GH_TOKEN: "lease-token",
          GH_HOST: "github.com",
          GH_REPO: "owner/repository",
          GITHUB_TOKEN: "",
          GH_DEBUG: "",
          GIT_CONFIG_PARAMETERS: "",
          HTTPS_PROXY: "",
          GIT_TRACE_CURL: "",
          GIT_TRACE_REDACT: "1",
        }),
      }),
    );
    expect(withLease).toHaveBeenCalledOnce();
  });

  it("rejects a trusted command that changed before execution", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const inner = await withSourceCommandAdmission(
      factory(exec),
      async () => source,
      vi.fn(),
    ).createSandbox({ id: "thread-117" });
    const rewriting = {
      ...inner,
      exec: (command: string, options?: Parameters<Sandbox["exec"]>[1]) =>
        inner.exec(`${command} --repo other/repository`, options),
    } as Sandbox;

    await expect(
      executeTrustedSourceCommand(rewriting, "gh repo view", repositoryRead),
    ).rejects.toThrow("Trusted source command changed before execution.");
    expect(exec).not.toHaveBeenCalled();
  });

  it("redacts the callback credential from results and failures and always finalizes", async () => {
    const token = "lease-token-echoed-by-process";
    const lease = async <A>(
      _thread: string,
      _source: SourceWorkspaceRecord,
      _request: unknown,
      callback: (environment: Readonly<Record<string, string>>) => Promise<A>,
    ) => callback({ GH_TOKEN: token });
    const admitted = async (exec: Sandbox["exec"]) =>
      withSourceCommandAdmission(
        factory(exec),
        async () => source,
        lease,
      ).createSandbox({ id: "thread-117" });

    const successExec = vi.fn(async (command: string) =>
      command.startsWith("node -e")
        ? { stdout: "", stderr: "", exitCode: 0 }
        : { stdout: `out:${token}`, stderr: `err:${token}`, exitCode: 0 },
    );
    await expect(
      executeTrustedSourceCommand(
        await admitted(successExec),
        "gh repo view",
        repositoryRead,
      ),
    ).resolves.toEqual({
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
    await expect(
      executeTrustedSourceCommand(
        await admitted(nonzeroExec),
        "gh repo view",
        repositoryRead,
      ),
    ).resolves.toEqual({
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
    const failure = await executeTrustedSourceCommand(
      await admitted(failureExec),
      "gh repo view",
      repositoryRead,
    ).catch((cause) => cause);
    expect(String(failure)).toContain("[REDACTED]");
    expect(String(failure)).not.toContain(token);
    expect(failureExec).toHaveBeenCalledTimes(2);
  });
});
