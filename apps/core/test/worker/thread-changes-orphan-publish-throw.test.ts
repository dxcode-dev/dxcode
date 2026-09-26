import { env } from "cloudflare:test";
import {
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
  UserId,
} from "@dx/domain";
import type { Sandbox } from "@flue/runtime";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  captureKey,
  loadThreadChangesCapture,
  type ThreadChangesManifest,
} from "../../src/thread-changes/capture.js";
import { makeThreadChangesCoordinator } from "../../src/thread-changes/coordinator.js";
import {
  makeThreadChangesRepository,
  ThreadChangesPersistenceUnavailable,
} from "../../src/thread-changes/repository-d1.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

// Wraps a real D1Database so the publish UPDATE (uniquely identified by
// "SET latest_capture_id =") rejects, simulating a D1 transient failure. Every
// other statement reads/writes the real D1 — so the fix's confirmatory re-read
// observes real committed state.
const wrapDbToThrowOnPublish = (real: D1Database): D1Database => {
  const reject = async () => {
    throw new Error("D1 transient unavailable");
  };
  const throwingBound = {
    run: reject,
    first: reject,
    all: reject,
    raw: reject,
  };
  const throwingStmt = {
    bind: () => throwingBound,
    run: reject,
    first: reject,
    all: reject,
    raw: reject,
  } as unknown as D1PreparedStatement;
  const prepare = (sql: string): D1PreparedStatement =>
    sql.includes("SET latest_capture_id =") ? throwingStmt : real.prepare(sql);
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "prepare") return prepare;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
};

const completeCaptureStdout = JSON.stringify({
  kind: "complete",
  fingerprint: "b".repeat(64),
  baseline: "a".repeat(40),
  head: "a".repeat(40),
  branch: null,
  upstreamLabel: null,
  ahead: 0,
  commits: [],
  ranges: [],
});

const fakeSandbox = {
  cwd: "/repo",
  exec: async () => ({
    exitCode: 0,
    stdout: completeCaptureStdout,
    stderr: "",
  }),
} as unknown as Sandbox;

const now = "2026-09-03T10:00:00.000Z";

const seedThreadWithSource = async (
  threadId: ThreadId,
  projectId: string,
  owner: string,
) => {
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
  )
    .bind(owner, "Orphan Owner", "orphan@example.test", now, now)
    .run();
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(
        project(projectId, owner, "orphan-leak", now),
      );
    }),
  );
  await env.DB.prepare(
    `INSERT INTO github_installation (
       installation_id, app_id, provider_account_id, provider_account_type,
       provider_account_login, repository_selection, status,
       permissions_version, created_at, updated_at
     ) VALUES ('9900', '12345', '8800', 'user', 'owner', 'selected', 'active', 1, ?, ?)`,
  )
    .bind(now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO github_owner_grant (
       id, owner_scope, owner_id, installation_id, status,
       created_by_user_id, created_at, updated_at
     ) VALUES ('grant-orphan', 'personal', ?, '9900', 'active', ?, ?, ?)`,
  )
    .bind(owner, owner, now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO github_installation_repository (
       installation_id, provider_repository_id, full_name, web_url,
       visibility, entitled, last_reconciled_at
     ) VALUES ('9900', '7900', 'owner/orphan',
       'https://github.com/owner/orphan', 'private', 1, ?)`,
  )
    .bind(now)
    .run();
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ThreadRepository).insert(
        thread(threadId, projectId, owner, now),
      );
    }),
  );
  // Seed the source snapshot directly so repository.source(threadId) resolves
  // (the coordinator's flush returns "missing" without a snapshot). A raw insert
  // sidesteps the source_admission_assertion / project_repository binding that
  // ThreadRepository.insert(thread, snapshot) would require; repository.source
  // only reads this row.
  await env.DB.prepare(
    `INSERT INTO thread_source_snapshot (
       thread_id, project_id, binding_revision, provider,
       repository_full_name, clone_url, default_branch,
       initial_ref, initial_commit_sha, created_at
     ) VALUES (?, ?, 1, 'github',
       'owner/orphan', 'https://github.com/owner/orphan.git', 'main',
       'refs/heads/main', ?, ?)`,
  )
    .bind(threadId, projectId, "a".repeat(40), now)
    .run();
};

const captureIdsIn = async (bucket: R2Bucket, threadId: ThreadId) =>
  (
    await bucket.list({ prefix: `threads/${threadId}/changes/v1/` })
  ).objects.map((object) => object.key);

describe("thread changes orphan cleanup on D1 publish throw (integration)", () => {
  it("deletes the just-uploaded capture when publish throws and the prior pointer is intact", async () => {
    const owner = Schema.decodeUnknownSync(UserId)("orphan-leak-owner");
    const projectId = "prj_00000000-0000-4000-8000-000000000301";
    const threadId = "thr_00000000-0000-4000-8000-000000000301" as ThreadId;
    await seedThreadWithSource(threadId, projectId, owner);

    const bucket = env.DX_STORAGE;

    // First flush against the real D1: publishes capture A successfully.
    const coordinatorOk = makeThreadChangesCoordinator({
      db: env.DB,
      bucket,
      threadId,
      sandbox: fakeSandbox,
    });
    await expect(coordinatorOk.flush()).resolves.toBe("captured");

    const repository = makeThreadChangesRepository(env.DB);
    const stateAfterFirst = await repository.read(threadId);
    expect(stateAfterFirst?.latestCaptureId).toBeDefined();
    const captureA = stateAfterFirst?.latestCaptureId as string;
    const keysAfterFirst = await captureIdsIn(bucket, threadId);
    expect(keysAfterFirst).toHaveLength(1);
    expect(keysAfterFirst[0]).toBe(captureKey(threadId, captureA));

    // Second flush against a D1 that throws on the publish UPDATE: the just
    // uploaded capture B must be deleted and the original publish error
    // rethrown — leaving only capture A in the bucket and the pointer on A.
    const coordinatorThrow = makeThreadChangesCoordinator({
      db: wrapDbToThrowOnPublish(env.DB),
      bucket,
      threadId,
      sandbox: fakeSandbox,
    });
    await expect(coordinatorThrow.flush()).rejects.toBeInstanceOf(
      ThreadChangesPersistenceUnavailable,
    );

    const keysAfterSecond = await captureIdsIn(bucket, threadId);
    expect(keysAfterSecond).toEqual(keysAfterFirst);
    expect(keysAfterSecond).toHaveLength(1);

    const stateAfterSecond = await repository.read(threadId);
    expect(stateAfterSecond?.latestCaptureId).toBe(captureA);

    const reloaded = await loadThreadChangesCapture(
      bucket,
      threadId,
      captureA as never,
    );
    expect((reloaded as ThreadChangesManifest).captureId).toBe(captureA);
  });
});
