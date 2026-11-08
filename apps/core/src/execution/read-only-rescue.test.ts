import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ExecutionGuest } from "../plugins/execution/provider.js";
import { rescueUnsavedWork } from "./read-only-rescue.js";

/**
 * #1658: before a read-only Orb restart, or any restart that cannot keep
 * the Orb's files, dx copies the person's unsaved work out. It copied only
 * ~/workspace/repo, so work in a worktree or an additional repository was
 * lost. Real git and bash against a temporary workspace with three checkouts
 * that each hold unsaved work.
 */

let root: string;

const sh = (command: string, cwd: string) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      "bash",
      ["-c", command],
      {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(`${stderr}${error.message}`))
          : resolve(stdout),
    );
  });

/**
 * The Orb, as a guest that runs commands in this machine's bash, in the
 * temporary workspace it rescues: the Orb's own `/home/user` need not exist
 * on the machine running the test (a CI runner's home is elsewhere).
 */
const guestIn = (workspace: string) =>
  ({
    commands: {
      run: (command: string) =>
        new Promise((resolve) => {
          execFile(
            "bash",
            ["-c", command],
            { cwd: workspace, maxBuffer: 64 * 1024 * 1024 },
            (error, stdout, stderr) =>
              resolve({
                stdout,
                stderr,
                exitCode: error ? Number(error.code) || 1 : 0,
              }),
          );
        }),
    },
  }) as unknown as ExecutionGuest;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dx-rescue-all-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await sh(
    "git init -q -b main && echo one > a.txt && git add a.txt && git commit -qm init && git clone -q --bare . ../origin.git && git remote add origin ../origin.git && git fetch -q origin",
    repo,
  );
  // The repository: an uncommitted change, an untracked file, an unpushed commit.
  await sh(
    "echo two >> a.txt && git commit -qam unpushed && echo three >> a.txt && echo note > untracked.txt",
    repo,
  );
  // A worktree with its own uncommitted change.
  await sh("git worktree add -q ../wt-feature -b feature", repo);
  await writeFile(join(root, "wt-feature/a.txt"), "worktree change\n");
  // An additional repository with an untracked file.
  const other = join(root, "repos/other");
  await mkdir(other, { recursive: true });
  await sh(
    "git init -q -b main && echo x > x.txt && git add x.txt && git commit -qm init && echo data > data.csv",
    other,
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("copies the unsaved work of every checkout under the workspace, not only the repository (#1658)", async () => {
  const rescue = await rescueUnsavedWork(guestIn(root), root);
  expect(rescue.kind).toBe("archive");
  if (rescue.kind !== "archive") return;
  const archive = join(root, "rescue.tar.gz");
  await writeFile(archive, rescue.bytes);
  const entries = (await sh(`tar tzf ${archive}`, root))
    .split("\n")
    .map((entry) => entry.replace(/^\.\//, ""));
  for (const expected of [
    "repo/.dx-recovered/status.txt",
    "repo/.dx-recovered/uncommitted.patch",
    "repo/.dx-recovered/unpushed.patch",
    "repo/untracked.txt",
    "wt-feature/.dx-recovered/uncommitted.patch",
    "repos/other/.dx-recovered/status.txt",
    "repos/other/data.csv",
  ])
    expect(entries).toContain(expected);
  // The repository's unpushed commit is in its patch.
  const unpushed = await sh(
    `tar xzf ${archive} -O ./repo/.dx-recovered/unpushed.patch`,
    root,
  );
  expect(unpushed).toContain("Subject: [PATCH] unpushed");
  expect(rescue.commits).toBeGreaterThanOrEqual(1);
  expect(rescue.changes).toBeGreaterThanOrEqual(4);
  // /dev/shm is left clean.
  expect(await sh("ls /dev/shm | grep -c dx-rescue || true", root)).toBe("0\n");
});

it("finds nothing to copy in a workspace with no unsaved work (#1658)", async () => {
  const clean = await mkdtemp(join(tmpdir(), "dx-rescue-clean-"));
  try {
    await mkdir(join(clean, "repo"));
    await sh(
      "git init -q -b main && echo x > x.txt && git add x.txt && git commit -qm init",
      join(clean, "repo"),
    );
    await expect(rescueUnsavedWork(guestIn(clean), clean)).resolves.toEqual({
      kind: "none",
    });
  } finally {
    await rm(clean, { recursive: true, force: true });
  }
});
