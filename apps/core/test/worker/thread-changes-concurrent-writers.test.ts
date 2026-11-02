import { env } from "cloudflare:test";
import type { ThreadChangesCaptureId } from "@dx/api";
import { ProjectRepository, type ThreadId, ThreadRepository } from "@dx/domain";
import type { Sandbox, SandboxFactory } from "@flue/runtime";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { withThreadChangesIfSourced } from "../../src/execution/activation.js";
import type { DxdChangesRefresh } from "../../src/execution/dxd/protocol.js";
import { makeThreadChangesRepository } from "../../src/thread-changes/repository-d1.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/*
 * The Changes mutation lease guarantees two things, whatever its round-trip
 * count:
 * 1. No capture taken while an agent write is in flight is ever published as
 *    settled: a write's lease is active while it runs, and taking the lease
 *    bumps the generation a publication must match.
 * 2. Changes ends up reflecting every agent write: once the writers stop, the
 *    published capture is of the final files and nothing is left dirty.
 *
 * Ways this could break, each of which this test would catch:
 * - The begin batch inserts the lease without bumping the generation, so a
 *   capture read before the write publishes over it.
 * - The release drops the lease before the write finishes, or the refresh's
 *   reads see the lease still held, so the last refresh captures nothing.
 * - A command skips coordination while writing a file.
 *
 * Writers go through the real coordinated sandbox and real D1. The resident
 * capturer models dxd: on each refresh it takes the capture lease, reads the
 * state, snapshots the files, and publishes with the generation it read.
 */

const WRITERS = 6;
const WRITES_PER_WRITER = 5;

const pause = (ms: number) => new Promise((settle) => setTimeout(settle, ms));
const jitter = () => pause(Math.floor(Math.random() * 15));

describe("Thread Changes with concurrent agent writers", () => {
  it("never publishes a capture taken mid-write and ends on every write", async () => {
    const projectId = "prj_00000000-0000-4000-8000-000000001451";
    const threadId = "thr_00000000-0000-4000-8000-000000001451" as ThreadId;
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).insert(
          project(projectId, "owner-a", "Concurrent writers"),
        );
        yield* (yield* ThreadRepository).insert(
          thread(threadId, projectId, "owner-a"),
        );
      }),
    );
    await env.DB.prepare(
      `INSERT INTO thread_source_snapshot (
         thread_id, project_id, binding_revision, provider,
         repository_full_name, clone_url, default_branch,
         initial_ref, initial_commit_sha, created_at
       ) VALUES (?, ?, 1, 'github', 'example-org/example-repo',
         'https://github.com/example-org/example-repo.git', 'main', ?, ?, ?)`,
    )
      .bind(
        threadId,
        projectId,
        "a".repeat(40),
        "a".repeat(40),
        "2026-11-01T12:00:00.000Z",
      )
      .run();

    // The workspace: files, and how many writes are running right now.
    const files = new Map<string, string>();
    let writing = 0;
    const snapshot = () =>
      JSON.stringify(
        [...files.entries()].sort(([a], [b]) => a.localeCompare(b)),
      );
    const primitive = {
      cwd: "/home/user/workspace/repo",
      // Git is absent, so a direct capture fails and is logged; the resident
      // capturer below is the only publisher.
      exec: async () => ({ stdout: "", stderr: "no git", exitCode: 1 }),
      writeFile: async (path: string, content: string) => {
        writing += 1;
        try {
          await jitter();
          files.set(path, content);
          await jitter();
        } finally {
          writing -= 1;
        }
      },
      mkdir: async () => undefined,
    } as unknown as Sandbox;

    const repository = makeThreadChangesRepository(env.DB);
    const published = new Map<string, { snapshot: string; mid: boolean }>();
    const violations: string[] = [];
    let captures = 0;
    const capturing = new Set<Promise<void>>();
    const capture = async () => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const lease = await repository.acquireCapture(threadId, 30_000);
        if (lease === undefined) {
          await pause(5);
          continue;
        }
        try {
          const state = lease.state;
          if (state === undefined || state.activeMutations > 0) return;
          const mid = writing > 0;
          const files = snapshot();
          await jitter();
          captures += 1;
          const captureId =
            `chg_00000000-0000-4000-8000-${String(captures).padStart(12, "0")}` as ThreadChangesCaptureId;
          const ok = await repository.publish({
            threadId,
            generation: state.mutationGeneration,
            captureId,
            fingerprint: String(captures).padStart(64, "0"),
            capturedAt: new Date().toISOString(),
          });
          if (ok) {
            published.set(captureId, { snapshot: files, mid });
            if (mid) violations.push(`${captureId} was taken mid-write`);
          }
          return;
        } finally {
          await lease.release();
        }
      }
    };
    const residentRefresh = async (_refresh: DxdChangesRefresh) => {
      const run = jitter().then(capture);
      capturing.add(run);
      void run.finally(() => capturing.delete(run));
      return true;
    };

    const sandbox = await (
      await withThreadChangesIfSourced(
        { createSandbox: async () => primitive } satisfies SandboxFactory,
        {
          db: env.DB,
          bucket: env.DX_STORAGE,
          threadId,
          residentRefresh,
        },
      )
    ).createSandbox({ id: threadId });

    await Promise.all(
      Array.from({ length: WRITERS }, async (_, writer) => {
        for (let write = 0; write < WRITES_PER_WRITER; write += 1) {
          await sandbox.mkdir(`/home/user/workspace/repo/w${writer}`, {
            recursive: true,
          });
          await sandbox.writeFile(
            `/home/user/workspace/repo/w${writer}/f${write % 2}.txt`,
            `writer ${writer} write ${write}`,
          );
        }
      }),
    );
    while (capturing.size > 0) await Promise.all([...capturing]);

    expect(violations).toEqual([]);
    expect(files.size).toBe(WRITERS * 2);
    const state = await repository.read(threadId);
    expect(state).toMatchObject({
      activeMutations: 0,
      latestCaptureGeneration: state?.mutationGeneration,
    });
    // Every write bumped the generation once; mkdir took no lease.
    expect(state?.mutationGeneration).toBeGreaterThanOrEqual(
      WRITERS * WRITES_PER_WRITER,
    );
    expect(state?.dirtySince).toBeUndefined();
    expect(published.get(state?.latestCaptureId ?? "")?.snapshot).toBe(
      snapshot(),
    );
  });
});
