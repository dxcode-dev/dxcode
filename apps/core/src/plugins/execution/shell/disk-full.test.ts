import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "@flue/runtime";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createShellTools } from "./tools.js";

/**
 * #1649: an Orb whose btrfs metadata is exhausted fails every new file or
 * directory with ENOSPC, yet reading, `du`, and `rm` still work. shell_command
 * starts by writing its state under ~/.local/state/dx-shell, so on such a disk
 * it could run nothing at all, and the agent could not even find what fills
 * the disk to ask the person about it (#1642's preview, 2026-11-03).
 *
 * Real bash, with a `mkdir` earlier on PATH that fails as a full disk does
 * for dx's state directory.
 */

let home: string;
let bin: string;
let sandbox: Sandbox;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "dx-shell-full-"));
  bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "mkdir"),
    `#!/bin/bash
for arg in "$@"; do
  case "$arg" in
    */dx-shell*) echo "mkdir: cannot create directory '$arg': No space left on device" >&2; exit 1 ;;
  esac
done
exec /bin/mkdir "$@"
`,
  );
  await chmod(join(bin, "mkdir"), 0o755);
  await writeFile(join(home, "big.bin"), "x".repeat(4096));
  sandbox = {
    exec: (command, options) =>
      new Promise((resolve, reject) => {
        execFile(
          "bash",
          ["-c", command],
          {
            cwd: options?.cwd ?? home,
            env: {
              ...process.env,
              ...options?.env,
              HOME: home,
              PATH: `${bin}:${process.env.PATH ?? ""}`,
            },
            timeout: options?.timeoutMs,
            signal: options?.signal,
            maxBuffer: 1024 * 1024,
          },
          (error, stdout, stderr) => {
            if (error && (error.name === "AbortError" || error.killed))
              reject(error);
            else
              resolve({
                stdout,
                stderr,
                exitCode: error ? Number(error.code) || 1 : 0,
              });
          },
        );
      }),
    cwd: home,
  } as Sandbox;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const shellCommand = () => {
  const tool = createShellTools(sandbox, { defaultWorkdir: home })[0];
  if (tool === undefined) throw new Error("shell_command is missing");
  return tool;
};

const text = (
  result: Awaited<ReturnType<ReturnType<typeof shellCommand>["execute"]>>,
) => result.content.map((part) => ("text" in part ? part.text : "")).join("\n");

it("still runs a command on a disk too full for its state, so the agent can find and free space (#1649)", async () => {
  const result = await shellCommand().execute("call-1", {
    command: "echo SHELL-OK; du -sk big.bin | cut -f1",
  });
  const output = text(result);
  expect(output).toContain("SHELL-OK");
  expect(output).toMatch(/<exitCode>0<\/exitCode>/);
  // The agent hears why, and what does not work until space is freed.
  expect(output).toMatch(/disk is full/i);
  expect(result.details).toMatchObject({ running: false, exitCode: 0 });
});

it("frees space the person approves with rm on that disk (#1649)", async () => {
  await shellCommand().execute("call-2", { command: "rm -f big.bin" });
  const listed = text(
    await shellCommand().execute("call-3", { command: "ls" }),
  );
  expect(listed).not.toContain("big.bin");
});

it("reports a failing command's exit code on that disk instead of throwing (#1649)", async () => {
  const output = text(
    await shellCommand().execute("call-4", { command: "exit 3" }),
  );
  expect(output).toMatch(/<exitCode>3<\/exitCode>/);
});
