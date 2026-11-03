import { env } from "cloudflare:test";
import type { ThreadChangesCaptureId } from "@dx/api";
import { ProjectRepository, type ThreadId, ThreadRepository } from "@dx/domain";
import type { Sandbox, SandboxFactory } from "@flue/runtime";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  authorizeCommandWithChangesLease,
  withCommandActivity,
  withThreadChangesIfSourced,
} from "../../src/execution/activation.js";
import type { WorkspaceActivity } from "../../src/execution/activity.js";
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

/*
 * Writers either take their lease in the Changes coordinator, or (the agent's
 * path, #1520) in their authorization's D1 batch, handed to the coordinator.
 */
const PATHS = [
  {
    via: "the coordinator",
    projectId: "prj_00000000-0000-4000-8000-000000001451",
    threadId: "thr_00000000-0000-4000-8000-000000001451" as ThreadId,
  },
  {
    via: "command authorization",
    projectId: "prj_00000000-0000-4000-8000-000000001520",
    threadId: "thr_00000000-0000-4000-8000-000000001520" as ThreadId,
  },
  // As the agent runs it (#1589): each write's result returns first, and
  // its lease is released, and Changes refreshed, right after.
  {
    via: "command authorization, settling after each result",
    projectId: "prj_00000000-0000-4000-8000-000000001589",
    threadId: "thr_00000000-0000-4000-8000-000000001589" as ThreadId,
  },
] as const;

/** A Thread with a GitHub source, so its writes are coordinated. */
const seed = async (projectId: string, threadId: ThreadId) => {
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
};

/**
 * The workspace's files, and a resident capturer that models dxd: on each
 * refresh it takes the capture lease, reads the state, snapshots the files,
 * and publishes with the generation it read.
 */
const workspace = (threadId: ThreadId) => {
  // The workspace: files, and how many writes are running right now.
  const files = new Map<string, string>();
  let writing = 0;
  const snapshot = () =>
    JSON.stringify([...files.entries()].sort(([a], [b]) => a.localeCompare(b)));
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
  return {
    files,
    snapshot,
    primitive,
    repository,
    published,
    violations,
    capturing,
    residentRefresh,
  };
};

/**
 * The database, except that the next release of a command's mutation lease
 * is lost, as when its Durable Object is evicted before the release runs.
 */
const losingNextRelease = (database: D1Database) => {
  const sqlOf = new WeakMap<object, string>();
  const realOf = new WeakMap<object, D1PreparedStatement>();
  let armed = false;
  const statement = (
    real: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement => {
    const wrapped = new Proxy(real, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) =>
            statement(target.bind(...values), sql);
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    sqlOf.set(wrapped, sql);
    realOf.set(wrapped, real);
    return wrapped;
  };
  const db = new Proxy(database, {
    get(inner, property) {
      if (property === "prepare")
        return (sql: string) => statement(inner.prepare(sql), sql);
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const releases =
            /^\s*DELETE FROM thread_changes_mutation_lease\s+WHERE thread_id = \? AND lease_token = \?/;
          if (armed && releases.test(sqlOf.get(statements[0] ?? {}) ?? "")) {
            armed = false;
            throw new Error("The release was lost.");
          }
          return inner.batch(
            statements.map((item) => realOf.get(item) ?? item),
          );
        };
      const value = Reflect.get(inner, property, inner);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
  return {
    db,
    loseNextRelease: () => {
      armed = true;
    },
  };
};

describe("Thread Changes with concurrent agent writers", () => {
  it.each(PATHS)(
    "never publishes a capture taken mid-write and ends on every write, leasing through $via",
    async ({ via, projectId, threadId }) => {
      await seed(projectId, threadId);
      const {
        files,
        snapshot,
        primitive,
        repository,
        published,
        violations,
        capturing,
        residentRefresh,
      } = workspace(threadId);

      const settlements: Array<Promise<unknown>> = [];
      const coordinated = await withThreadChangesIfSourced(
        { createSandbox: async () => primitive } satisfies SandboxFactory,
        {
          db: env.DB,
          bucket: env.DX_STORAGE,
          threadId,
          residentRefresh,
          ...(via.endsWith("after each result")
            ? { waitUntil: (settlement) => settlements.push(settlement) }
            : {}),
        },
      );
      const sandbox = await (via.startsWith("command authorization")
        ? withCommandActivity(
            coordinated,
            () =>
              ({
                runCommand: (_timeoutMs: number, run: () => Promise<unknown>) =>
                  run(),
              }) as unknown as WorkspaceActivity,
            60_000,
            authorizeCommandWithChangesLease(env.DB, threadId),
          )
        : coordinated
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
      if (via.endsWith("after each result"))
        expect(settlements).toHaveLength(WRITERS * WRITES_PER_WRITER);
      // What a Durable Object keeps alive after the last result.
      await Promise.all(settlements);
      while (capturing.size > 0) await Promise.all([...capturing]);

      expect(violations).toEqual([]);
      expect(files.size).toBe(WRITERS * 2);
      const state = await repository.read(threadId);
      expect(state).toMatchObject({
        activeMutations: 0,
        latestCaptureGeneration: state?.mutationGeneration,
      });
      // Exactly one lease per write, plus the initial sync's: a write whose
      // authorization took a lease used it, and mkdir took none.
      expect(state?.mutationGeneration).toBe(WRITERS * WRITES_PER_WRITER + 1);
      expect(state?.dirtySince).toBeUndefined();
      expect(published.get(state?.latestCaptureId ?? "")?.snapshot).toBe(
        snapshot(),
      );
    },
  );

  it("writes no lease or generation for a command it refuses: an archived Thread, or a refused run", async () => {
    const projectId = "prj_00000000-0000-4000-8000-000000001521";
    const threadId = "thr_00000000-0000-4000-8000-000000001521" as ThreadId;
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).insert(
          project(projectId, "owner-a", "Archived writer"),
        );
        yield* (yield* ThreadRepository).insert(
          thread(threadId, projectId, "owner-a"),
        );
      }),
    );
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(threadId)
      .run();
    const authorize = authorizeCommandWithChangesLease(env.DB, threadId);
    await expect(authorize("writeFile")).rejects.toThrow(
      "Thread is not active.",
    );
    // A run its admission refused takes no lease either, active or not.
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'active' WHERE id = ?",
    )
      .bind(threadId)
      .run();
    const refusedRun = Promise.reject(
      new Error("Source authorization denied."),
    );
    refusedRun.catch(() => undefined);
    await expect(
      authorizeCommandWithChangesLease(
        env.DB,
        threadId,
        refusedRun,
      )("writeFile"),
    ).rejects.toThrow("Source authorization denied.");
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS count FROM thread_changes_mutation_lease WHERE thread_id = ?",
      )
        .bind(threadId)
        .first<number>("count"),
    ).toBe(0);
    expect(
      (await makeThreadChangesRepository(env.DB).read(threadId))
        ?.mutationGeneration ?? 0,
    ).toBe(0);
  });

  it("frees the Workspace when a command's release is lost: Changes stays stale, never wrong, until the lease expires", async () => {
    const projectId = "prj_00000000-0000-4000-8000-000000001595";
    const threadId = "thr_00000000-0000-4000-8000-000000001595" as ThreadId;
    await seed(projectId, threadId);
    const {
      snapshot,
      primitive,
      repository,
      published,
      capturing,
      residentRefresh,
    } = workspace(threadId);
    const { db, loseNextRelease } = losingNextRelease(env.DB);
    const settlements: Array<Promise<unknown>> = [];
    const settled = async () => {
      await Promise.all(settlements);
      while (capturing.size > 0) await Promise.all([...capturing]);
    };
    let initialSync = () => {};
    const synced = new Promise<void>((resolve) => {
      initialSync = resolve;
    });
    const coordinated = await withThreadChangesIfSourced(
      { createSandbox: async () => primitive } satisfies SandboxFactory,
      {
        db,
        bucket: env.DX_STORAGE,
        threadId,
        residentRefresh,
        waitUntil: (settlement) => settlements.push(settlement),
        onInitialSyncSettled: () => initialSync(),
      },
    );
    const sandbox = await withCommandActivity(
      coordinated,
      () =>
        ({
          runCommand: (_timeoutMs: number, run: () => Promise<unknown>) =>
            run(),
        }) as unknown as WorkspaceActivity,
      60_000,
      authorizeCommandWithChangesLease(db, threadId),
    ).createSandbox({ id: threadId });
    await synced;
    await settled();
    const leases = () =>
      env.DB.prepare(
        "SELECT count(*) AS count FROM thread_changes_mutation_lease WHERE thread_id = ?",
      )
        .bind(threadId)
        .first<number>("count");

    // The first write's result returns; its release is lost.
    loseNextRelease();
    await sandbox.writeFile("/home/user/workspace/repo/a.txt", "a");
    await settled();
    expect(await leases()).toBe(1);
    // The next writer still gets its own lease, and its release still runs,
    // but no capture publishes while the lost lease holds: Changes says
    // stale rather than settling on a state that may miss a write.
    await sandbox.writeFile("/home/user/workspace/repo/b.txt", "b");
    await settled();
    const held = await repository.read(threadId);
    expect(held).toMatchObject({ activeMutations: 1 });
    expect(held?.dirtySince).toBeDefined();
    expect(published.size).toBe(0);

    // The lost lease expires (MUTATION_LEASE_MS after its last renewal).
    await env.DB.prepare(
      "UPDATE thread_changes_mutation_lease SET expires_at = ? WHERE thread_id = ?",
    )
      .bind(Date.now() - 1, threadId)
      .run();
    await sandbox.writeFile("/home/user/workspace/repo/c.txt", "c");
    await settled();
    const state = await repository.read(threadId);
    expect(state).toMatchObject({
      activeMutations: 0,
      latestCaptureGeneration: state?.mutationGeneration,
    });
    expect(state?.dirtySince).toBeUndefined();
    expect(published.get(state?.latestCaptureId ?? "")?.snapshot).toBe(
      snapshot(),
    );
    expect(JSON.parse(snapshot())).toHaveLength(3);
  });
});
