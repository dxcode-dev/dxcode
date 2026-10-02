import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ThreadChangesCaptureId, ThreadChangesCommitSha } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import type { Sandbox } from "@flue/runtime";
import { beforeAll, describe, expect, it } from "vitest";
import {
  captureThreadChanges,
  loadThreadChangesCapture,
  probeThreadChanges,
  ThreadChangesCaptureUnavailable,
} from "./capture.js";

const executeFile = promisify(execFile);

// The request-scoped capture is `dxd changes-capture`. Tests run the debug
// build of the daemon from this checkout, building it once when absent.
const dxdManifest = fileURLToPath(
  new URL("../../../dxd/Cargo.toml", import.meta.url),
);
const dxdBinary =
  process.env.DXD_BINARY ??
  fileURLToPath(new URL("../../../dxd/target/debug/dxd", import.meta.url));
const ensureDxdBinary = async () => {
  if (existsSync(dxdBinary)) return;
  await executeFile(
    "cargo",
    ["build", "--locked", "--manifest-path", dxdManifest],
    { encoding: "utf8", maxBuffer: 64 * 1_024 * 1_024 },
  );
};
const dxdPath = `${dirname(dxdBinary)}:${process.env.PATH ?? ""}`;

const git = async (root: string, ...args: ReadonlyArray<string>) =>
  (
    await executeFile(
      "git",
      ["-C", root, "-c", "commit.gpgsign=false", ...args],
      {
        encoding: "utf8",
      },
    )
  ).stdout.trim();

const localSandbox = (cwd: string) =>
  ({
    cwd,
    async exec(command, options) {
      try {
        const result = await executeFile("/bin/sh", ["-c", command], {
          cwd: options?.cwd ?? cwd,
          encoding: "utf8",
          env: { ...process.env, PATH: dxdPath, ...options?.env },
          timeout: options?.timeoutMs,
          maxBuffer: 10 * 1_024 * 1_024,
        });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
      } catch (cause) {
        const failure = cause as {
          readonly stdout?: string;
          readonly stderr?: string;
          readonly code?: number;
        };
        return {
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
          exitCode: typeof failure.code === "number" ? failure.code : 1,
        };
      }
    },
  }) as Sandbox;

const dxdCapture = async (input: {
  readonly root: string;
  readonly baseline: string;
  readonly expectedFingerprint?: string;
}) => {
  const result = await executeFile(dxdBinary, ["changes-capture"], {
    cwd: input.root,
    encoding: "utf8",
    maxBuffer: 10 * 1_024 * 1_024,
    env: {
      PATH: process.env.PATH,
      LC_ALL: "C.UTF-8",
      DX_CHANGES_ROOT: input.root,
      DX_CHANGES_BASELINE: input.baseline,
      DX_CHANGES_DEFAULT_BRANCH: "main",
      ...(input.expectedFingerprint === undefined
        ? {}
        : { DX_CHANGES_EXPECTED_FINGERPRINT: input.expectedFingerprint }),
    },
  });
  return JSON.parse(result.stdout) as unknown;
};

describe("Thread Changes capture", { timeout: 30000 }, () => {
  beforeAll(ensureDxdBinary, 600_000);

  it("captures primary and linked worktree changes with distinct identities", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "dx-thread-changes-primary-"),
    );
    const linked = await mkdtemp(
      join(await realpath(tmpdir()), "dx-thread-changes-linked-"),
    );
    await rm(linked, { recursive: true, force: true });
    try {
      await git(root, "init", "-b", "main");
      await git(root, "config", "user.name", "dx test");
      await git(root, "config", "user.email", "dx-test@example.test");
      await writeFile(join(root, "shared.txt"), "base\n");
      await git(root, "add", "shared.txt");
      await git(root, "commit", "-m", "baseline");
      const baseline = await git(root, "rev-parse", "HEAD");
      await git(root, "worktree", "add", "-b", "linked", linked);
      await writeFile(join(root, "shared.txt"), "primary\n");
      await writeFile(join(linked, "shared.txt"), "linked\n");

      const manifest = await captureThreadChanges({
        sandbox: localSandbox(root),
        threadId: "thr_00000000-0000-4000-8000-000000000295" as ThreadId,
        source: {
          baseline,
          defaultBranch: "main",
          repositoryName: "example-org/example-repo",
        },
        generation: 1,
      });
      expect(manifest?.worktrees).toHaveLength(2);
      expect(
        manifest?.ranges.find(({ range }) => range.kind === "uncommitted")
          ?.files,
      ).toHaveLength(2);

      const candidate = (await dxdCapture({ root, baseline })) as {
        readonly worktrees?: ReadonlyArray<{
          readonly id: string;
          readonly name: string;
        }>;
        readonly ranges?: ReadonlyArray<{
          readonly range: { readonly kind: string };
          readonly files: ReadonlyArray<{
            readonly path: string;
            readonly worktree?: string;
            readonly patch: string;
          }>;
        }>;
      };
      expect(candidate.worktrees).toHaveLength(2);
      const files = candidate.ranges?.find(
        ({ range }) => range.kind === "uncommitted",
      )?.files;
      expect(files).toHaveLength(2);
      expect(
        files?.map(({ path, worktree, patch }) => ({ path, worktree, patch })),
      ).toEqual([
        expect.objectContaining({
          path: "shared.txt",
          worktree: "primary",
          patch: expect.stringContaining("+primary"),
        }),
        expect.objectContaining({
          path: "shared.txt",
          worktree: expect.stringMatching(/^wt_[a-f0-9]{16}$/),
          patch: expect.stringContaining("+linked"),
        }),
      ]);
    } finally {
      await git(root, "worktree", "remove", "--force", linked).catch(
        () => undefined,
      );
      await rm(root, { recursive: true, force: true });
      await rm(linked, { recursive: true, force: true });
    }
  });

  it("captures projectless history and worktrees from the empty-tree baseline", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "dx-thread-changes-projectless-"),
    );
    const linked = await mkdtemp(join(tmpdir(), "dx-thread-changes-linked-"));
    await rm(linked, { recursive: true, force: true });
    try {
      await git(root, "init", "-b", "main");
      await git(root, "config", "user.name", "dx test");
      await git(root, "config", "user.email", "dx-test@example.test");
      const emptyTree = (await git(
        root,
        "hash-object",
        "-w",
        "-t",
        "tree",
        "/dev/null",
      )) as ThreadChangesCommitSha;
      await writeFile(join(root, "proof.txt"), "projectless\n");
      await git(root, "add", "proof.txt");
      await git(root, "commit", "-m", "projectless baseline proof");
      await git(root, "worktree", "add", "-b", "linked", linked);
      await writeFile(join(root, "primary.txt"), "primary\n");
      await writeFile(join(linked, "linked.txt"), "linked\n");

      const manifest = await captureThreadChanges({
        sandbox: localSandbox(root),
        threadId: "thr_00000000-0000-4000-8000-000000000296" as ThreadId,
        source: {
          baseline: emptyTree,
          defaultBranch: "main",
          repositoryName: "No Project",
        },
        generation: 1,
      });
      const candidate = await dxdCapture({ root, baseline: emptyTree });

      expect(manifest).toEqual(
        expect.objectContaining({
          baseline: emptyTree,
          ahead: 1,
          commits: [
            expect.objectContaining({ subject: "projectless baseline proof" }),
          ],
          worktrees: [
            expect.objectContaining({ id: "primary" }),
            expect.objectContaining({ id: expect.stringMatching(/^wt_/) }),
          ],
        }),
      );
      expect(
        manifest?.ranges.find(({ range }) => range.kind === "all")?.files,
      ).toHaveLength(4);
      expect(
        manifest?.ranges.find(({ range }) => range.kind === "uncommitted")
          ?.files,
      ).toHaveLength(2);
      expect(candidate).toEqual(
        expect.objectContaining({
          kind: "complete",
          fingerprint: manifest?.fingerprint,
          worktrees: manifest?.worktrees,
          ranges: manifest?.ranges,
        }),
      );
    } finally {
      await git(root, "worktree", "remove", "--force", linked).catch(
        () => undefined,
      );
      await rm(root, { recursive: true, force: true });
      await rm(linked, { recursive: true, force: true });
    }
  });

  it("captures an unborn projectless repository without traversing commits", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "dx-thread-changes-projectless-unborn-"),
    );
    try {
      await git(root, "init", "-b", "main");
      const emptyTree = (await git(
        root,
        "hash-object",
        "-w",
        "-t",
        "tree",
        "/dev/null",
      )) as ThreadChangesCommitSha;
      await writeFile(
        join(root, "draft.txt"),
        "uncommitted projectless work\n",
      );

      const manifest = await captureThreadChanges({
        sandbox: localSandbox(root),
        threadId: "thr_00000000-0000-4000-8000-000000000298" as ThreadId,
        source: {
          baseline: emptyTree,
          defaultBranch: "main",
          repositoryName: "No Project",
        },
        generation: 1,
      });
      expect(manifest).toBeDefined();
      if (manifest === undefined) return;

      const candidate = await dxdCapture({ root, baseline: emptyTree });

      expect(manifest).toEqual(
        expect.objectContaining({
          baseline: emptyTree,
          head: emptyTree,
          ahead: 0,
          commits: [],
        }),
      );
      expect(
        manifest.ranges.find(({ range }) => range.kind === "uncommitted")
          ?.files,
      ).toContainEqual(
        expect.objectContaining({
          path: "draft.txt",
          status: "untracked",
          patch: expect.stringContaining("+uncommitted projectless work"),
        }),
      );
      expect(candidate).toEqual({
        kind: "complete",
        fingerprint: manifest.fingerprint,
        baseline: manifest.baseline,
        head: manifest.head,
        branch: manifest.branch ?? null,
        upstreamLabel: manifest.upstreamLabel ?? null,
        ahead: manifest.ahead,
        commits: manifest.commits,
        worktrees: manifest.worktrees,
        ranges: manifest.ranges,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures files from an unborn linked worktree", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "dx-thread-changes-primary-"),
    );
    const linked = await mkdtemp(
      join(await realpath(tmpdir()), "dx-thread-changes-unborn-"),
    );
    await rm(linked, { recursive: true, force: true });
    try {
      await git(root, "init", "-b", "main");
      await git(root, "config", "user.name", "dx test");
      await git(root, "config", "user.email", "dx-test@example.test");
      await writeFile(join(root, "base.txt"), "base\n");
      await git(root, "add", "base.txt");
      await git(root, "commit", "-m", "baseline");
      const baseline = await git(root, "rev-parse", "HEAD");
      await git(root, "worktree", "add", "--detach", linked, "HEAD");
      await git(linked, "checkout", "--orphan", "scratch");
      await writeFile(join(linked, "draft.ts"), "export const draft = true;\n");

      const manifest = await captureThreadChanges({
        sandbox: localSandbox(root),
        threadId: "thr_00000000-0000-4000-8000-000000000297" as ThreadId,
        source: {
          baseline,
          defaultBranch: "main",
          repositoryName: "example-org/example-repo",
        },
        generation: 1,
      });
      const candidate = await dxdCapture({ root, baseline });

      expect(manifest?.worktrees).toEqual([
        expect.objectContaining({ id: "primary" }),
        expect.objectContaining({
          id: expect.stringMatching(/^wt_[a-f0-9]{16}$/),
          head: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
          branch: "scratch",
        }),
      ]);
      expect(
        manifest?.ranges.find(({ range }) => range.kind === "uncommitted")
          ?.files,
      ).toContainEqual(
        expect.objectContaining({
          path: "draft.ts",
          status: "untracked",
          patch: expect.stringContaining("+export const draft = true;"),
        }),
      );
      expect(candidate).toEqual(
        expect.objectContaining({
          kind: "complete",
          fingerprint: manifest?.fingerprint,
          worktrees: manifest?.worktrees,
          ranges: manifest?.ranges,
        }),
      );
    } finally {
      await git(root, "worktree", "remove", "--force", linked).catch(
        () => undefined,
      );
      await rm(root, { recursive: true, force: true });
      await rm(linked, { recursive: true, force: true });
    }
  });

  it("keeps complete summaries when an orphan worktree exceeds the file limit", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "dx-thread-changes-primary-"),
    );
    const linked = await mkdtemp(
      join(await realpath(tmpdir()), "dx-thread-changes-orphan-"),
    );
    await rm(linked, { recursive: true, force: true });
    try {
      await git(root, "init", "-b", "main");
      await git(root, "config", "user.name", "dx test");
      await git(root, "config", "user.email", "dx-test@example.test");
      await writeFile(join(root, "base.txt"), "base\n");
      await git(root, "add", "base.txt");
      await git(root, "commit", "-m", "baseline");
      const baseline = await git(root, "rev-parse", "HEAD");
      await git(root, "worktree", "add", "--detach", linked);
      await git(linked, "checkout", "--orphan", "orphan");
      await git(linked, "rm", "-rf", ".");
      await writeFile(join(linked, "orphan.txt"), "orphan one\norphan two\n");
      await git(linked, "add", "orphan.txt");
      await git(linked, "commit", "-m", "orphan root");
      await writeFile(join(linked, "oversized.txt"), "line\n".repeat(60_000));
      await Promise.all(
        Array.from({ length: 200 }, (_, index) =>
          writeFile(
            join(root, `untracked-${index.toString().padStart(3, "0")}.txt`),
            "line\n",
          ),
        ),
      );

      const manifest = await captureThreadChanges({
        sandbox: localSandbox(root),
        threadId: "thr_00000000-0000-4000-8000-000000000296" as ThreadId,
        source: {
          baseline,
          defaultBranch: "main",
          repositoryName: "example-org/example-repo",
        },
        generation: 1,
      });
      const candidate = (await dxdCapture({ root, baseline })) as {
        readonly ranges: ReadonlyArray<{
          readonly range: { readonly kind: string };
          readonly truncated: boolean;
          readonly summary: {
            readonly additions: number;
            readonly deletions: number;
            readonly files: number;
          };
          readonly files: ReadonlyArray<{ readonly path: string }>;
        }>;
      };
      const all = manifest?.ranges.find(({ range }) => range.kind === "all");
      expect(all).toMatchObject({
        truncated: true,
        summary: { additions: 60_202, deletions: 0, files: 202 },
      });
      expect(all?.files).toHaveLength(200);
      expect(all?.files.some(({ path }) => path === "orphan.txt")).toBe(false);
      expect(
        candidate.ranges.find(({ range }) => range.kind === "all"),
      ).toMatchObject({
        truncated: true,
        summary: { additions: 60_202, deletions: 0, files: 202 },
      });
    } finally {
      await git(root, "worktree", "remove", "--force", linked).catch(
        () => undefined,
      );
      await rm(root, { recursive: true, force: true });
      await rm(linked, { recursive: true, force: true });
    }
  });

  it("keeps resident dxd candidates equivalent, bounded, and race-aware", {
    timeout: 90000,
  }, async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "dx-thread-changes-shadow-"),
    );
    try {
      await git(root, "init", "-b", "main");
      await git(root, "config", "user.name", "dx test");
      await git(root, "config", "user.email", "dx-test@example.test");
      await writeFile(join(root, "tracked.txt"), "base\n");
      await git(root, "add", "tracked.txt");
      await git(root, "commit", "-m", "baseline");
      const baseline = await git(root, "rev-parse", "HEAD");
      for (let commit = 1; commit <= 51; commit += 1) {
        await writeFile(join(root, "committed.txt"), `commit ${commit}\n`);
        await git(root, "add", "committed.txt");
        await git(root, "commit", "-m", `candidate commit ${commit}`);
      }
      await writeFile(join(root, "tracked.txt"), "changed\n");
      await writeFile(join(root, "untracked.txt"), "untracked\n");
      await writeFile(join(root, "binary.dat"), new Uint8Array([1, 0, 2]));

      const manifest = await captureThreadChanges({
        sandbox: localSandbox(root),
        threadId: "thr_00000000-0000-4000-8000-000000000294" as ThreadId,
        source: {
          baseline,
          defaultBranch: "main",
          repositoryName: "example-org/example-repo",
        },
        generation: 1,
      });
      expect(manifest).toBeDefined();
      if (manifest === undefined) return;
      expect(manifest.commits).toHaveLength(50);
      expect(manifest.ranges).toHaveLength(52);
      const candidate = await dxdCapture({ root, baseline });
      expect(candidate).toEqual({
        kind: "complete",
        fingerprint: manifest.fingerprint,
        baseline: manifest.baseline,
        head: manifest.head,
        branch: manifest.branch ?? null,
        upstreamLabel: manifest.upstreamLabel ?? null,
        ahead: manifest.ahead,
        commits: manifest.commits,
        worktrees: manifest.worktrees,
        ranges: manifest.ranges,
      });
      expect(JSON.stringify(candidate).length).toBeLessThan(8 * 1_024 * 1_024);

      // Request-scoped: a matching probe fingerprint still yields the capture.
      await expect(
        dxdCapture({
          root,
          baseline,
          expectedFingerprint: manifest.fingerprint,
        }),
      ).resolves.toMatchObject({
        kind: "complete",
        fingerprint: manifest.fingerprint,
      });
      // The probe answers from the same fingerprint the capture recorded.
      await expect(
        probeThreadChanges({
          sandbox: localSandbox(root),
          source: {
            baseline,
            defaultBranch: "main",
            repositoryName: "example-org/example-repo",
          },
          expectedFingerprint: manifest.fingerprint,
        }),
      ).resolves.toEqual({
        kind: "unchanged",
        fingerprint: manifest.fingerprint,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures exact commit ranges separately from current uncommitted work", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "dx-thread-changes-"),
    );
    try {
      await git(root, "init", "-b", "main");
      await git(root, "config", "user.name", "dx test");
      await git(root, "config", "user.email", "dx-test@example.test");
      await writeFile(join(root, "base.txt"), "base\n");
      await git(root, "add", "base.txt");
      await git(root, "commit", "-m", "baseline");
      const baseline = await git(root, "rev-parse", "HEAD");

      await writeFile(join(root, "first.txt"), "first\n");
      await git(root, "add", "first.txt");
      await git(root, "commit", "-m", "first commit");
      const first = await git(root, "rev-parse", "HEAD");

      await writeFile(join(root, "second.txt"), "second\n");
      await git(root, "add", "second.txt");
      await git(root, "commit", "-m", "second commit");
      const second = await git(root, "rev-parse", "HEAD");

      await writeFile(join(root, "staged.txt"), "staged line\n");
      await git(root, "add", "staged.txt");
      await writeFile(join(root, "base.txt"), "base changed\n");
      await writeFile(join(root, "untracked.txt"), "new line\n");
      const lateNulBinary = new Uint8Array(9_000).fill(1);
      lateNulBinary[8_500] = 0;
      await writeFile(join(root, "binary.dat"), lateNulBinary);

      const manifest = await captureThreadChanges({
        sandbox: localSandbox(root),
        threadId: "thr_00000000-0000-4000-8000-000000000249" as ThreadId,
        source: {
          baseline,
          defaultBranch: "main",
          repositoryName: "example-org/example-repo",
        },
        generation: 7,
      });

      expect(manifest).toBeDefined();
      if (manifest === undefined) return;
      expect(manifest.head).toBe(second);
      expect(manifest.ahead).toBe(2);
      expect(manifest.commits.map(({ sha }) => sha)).toEqual([second, first]);

      const range = (kind: "all" | "uncommitted" | "commit", sha?: string) =>
        manifest.ranges.find(
          (candidate) =>
            candidate.range.kind === kind &&
            (kind !== "commit" ||
              (candidate.range.kind === "commit" &&
                candidate.range.sha === sha)),
        );
      expect(range("all")?.files.map(({ path }) => path)).toEqual([
        "base.txt",
        "binary.dat",
        "first.txt",
        "second.txt",
        "staged.txt",
        "untracked.txt",
      ]);
      expect(range("uncommitted")?.files.map(({ path }) => path)).toEqual([
        "base.txt",
        "binary.dat",
        "staged.txt",
        "untracked.txt",
      ]);
      expect(range("commit", second)?.files.map(({ path }) => path)).toEqual([
        "second.txt",
      ]);
      expect(range("commit", first)?.files.map(({ path }) => path)).toEqual([
        "first.txt",
      ]);
      expect(
        range("uncommitted")?.files.find(({ path }) => path === "binary.dat"),
      ).toMatchObject({ binary: true, patch: "", status: "untracked" });
      expect(
        range("uncommitted")?.files.find(({ path }) => path === "untracked.txt")
          ?.patch,
      ).toContain("+++ b/untracked.txt");
      expect(
        range("uncommitted")?.files.find(({ path }) => path === "staged.txt")
          ?.patch,
      ).toContain("+++ b/staged.txt");
      expect(manifest.baseline).toBe(baseline as ThreadChangesCommitSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects unchanged reads plus branch, tracked, and untracked changes", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "dx-thread-changes-probe-"),
    );
    try {
      await git(root, "init", "-b", "main");
      await git(root, "config", "user.name", "dx test");
      await git(root, "config", "user.email", "dx-test@example.test");
      await writeFile(join(root, "tracked.txt"), "one\n");
      await git(root, "add", "tracked.txt");
      await git(root, "commit", "-m", "baseline");
      const baseline = await git(root, "rev-parse", "HEAD");
      const sandbox = localSandbox(root);
      const source = {
        baseline,
        defaultBranch: "main",
        repositoryName: "example-org/example-repo",
      };
      const threadId = "thr_00000000-0000-4000-8000-000000000250" as ThreadId;
      const initial = await captureThreadChanges({
        sandbox,
        threadId,
        source,
        generation: 1,
      });
      expect(initial).toBeDefined();
      if (initial === undefined) return;

      await expect(
        probeThreadChanges({
          sandbox,
          source,
          expectedFingerprint: initial.fingerprint,
        }),
      ).resolves.toMatchObject({ kind: "unchanged" });

      await git(root, "checkout", "-b", "alternate");
      const branchProbe = await probeThreadChanges({
        sandbox,
        source,
        expectedFingerprint: initial.fingerprint,
      });
      expect(branchProbe.kind).toBe("changed");
      const onAlternate = await captureThreadChanges({
        sandbox,
        threadId,
        source,
        generation: 2,
        expectedFingerprint: branchProbe.fingerprint,
      });
      expect(onAlternate?.branch).toBe("alternate");
      if (onAlternate === undefined) return;

      await writeFile(join(root, "tracked.txt"), "two\n");
      const trackedProbe = await probeThreadChanges({
        sandbox,
        source,
        expectedFingerprint: onAlternate.fingerprint,
      });
      expect(trackedProbe.kind).toBe("changed");
      const withTracked = await captureThreadChanges({
        sandbox,
        threadId,
        source,
        generation: 3,
        expectedFingerprint: trackedProbe.fingerprint,
      });
      expect(withTracked).toBeDefined();
      if (withTracked === undefined) return;

      await writeFile(join(root, "untracked.txt"), "red\n");
      const untrackedProbe = await probeThreadChanges({
        sandbox,
        source,
        expectedFingerprint: withTracked.fingerprint,
      });
      const withUntracked = await captureThreadChanges({
        sandbox,
        threadId,
        source,
        generation: 4,
        expectedFingerprint: untrackedProbe.fingerprint,
      });
      expect(withUntracked).toBeDefined();
      if (withUntracked === undefined) return;

      await writeFile(join(root, "untracked.txt"), "tan\n");
      await expect(
        probeThreadChanges({
          sandbox,
          source,
          expectedFingerprint: withUntracked.fingerprint,
        }),
      ).resolves.toMatchObject({ kind: "changed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("frames untracked records and detects fallback upstream movement", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "dx-thread-changes-framing-"),
    );
    try {
      await git(root, "init", "-b", "main");
      await git(root, "config", "user.name", "dx test");
      await git(root, "config", "user.email", "dx-test@example.test");
      await writeFile(join(root, "tracked.txt"), "tracked\n");
      await git(root, "add", "tracked.txt");
      await git(root, "commit", "-m", "baseline");
      const baseline = await git(root, "rev-parse", "HEAD");
      await writeFile(join(root, "a"), "X");
      await writeFile(join(root, "b"), "Y");
      const sandbox = localSandbox(root);
      const source = {
        baseline,
        defaultBranch: "main",
        repositoryName: "example-org/example-repo",
      };
      const threadId = "thr_00000000-0000-4000-8000-000000000251" as ThreadId;
      const initial = await captureThreadChanges({
        sandbox,
        threadId,
        source,
        generation: 1,
      });
      expect(initial).toBeDefined();
      if (initial === undefined) return;

      const mode = String((await lstat(join(root, "a"))).mode);
      await unlink(join(root, "b"));
      await writeFile(join(root, "a"), `Xb${mode}Y`);
      const reframed = await probeThreadChanges({
        sandbox,
        source,
        expectedFingerprint: initial.fingerprint,
      });
      expect(reframed.kind).toBe("changed");
      const afterReframing = await captureThreadChanges({
        sandbox,
        threadId,
        source,
        generation: 2,
        expectedFingerprint: reframed.fingerprint,
      });
      expect(afterReframing).toBeDefined();
      if (afterReframing === undefined) return;

      await git(root, "update-ref", "refs/remotes/origin/main", baseline);
      const fallbackAppeared = await probeThreadChanges({
        sandbox,
        source,
        expectedFingerprint: afterReframing.fingerprint,
      });
      expect(fallbackAppeared.kind).toBe("changed");
      const withFallback = await captureThreadChanges({
        sandbox,
        threadId,
        source,
        generation: 3,
        expectedFingerprint: fallbackAppeared.fingerprint,
      });
      expect(withFallback?.upstreamLabel).toBe("origin/main");
      if (withFallback === undefined) return;

      const remote = await git(
        root,
        "commit-tree",
        `${baseline}^{tree}`,
        "-p",
        baseline,
        "-m",
        "remote",
      );
      await git(root, "update-ref", "refs/remotes/origin/main", remote);
      await expect(
        probeThreadChanges({
          sandbox,
          source,
          expectedFingerprint: withFallback.fingerprint,
        }),
      ).resolves.toMatchObject({ kind: "changed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("contains missing and corrupt durable objects", async () => {
    const captureId =
      "chg_00000000-0000-4000-8000-000000000249" as ThreadChangesCaptureId;
    const valueThreadId =
      "thr_00000000-0000-4000-8000-000000000249" as ThreadId;
    const missing = { get: async () => null } as unknown as R2Bucket;
    await expect(
      loadThreadChangesCapture(missing, valueThreadId, captureId),
    ).rejects.toMatchObject({
      _tag: "ThreadChangesCaptureUnavailable",
      stage: "object-read",
    });

    const corrupt = {
      get: async () => ({ json: async () => ({ schemaVersion: 1 }) }),
    } as unknown as R2Bucket;
    await expect(
      loadThreadChangesCapture(corrupt, valueThreadId, captureId),
    ).rejects.toBeInstanceOf(ThreadChangesCaptureUnavailable);
  });
});
