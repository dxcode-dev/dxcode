import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { diskReliefScript, parseDiskRelief } from "./disk-cleanup-script.js";

/**
 * #1649: the Orb container object's check between commands, in real bash
 * against a temporary home. A huge threshold stands in for a critically low
 * disk. What could go wrong:
 *  1. It clears a cache while an install is reading or writing it.
 *  2. It clears while the agent's own command is still running.
 *  3. It deletes the person's checkout, untracked work, or /tmp files.
 *  4. It says it freed something it did not, or says nothing.
 */

const ALWAYS_LOW = 1_000_000_000_000;
let home: string;
let running: ChildProcess[] = [];

const exists = async (path: string) =>
  readdir(path).then(
    () => true,
    () => false,
  );

const relieve = (belowKiB = ALWAYS_LOW) =>
  new Promise<ReturnType<typeof parseDiskRelief>>((resolve, reject) => {
    execFile(
      "bash",
      // Only this test's processes: other test files run beside it.
      ["-c", diskReliefScript(home, belowKiB, home)],
      { timeout: 30_000 },
      (error, stdout) =>
        error ? reject(error) : resolve(parseDiskRelief(stdout)),
    );
  });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "dx-relief-"));
  for (const path of [
    ".local/share/pnpm/store/v10/files/00",
    ".npm/_cacache/content-v2",
    "workspace/repo/src",
    "workspace/repo/node_modules/.cache",
    ".local/state/dx-shell",
    "bin",
  ])
    await mkdir(join(home, path), { recursive: true });
  await writeFile(join(home, ".local/share/pnpm/store/v10/files/00/a"), "x");
  await writeFile(join(home, ".npm/_cacache/content-v2/b"), "x");
  await writeFile(join(home, "workspace/repo/src/main.ts"), "work");
  await writeFile(join(home, "workspace/repo/notes-untracked.txt"), "work");
  // A program named like the package manager, as `pnpm install` runs.
  await writeFile(join(home, "bin/pnpm"), "#!/bin/bash\nsleep 30\n");
  await chmod(join(home, "bin/pnpm"), 0o755);
});

afterEach(async () => {
  for (const child of running) child.kill("SIGKILL");
  running = [];
  await rm(home, { recursive: true, force: true });
});

it("leaves a disk with room alone (#1649)", async () => {
  await expect(relieve(1)).resolves.toMatchObject({ kind: "ok" });
  expect(await exists(join(home, ".local/share/pnpm/store"))).toBe(true);
});

it("never clears a cache while an install is running, and clears it once the install ends (#1649)", async () => {
  const install = spawn(join(home, "bin/pnpm"), ["install"], {
    stdio: "ignore",
  });
  running.push(install);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await expect(relieve()).resolves.toMatchObject({ kind: "busy" });
  expect(await exists(join(home, ".local/share/pnpm/store"))).toBe(true);

  install.kill("SIGKILL");
  await new Promise((resolve) => install.once("exit", resolve));
  const relief = await relieve();
  expect(relief).toMatchObject({
    kind: "cleaned",
    paths: [join(home, ".local/share/pnpm/store"), join(home, ".npm/_cacache")],
  });
  expect(await exists(join(home, ".local/share/pnpm/store"))).toBe(false);
  expect(await exists(join(home, ".npm/_cacache"))).toBe(false);
  // The person's work stays, the rebuildable folder in it too: only caches.
  expect(await exists(join(home, "workspace/repo/src"))).toBe(true);
  expect(await exists(join(home, "workspace/repo/node_modules/.cache"))).toBe(
    true,
  );
  expect(
    (await readdir(join(home, "workspace/repo"))).includes(
      "notes-untracked.txt",
    ),
  ).toBe(true);
});

it("waits for the agent's command that is still running (#1649)", async () => {
  const command = spawn("sleep", ["30"], { stdio: "ignore" });
  running.push(command);
  const state = join(home, ".local/state/dx-shell/start.1");
  await mkdir(state);
  await writeFile(join(state, "pid"), String(command.pid));
  await expect(relieve()).resolves.toMatchObject({
    kind: "busy",
    what: "shell-command",
  });
  expect(await exists(join(home, ".npm/_cacache"))).toBe(true);
  // Finished: its state has an exit code.
  await writeFile(join(state, "exit"), "0");
  await expect(relieve()).resolves.toMatchObject({ kind: "cleaned" });
});

it("says there is nothing to clear rather than claiming it freed space (#1649)", async () => {
  await rm(join(home, ".local/share/pnpm"), { recursive: true });
  await rm(join(home, ".npm"), { recursive: true });
  await expect(relieve()).resolves.toMatchObject({ kind: "nothing" });
  expect(await exists(join(home, "workspace/repo/src"))).toBe(true);
});
