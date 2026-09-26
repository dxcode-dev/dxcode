import { exec as executeCommand } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  Sandbox as FlueSandbox,
  WorkspaceContextSnapshot,
} from "@flue/runtime";
import type { Sandbox as E2BSandbox } from "e2b";
import { describe, expect, it, vi } from "vitest";
import { e2b } from "./adapter.js";

const execute = promisify(executeCommand);

type CommandOptions = {
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const makeE2B = () => {
  const files = {
    read: vi.fn(async (_path: string, options?: { format?: string }) =>
      options?.format === "bytes" ? new Uint8Array([1, 2]) : "contents",
    ),
    write: vi.fn(async () => undefined),
    getInfo: vi.fn(async () => ({ type: "file" })),
    list: vi.fn(async () => [{ name: "one" }, { name: "two" }]),
    exists: vi.fn(async () => true),
    makeDir: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
  const commands = {
    run: vi.fn(async (_command: string, _options?: CommandOptions) => ({
      stdout: "out",
      stderr: "err",
      exitCode: 7,
    })),
  };
  return {
    value: { files, commands } as unknown as E2BSandbox,
    files,
    commands,
  };
};

const runGuestCommand = async (command: string, options?: CommandOptions) => {
  const result = await execute(command, {
    env: { ...process.env, ...options?.envs },
    maxBuffer: 8 * 1024 * 1024,
    timeout: options?.timeoutMs,
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
};

describe("Flue E2B 2.0.7 blueprint adapter", () => {
  it("uses /home/user as cwd and maps E2B-shaped file operations", async () => {
    const fake = makeE2B();
    const sandbox = await e2b(fake.value).createSandbox({ id: "test" });

    expect(sandbox.cwd).toBe("/home/user");
    await expect(sandbox.readFile("src/a.ts")).resolves.toBe("contents");
    await expect(sandbox.readFileBuffer("a.bin")).resolves.toEqual(
      new Uint8Array([1, 2]),
    );
    await expect(sandbox.readdir("src")).resolves.toEqual(["one", "two"]);
    await expect(sandbox.exists("src/a.ts")).resolves.toBe(true);
    await expect(sandbox.stat("src/a.ts")).resolves.toEqual({
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    });

    expect(fake.files.read).toHaveBeenNthCalledWith(1, "/home/user/src/a.ts");
    expect(fake.files.read).toHaveBeenNthCalledWith(2, "/home/user/a.bin", {
      format: "bytes",
    });
    expect(fake.files.list).toHaveBeenCalledWith("/home/user/src");
  });

  it("uses an explicitly provisioned source cwd", async () => {
    const fake = makeE2B();
    const sandbox = await e2b(
      fake.value,
      "/home/user/workspace/repo",
    ).createSandbox({ id: "test" });

    expect(sandbox.cwd).toBe("/home/user/workspace/repo");
  });

  it("returns one provider-neutral workspace-context snapshot in one bounded operation", async () => {
    const fake = makeE2B();
    const snapshot: WorkspaceContextSnapshot = {
      instructionFiles: { "AGENTS.md": "instructions" },
      skillFiles: [
        {
          kind: "file",
          directoryName: "review",
          content: "---\nname: review\ndescription: Review code\n---\nBody",
        },
      ],
      directoryListing: ["z-last", "a-first"],
    };
    fake.commands.run.mockResolvedValueOnce({
      stdout: JSON.stringify({ kind: "snapshot", version: 1, snapshot }),
      stderr: "",
      exitCode: 0,
    });
    const sandbox = await e2b(
      fake.value,
      "/home/user/workspace/repo",
    ).createSandbox({ id: "test" });

    await expect(
      sandbox.snapshotWorkspaceContext?.(sandbox.cwd),
    ).resolves.toEqual(snapshot);
    expect(fake.commands.run).toHaveBeenCalledOnce();
    expect(fake.commands.run).toHaveBeenCalledWith(expect.any(String), {
      envs: { FLUE_WORKSPACE_CONTEXT_ROOT: "/home/user/workspace/repo" },
      timeoutMs: 30_000,
    });
    expect(fake.commands.run.mock.calls[0]?.[0]).not.toContain(
      "/home/user/workspace/repo",
    );
    expect(fake.files.read).not.toHaveBeenCalled();
    expect(fake.files.list).not.toHaveBeenCalled();
    expect((sandbox satisfies FlueSandbox).snapshotWorkspaceContext).toBeTypeOf(
      "function",
    );
  });

  it("collects raw facts and declines symlinked traversal in the real guest helper", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "dx-context-snapshot-")),
    );
    try {
      await writeFile(join(root, "AGENTS.md"), " agents raw \n");
      await writeFile(join(root, "CLAUDE.md"), "claude raw\n");
      await mkdir(join(root, ".agents", "skills", "z-review"), {
        recursive: true,
      });
      await writeFile(
        join(root, ".agents", "skills", "z-review", "SKILL.md"),
        "---\nname: z-review\ndescription: Review\n---\nBody\n",
      );
      await mkdir(join(root, ".agents", "skills", "a-test"));
      await writeFile(
        join(root, ".agents", "skills", "a-test", "SKILL.md"),
        "---\nname: a-test\ndescription: Test\n---\nBody\n",
      );
      const fake = makeE2B();
      fake.commands.run.mockImplementation(runGuestCommand);
      const sandbox = await e2b(fake.value, root).createSandbox({ id: "test" });

      const snapshot = await sandbox.snapshotWorkspaceContext?.(root);
      expect(snapshot).toEqual({
        instructionFiles: {
          "AGENTS.md": " agents raw \n",
          "CLAUDE.md": "claude raw\n",
        },
        skillFiles: expect.arrayContaining([
          {
            kind: "file",
            directoryName: "z-review",
            content: "---\nname: z-review\ndescription: Review\n---\nBody\n",
          },
          {
            kind: "file",
            directoryName: "a-test",
            content: "---\nname: a-test\ndescription: Test\n---\nBody\n",
          },
        ]),
        directoryListing: expect.arrayContaining([
          "AGENTS.md",
          "CLAUDE.md",
          ".agents",
        ]),
      });
      if (snapshot === undefined || "kind" in snapshot)
        throw new Error("Expected a workspace context snapshot.");
      expect(snapshot.skillFiles).toHaveLength(2);
      expect(snapshot.directoryListing).toHaveLength(3);

      await symlink(
        join(root, ".agents", "skills", "z-review"),
        join(root, ".agents", "skills", "linked"),
      );
      await expect(sandbox.snapshotWorkspaceContext?.(root)).resolves.toEqual({
        kind: "declined",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("snapshots 239 valid skills in one bounded operation", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "dx-context-many-skills-")),
    );
    try {
      await mkdir(join(root, ".agents", "skills"), { recursive: true });
      await Promise.all(
        Array.from({ length: 239 }, async (_, index) => {
          const directoryName = `skill-${String(index).padStart(3, "0")}`;
          const directory = join(root, ".agents", "skills", directoryName);
          await mkdir(directory);
          await writeFile(
            join(directory, "SKILL.md"),
            `---\nname: ${directoryName}\ndescription: bounded\n---\nbody\n`,
          );
        }),
      );

      const fake = makeE2B();
      fake.commands.run.mockImplementation(runGuestCommand);
      const sandbox = await e2b(fake.value, root).createSandbox({ id: "test" });

      const snapshot = await sandbox.snapshotWorkspaceContext?.(root);
      if (snapshot === undefined || "kind" in snapshot)
        throw new Error("Expected a workspace context snapshot.");
      expect(snapshot.skillFiles).toHaveLength(239);
      expect(snapshot.skillFiles).toEqual(
        expect.arrayContaining([
          {
            kind: "file",
            directoryName: "skill-000",
            content: "---\nname: skill-000\ndescription: bounded\n---\nbody\n",
          },
          {
            kind: "file",
            directoryName: "skill-238",
            content: "---\nname: skill-238\ndescription: bounded\n---\nbody\n",
          },
        ]),
      );
      expect(snapshot.directoryListing).toEqual([".agents"]);
      expect(fake.commands.run).toHaveBeenCalledOnce();
      expect(fake.files.read).not.toHaveBeenCalled();
      expect(fake.files.list).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("declines skill-count overflow without returning a partial snapshot", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "dx-context-count-bounds-")),
    );
    try {
      await mkdir(join(root, ".agents", "skills"), { recursive: true });
      await Promise.all(
        Array.from({ length: 257 }, async (_, index) => {
          const directoryName = `skill-${index}`;
          const directory = join(root, ".agents", "skills", directoryName);
          await mkdir(directory);
          await writeFile(
            join(directory, "SKILL.md"),
            `---\nname: ${directoryName}\ndescription: bounded\n---\nbody`,
          );
        }),
      );
      await Promise.all(
        Array.from({ length: 257 }, (_, index) =>
          writeFile(join(root, `entry-${index}`), ""),
        ),
      );

      const fake = makeE2B();
      fake.commands.run.mockImplementation(runGuestCommand);
      const sandbox = await e2b(fake.value, root).createSandbox({ id: "test" });

      await expect(sandbox.snapshotWorkspaceContext?.(root)).resolves.toEqual({
        kind: "declined",
      });
      expect(fake.commands.run).toHaveBeenCalledOnce();
      expect(fake.files.read).not.toHaveBeenCalled();
      expect(fake.files.list).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("declines manifest overflow without returning a partial snapshot", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "dx-context-manifest-bounds-")),
    );
    try {
      await mkdir(join(root, ".agents", "skills"), { recursive: true });
      await Promise.all(
        Array.from({ length: 65 }, async (_, index) => {
          const directoryName = `skill-${index}`;
          const directory = join(root, ".agents", "skills", directoryName);
          await mkdir(directory);
          await writeFile(
            join(directory, "SKILL.md"),
            `---\nname: ${directoryName}\ndescription: bounded\n---\n${"x".repeat(
              64 * 1024 - 60,
            )}`,
          );
        }),
      );

      const fake = makeE2B();
      fake.commands.run.mockImplementation(runGuestCommand);
      const sandbox = await e2b(fake.value, root).createSandbox({ id: "test" });

      await expect(sandbox.snapshotWorkspaceContext?.(root)).resolves.toEqual({
        kind: "declined",
      });
      expect(fake.commands.run).toHaveBeenCalledOnce();
      expect(fake.files.read).not.toHaveBeenCalled();
      expect(fake.files.list).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "a file over 64 KiB",
      arrange: (root: string) =>
        writeFile(join(root, "AGENTS.md"), "x".repeat(64 * 1024 + 1)),
    },
    {
      name: "invalid UTF-8",
      arrange: (root: string) =>
        writeFile(join(root, "AGENTS.md"), new Uint8Array([0xff])),
    },
    {
      name: "a non-regular instruction file",
      arrange: (root: string) => mkdir(join(root, "AGENTS.md")),
    },
  ])(
    "declines $name without returning a partial snapshot",
    async ({ arrange }) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "dx-context-bounds-")),
      );
      try {
        await arrange(root);
        const fake = makeE2B();
        fake.commands.run.mockImplementation(runGuestCommand);
        const sandbox = await e2b(fake.value, root).createSandbox({
          id: "test",
        });

        await expect(sandbox.snapshotWorkspaceContext?.(root)).resolves.toEqual(
          {
            kind: "declined",
          },
        );
        expect(fake.commands.run).toHaveBeenCalledOnce();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("fails advertised transport and malformed protocol errors without primitive reads", async () => {
    const transport = makeE2B();
    transport.commands.run.mockRejectedValueOnce(new Error("transport lost"));
    const transportSandbox = await e2b(transport.value).createSandbox({
      id: "test",
    });
    await expect(
      transportSandbox.snapshotWorkspaceContext?.(transportSandbox.cwd),
    ).rejects.toThrow("transport lost");
    expect(transport.files.read).not.toHaveBeenCalled();
    expect(transport.files.list).not.toHaveBeenCalled();

    const malformed = makeE2B();
    malformed.commands.run.mockResolvedValueOnce({
      stdout: "not json",
      stderr: "private provider detail",
      exitCode: 0,
    });
    const malformedSandbox = await e2b(malformed.value).createSandbox({
      id: "test",
    });
    await expect(
      malformedSandbox.snapshotWorkspaceContext?.(malformedSandbox.cwd),
    ).rejects.toThrow("returned invalid JSON");
    expect(malformed.files.read).not.toHaveBeenCalled();
    expect(malformed.files.list).not.toHaveBeenCalled();
  });

  it("maps command cwd, env, timeout and normalized result exactly", async () => {
    const fake = makeE2B();
    const sandbox = await e2b(fake.value).createSandbox({ id: "test" });

    await expect(
      sandbox.exec("pwd", {
        cwd: "/workspace",
        env: { A: "b" },
        timeoutMs: 12_345,
      }),
    ).resolves.toEqual({ stdout: "out", stderr: "err", exitCode: 7 });
    expect(fake.commands.run).toHaveBeenCalledWith("pwd", {
      cwd: "/workspace",
      envs: { A: "b" },
      timeoutMs: 12_345,
    });
  });

  it("forwards interruption to the admitted remote command", async () => {
    const fake = makeE2B();
    let settle!: (value: {
      stdout: string;
      stderr: string;
      exitCode: number;
    }) => void;
    fake.commands.run.mockImplementation(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const sandbox = await e2b(fake.value).createSandbox({ id: "test" });
    const controller = new AbortController();

    const execution = sandbox.exec("sleep 60", { signal: controller.signal });
    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.commands.run).toHaveBeenCalledWith("sleep 60", {
      cwd: "/home/user",
      envs: undefined,
      timeoutMs: undefined,
      signal: controller.signal,
    });
    settle({ stdout: "", stderr: "", exitCode: 0 });
  });
});
