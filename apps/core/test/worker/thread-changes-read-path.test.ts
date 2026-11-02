import { env } from "cloudflare:test";
import {
  type ProjectId,
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { makeThreadChangesRepository } from "../../src/thread-changes/repository-d1.js";
import { publishThreadChangesResidentCandidate } from "../../src/thread-changes/resident-publisher.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

// #1424: the Changes read authorizes the Thread once, before it reads any
// capture, serves a capture's index from the colo cache only under that
// Thread's ID, and leaves expired mutation leases to the writers.
const appOrigin = "http://dx.test";

/**
 * D1 that records each statement it prepares, including through the
 * sessions `withSession` returns: the app runs every request's queries in a
 * D1 session (persistence/d1-session.ts).
 */
const recordingD1 = () => {
  const statements: string[] = [];
  const record = <T extends D1Database | D1DatabaseSession>(target: T): T =>
    new Proxy(target, {
      get(inner, property) {
        if (property === "prepare")
          return (sql: string) => {
            statements.push(sql);
            return inner.prepare(sql);
          };
        if (property === "withSession" && "withSession" in inner)
          return (...args: Parameters<D1Database["withSession"]>) =>
            record(inner.withSession(...args));
        const value = Reflect.get(inner, property, inner);
        return typeof value === "function" ? value.bind(inner) : value;
      },
    });
  return { db: record(env.DB), statements };
};

/** R2 that counts reads. */
const countingBucket = () => {
  let gets = 0;
  const bucket = new Proxy(env.DX_STORAGE, {
    get(target, property) {
      if (property === "get")
        return (...args: Parameters<R2Bucket["get"]>) => {
          gets += 1;
          return target.get(...args);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { bucket, gets: () => gets };
};

let sequence = 0;
const signUp = async (label: string) => {
  sequence += 1;
  const email = `changes-${label}-${crypto.randomUUID()}@example.com`;
  const bindings = {
    DB: env.DB,
    DX_ENV: "local",
    DX_RUNTIME_MODE: "deployed",
    DX_AUTH_URL: appOrigin,
    DX_AUTH_TRUSTED_ORIGINS: appOrigin,
    BETTER_AUTH_SECRET: "changes-read-path-secret-000000000000000",
  } satisfies Bindings;
  const response = await app.request(
    `${appOrigin}/api/auth/sign-up/email`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: appOrigin,
        "cf-connecting-ip": `203.0.113.${sequence % 250}`,
      },
      body: JSON.stringify({ name: label, email, password: "changes-pw-123" }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers
    .get("set-cookie")
    ?.match(/better-auth\.session_token=[^;,]+/)?.[0];
  if (cookie === undefined) throw new Error("Expected a session cookie.");
  const userId = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id");
  if (userId === null) throw new Error("Expected a user.");
  return { cookie, bindings, userId: Schema.decodeSync(UserId)(userId) };
};

/** A sourced Thread with one published capture that changed `path`. */
const threadWithCapture = async (ownerUserId: UserId, path: string) => {
  sequence += 1;
  const suffix = `${Date.now().toString(16).slice(-8)}${String(sequence).padStart(4, "0")}`;
  const projectEntity = project(
    `prj_00000000-0000-4000-8000-${suffix}`,
    ownerUserId,
    `Changes read ${suffix}`,
  );
  const threadId = `thr_00000000-0000-4000-8000-${suffix}` as ThreadId;
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(projectEntity);
      yield* (yield* ThreadRepository).insert(
        thread(threadId, projectEntity.id as ProjectId, ownerUserId),
      );
    }),
  );
  await env.DB.prepare(`
    INSERT INTO thread_source_snapshot (
      thread_id, project_id, binding_revision, provider,
      repository_full_name, clone_url, default_branch, initial_ref,
      initial_commit_sha, created_at
    ) VALUES (?, ?, 1, 'github', 'owner/repository',
      'https://github.com/owner/repository.git', 'main',
      'refs/heads/main', ?, '2026-11-01T12:00:00.000Z')
  `)
    .bind(threadId, projectEntity.id, "a".repeat(40))
    .run();
  const mutation = await makeThreadChangesRepository(env.DB).beginMutation(
    threadId,
    60_000,
  );
  await mutation.release();
  await expect(
    publishThreadChangesResidentCandidate({
      db: env.DB,
      bucket: env.DX_STORAGE,
      threadId,
      candidate: {
        type: "changes-candidate",
        token: mutation.refreshToken,
        outcome: {
          kind: "complete",
          capture: {
            fingerprint: crypto.randomUUID().replaceAll("-", "").repeat(2),
            baseline: "a".repeat(40),
            head: "a".repeat(40),
            branch: "main",
            upstreamLabel: null,
            ahead: 0,
            commits: [],
            ranges: [
              {
                range: { kind: "all" },
                truncated: false,
                summary: { additions: 1, deletions: 0, files: 1 },
                files: [
                  {
                    path,
                    status: "added",
                    additions: 1,
                    deletions: 0,
                    binary: false,
                    truncated: false,
                    patch: `@@ -0,0 +1 @@\n+${path}\n`,
                  },
                ],
              },
            ],
          },
        },
      },
    }),
  ).resolves.toBe("published");
  return threadId;
};

const authorizations = (statements: readonly string[]) =>
  statements.filter(
    (sql) => /FROM threads/.test(sql) && /snooze_woke_at/.test(sql),
  ).length;
const stateReads = (statements: readonly string[]) =>
  statements.filter((sql) => /FROM thread_changes_state AS state/.test(sql))
    .length;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("The Changes read path", () => {
  it("authorizes once before any capture read and keys the index cache by Thread", async () => {
    const owner = await signUp("owner");
    const other = await signUp("other");
    const ownerThread = await threadWithCapture(owner.userId, "owner-notes.md");
    const otherThread = await threadWithCapture(other.userId, "other-notes.md");
    const cacheOpens = vi.spyOn(caches, "open");
    const read = async (
      signedIn: typeof owner,
      threadId: ThreadId,
      bindings: Partial<Bindings> = {},
    ) => {
      const d1 = recordingD1();
      const r2 = countingBucket();
      cacheOpens.mockClear();
      const response = await app.request(
        `${appOrigin}/v1/threads/${threadId}/changes?range=all`,
        { headers: { cookie: signedIn.cookie } },
        {
          ...signedIn.bindings,
          DB: d1.db,
          DX_STORAGE: r2.bucket,
          ...bindings,
        },
      );
      return {
        response,
        authorizations: authorizations(d1.statements),
        stateReads: stateReads(d1.statements),
        r2Gets: r2.gets(),
        cacheOpens: cacheOpens.mock.calls.length,
      };
    };

    // The owner's first read authorizes once and fills the cache from R2.
    const first = await read(owner, ownerThread);
    expect(first.response.status).toBe(200);
    expect(await first.response.json()).toMatchObject({
      data: { kind: "changes", files: [{ path: "owner-notes.md" }] },
    });
    expect(first.authorizations).toBe(1);
    expect(first.r2Gets).toBeGreaterThan(0);

    // The next read takes the index from the cache: no R2 read.
    const second = await read(owner, ownerThread);
    expect(second.response.status).toBe(200);
    expect(second.authorizations).toBe(1);
    expect(second.r2Gets).toBe(0);
    expect(second.cacheOpens).toBeGreaterThan(0);

    // Another user is refused before the Changes state, the cache, or R2.
    const refused = await read(other, ownerThread);
    expect(refused.response.status).toBe(404);
    expect(refused.stateReads).toBe(0);
    expect(refused.cacheOpens).toBe(0);
    expect(refused.r2Gets).toBe(0);

    // Even a pointer forged to the owner's cached capture misses: the cache
    // key and the R2 key carry the requesting Thread's ID.
    const ownerState = await env.DB.prepare(
      "SELECT * FROM thread_changes_state WHERE thread_id = ?",
    )
      .bind(ownerThread)
      .first<Record<string, unknown>>();
    await env.DB.prepare(
      `UPDATE thread_changes_state
          SET latest_capture_id = ?, latest_capture_generation = ?,
              latest_fingerprint = ?, latest_captured_at = ?
        WHERE thread_id = ?`,
    )
      .bind(
        ownerState?.latest_capture_id,
        ownerState?.latest_capture_generation,
        ownerState?.latest_fingerprint,
        ownerState?.latest_captured_at,
        otherThread,
      )
      .run();
    const forged = await read(other, otherThread);
    expect(forged.response.status).toBe(503);
    expect(await forged.response.text()).not.toContain("owner-notes.md");
  });

  it("collects expired mutation leases on capture, not on reads, and never lets one block", async () => {
    const owner = await signUp("leases");
    const threadId = await threadWithCapture(owner.userId, "lease-notes.md");
    const repository = makeThreadChangesRepository(env.DB);
    const leaseRows = async () =>
      env.DB.prepare(
        "SELECT count(*) AS count FROM thread_changes_mutation_lease WHERE thread_id = ?",
      )
        .bind(threadId)
        .first<number>("count");

    // A Workspace mutation that ended abruptly: its lease expires in place.
    await repository.beginMutation(threadId, 60_000);
    await env.DB.prepare(
      "UPDATE thread_changes_mutation_lease SET expires_at = ? WHERE thread_id = ?",
    )
      .bind(Date.now() - 1, threadId)
      .run();

    // A read ignores it and writes nothing.
    const d1 = recordingD1();
    expect(
      await makeThreadChangesRepository(d1.db).read(threadId),
    ).toMatchObject({ activeMutations: 0 });
    expect(
      d1.statements.filter((sql) => /^\s*(DELETE|INSERT|UPDATE)/i.test(sql)),
    ).toEqual([]);
    expect(await leaseRows()).toBe(1);

    // A new mutation leases beside it, and its lease alone is active.
    const next = await repository.beginMutation(threadId, 60_000);
    expect(await repository.read(threadId)).toMatchObject({
      activeMutations: 1,
    });
    await next.release();

    // Taking the capture lease collects the expired row.
    const capture = await repository.acquireCapture(threadId, 60_000);
    expect(capture).toBeDefined();
    await capture?.release();
    expect(await leaseRows()).toBe(0);
  });
});
