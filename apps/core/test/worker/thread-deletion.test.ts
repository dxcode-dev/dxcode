/**
 * Thread deletion in workerd with real D1, R2, the owner's search-index
 * Durable Object, and the Thread's execution Durable Object. Flue's agent
 * object and the sandbox provider are not in this pool; the cleanup they
 * expose is recorded here and proven on a deployed preview.
 *
 * Ways it could fail, each covered below:
 *  1. Someone other than the owner (an outsider, or a workspace member the
 *     Thread is shared with for Contribute) deletes it.
 *  2. The deleted Thread still lists, refreshes as a row, opens, answers its
 *     agent routes, or shows up in search.
 *  3. The ID is freed: a create naming it succeeds, or the tombstone can be
 *     restored or removed with SQL.
 *  4. The tombstone keeps the title or the owner's instructions.
 *  5. Notifications, sidebar placement, or sharing records survive.
 *  6. Child Threads vanish with their parent, or stay hidden under it.
 *  7. Changes snapshots or the Thread's files survive in R2, or a file also
 *     sent in another Thread is deleted with it.
 *  8. The owner's search index keeps the Thread's messages.
 *  9. The execution object keeps its storage.
 * 10. Flue history or the sandbox is not erased.
 * 11. A failed step reports success or is never retried; a repeat DELETE or
 *     the cron does not finish it; a finished cleanup runs again.
 * 12. The owner is told "not found" instead of "deleted", or anyone else is
 *     told it was deleted.
 *
 * Deleting a Thread with its children (`?includeChildren=true`):
 * 13. It deletes a Thread the sidebar does not list under the parent: a
 *     pinned child, a child archived while the parent is active, or an
 *     unrelated Thread.
 * 14. A listed child is only detached, or keeps its history, sandbox,
 *     search text, Changes, or execution storage.
 * 15. The response names a child it did not delete, or omits one it did.
 * 16. Someone other than the owner deletes the family.
 */
import { env, runInDurableObject } from "cloudflare:test";
import {
  Principal,
  type ProjectId,
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import {
  sweepThreadDeletions,
  type ThreadCleanup,
} from "../../src/thread-deletion/cleanup.js";
import { createThreadDeletionRoutes } from "../../src/thread-deletion/routes.js";
import { ownerSearchIndex } from "../../src/thread-search/index-client.js";
import { threadSharingRoutes } from "../../src/thread-sharing/routes.js";
import { threadRoutes } from "../../src/threads/routes.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

const owner = "deletion-owner" as UserId;
const member = "deletion-member" as UserId;
const outsider = "deletion-outsider" as UserId;
const workspaceId = "deletion-workspace";
const ownerProject = project(
  "prj_00000000-0000-4000-8000-000000000d01",
  owner,
  "deletion-personal",
);
const parent = thread(
  "thr_00000000-0000-4000-8000-000000000d01",
  ownerProject.id as ProjectId,
  owner,
);
const other = thread(
  "thr_00000000-0000-4000-8000-000000000d02",
  ownerProject.id as ProjectId,
  owner,
);
const child = thread(
  "thr_00000000-0000-4000-8000-000000000d03",
  ownerProject.id as ProjectId,
  owner,
);
const sibling = thread(
  "thr_00000000-0000-4000-8000-000000000d04",
  ownerProject.id as ProjectId,
  owner,
);
const pinnedChild = thread(
  "thr_00000000-0000-4000-8000-000000000d05",
  ownerProject.id as ProjectId,
  owner,
);
const archivedChild = thread(
  "thr_00000000-0000-4000-8000-000000000d06",
  ownerProject.id as ProjectId,
  owner,
);
const secret = "Owner-only instructions: rotate the staging key.";

const bindings: Bindings = {
  DB: env.DB,
  DX_STORAGE: env.DX_STORAGE,
  THREAD_EXECUTION: env.THREAD_EXECUTION as unknown as DurableObjectNamespace,
  THREAD_SEARCH_INDEX: env.THREAD_SEARCH_INDEX,
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
};

/** Records Flue and sandbox cleanup; `failing` makes those steps throw. */
const recordingCleanup = () => {
  const calls: Array<[keyof ThreadCleanup, ThreadId]> = [];
  const failing = new Set<keyof ThreadCleanup>();
  const step =
    (name: keyof ThreadCleanup) =>
    async (threadId: ThreadId): Promise<void> => {
      calls.push([name, threadId]);
      if (failing.has(name)) throw new Error(`${name} unavailable`);
    };
  const cleanup: ThreadCleanup = {
    eraseAgentHistory: step("eraseAgentHistory"),
    destroySandbox: step("destroySandbox"),
  };
  return { cleanup, calls, failing };
};

let recorder = recordingCleanup();

const createApp = (userId: UserId) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  app.route("/threads", threadRoutes);
  app.route("/threads", threadSharingRoutes);
  app.route(
    "/threads",
    createThreadDeletionRoutes(() => recorder.cleanup),
  );
  app.use("/agents/:threadId", authorizeThread);
  app.all("/agents/:threadId", (context) => context.json({ agent: true }));
  app.onError(errorHandler);
  return app;
};

const send = (userId: UserId, path: string, method = "GET", body?: unknown) =>
  createApp(userId).request(
    path,
    {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );

const remove = (threadId: string, userId = owner) =>
  send(userId, `/threads/${threadId}`, "DELETE");

const json = async (response: Response) =>
  (await response.json()) as {
    status: string;
    data: Record<string, unknown> & { code?: string };
  };

const listedIds = async () =>
  (
    await (
      await send(owner, "/threads?lifecycleState=active")
    ).json<{
      data: { items: Array<{ id: string }> };
    }>()
  ).data.items.map(({ id }) => id);

const user = (id: string, name: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`);

const count = async (sql: string, ...values: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...values)
      .first<{ n: number }>()
  )?.n;

const attachment = (id: string) => ({
  id,
  key: `attachments/${owner}/${id}`,
});
const onlyHere = attachment(`att_${"a".repeat(32)}`);
const alsoElsewhere = attachment(`att_${"b".repeat(32)}`);

/** Everything a working Thread leaves outside its row. */
const seedThreadData = async () => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO notification (id, recipient_user_id, topic, source_key, thread_id, excerpt, created_at)
       VALUES (?, ?, 'turn.completed', 'turn:1', ?, 'Deploy key is hunter2', ?)`,
    ).bind(`ntf_${"c".repeat(32)}`, owner, parent.id, now),
    env.DB.prepare(
      `INSERT INTO sidebar_layout_entry (user_id, kind, item_id, open, updated_at)
       VALUES (?, 'thread', ?, 1, ?)`,
    ).bind(owner, parent.id, now),
    env.DB.prepare(
      `INSERT INTO thread_follower (thread_id, user_id, followed_at) VALUES (?, ?, ?)`,
    ).bind(parent.id, member, now),
    env.DB.prepare(
      `INSERT INTO thread_seen (thread_id, user_id, seen_at) VALUES (?, ?, ?)`,
    ).bind(parent.id, member, now),
    env.DB.prepare(
      `INSERT INTO thread_schedule (thread_id, owner_user_id, title, prompt, rrule, time_zone, label, run_mode, enabled, next_run_at, created_at, updated_at)
       VALUES (?, ?, 'Nightly', 'Run it', 'FREQ=DAILY', 'UTC', 'Daily', 'existing', 1, ?, ?, ?)`,
    ).bind(parent.id, owner, now, now, now),
    env.DB.prepare(
      `INSERT INTO github_subscription (id, owner_user_id, thread_id, title, repository, filter_kind, filter_json, destination, automatic, enabled, state, equivalence_key, next_poll_at, created_at, updated_at)
       VALUES (?, ?, ?, 'CI', 'o/r', 'ci', '{}', 'this-thread', 0, 1, 'active', ?, ?, ?, ?)`,
    ).bind(
      `ghs_${"d".repeat(32)}`,
      owner,
      parent.id,
      "e".repeat(64),
      now,
      now,
      now,
    ),
    env.DB.prepare(
      "UPDATE threads SET agent_instructions = ?, parent_thread_id = NULL WHERE id = ?",
    ).bind(secret, parent.id),
    env.DB.prepare("UPDATE threads SET parent_thread_id = ? WHERE id = ?").bind(
      parent.id,
      child.id,
    ),
    ...[onlyHere, alsoElsewhere].map((file) =>
      env.DB.prepare(
        `INSERT INTO attachments (id, uploader_user_id, object_key, filename, mime_type, size, state, created_at)
         VALUES (?, ?, ?, 'notes.txt', 'text/plain', 5, 'ready', 1)`,
      ).bind(file.id, owner, file.key),
    ),
    env.DB.prepare(
      `INSERT INTO attachment_threads (attachment_id, thread_id, sender_user_id, created_at)
       VALUES (?1, ?3, ?4, 1), (?2, ?3, ?4, 1), (?2, ?5, ?4, 1)`,
    ).bind(onlyHere.id, alsoElsewhere.id, parent.id, owner, other.id),
  ]);
  await env.DX_STORAGE.put(onlyHere.key, "hello");
  await env.DX_STORAGE.put(alsoElsewhere.key, "world");
  await env.DX_STORAGE.put(
    `threads/${parent.id}/changes/v1/capture-1.json`,
    "{}",
  );
  await env.DX_STORAGE.put(
    `threads/${other.id}/changes/v1/capture-1.json`,
    "{}",
  );
  await ownerSearchIndex(bindings, owner)?.indexMessages(
    parent.id,
    "Rotate staging key",
    [{ messageId: "m1", role: "user", text: "the staging key is hunter2" }],
  );
  await runInDurableObject(
    env.THREAD_EXECUTION.get(env.THREAD_EXECUTION.idFromName(parent.id)),
    (_instance, state) => state.storage.put("environment-next-generation", 7),
  );
};

const indexedThreads = (threadId: string) =>
  runInDurableObject(
    env.THREAD_SEARCH_INDEX.get(
      env.THREAD_SEARCH_INDEX.idFromName(`owner:${owner}`),
    ),
    (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM indexed_thread WHERE thread_id = ?",
          threadId,
        )
        .one().n,
  );

const executionKeys = (threadId: string) =>
  runInDurableObject(
    env.THREAD_EXECUTION.get(env.THREAD_EXECUTION.idFromName(threadId)),
    async (_instance, state) => [...(await state.storage.list()).keys()],
  );

beforeEach(async () => {
  recorder = recordingCleanup();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachment_threads"),
    env.DB.prepare("DELETE FROM attachments"),
    user(owner, "Ada Owner"),
    user(member, "Ben Member"),
    user(outsider, "Cy Outsider"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Deletion Team', 'deletion-team', 1)",
    ).bind(workspaceId),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('d-owner', ?1, ?2, 'owner', 1), ('d-member', ?1, ?3, 'member', 2)`,
    ).bind(workspaceId, owner, member),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      const threads = yield* ThreadRepository;
      yield* projects.insert(ownerProject);
      yield* threads.insert(parent);
      yield* threads.insert(other);
      yield* threads.insert(child);
    }),
  );
});

describe("Thread deletion in workerd with real D1, R2, and Durable Objects", () => {
  it("refuses everyone but the owner, including a Contribute member", async () => {
    const shared = await send(owner, `/threads/${parent.id}/sharing`, "PUT", {
      workspaceAccess: "contribute",
      contributeFor: "1h",
      skipMultiplayerConfirmation: true,
    });
    expect(shared.status).toBe(200);
    expect((await send(member, `/agents/${parent.id}`)).status).toBe(200);

    for (const userId of [member, outsider]) {
      const response = await remove(parent.id, userId);
      expect(response.status).toBe(404);
      expect((await json(response)).data.code).toBe("THREAD_NOT_FOUND");
    }
    expect(
      await count(
        "SELECT count(*) AS n FROM threads WHERE id = ? AND lifecycle_state = 'active'",
        parent.id,
      ),
    ).toBe(1);
    expect(recorder.calls).toEqual([]);
  });

  it("removes the conversation, sandbox, and every stored copy, and keeps the ID", async () => {
    await seedThreadData();
    expect(await indexedThreads(parent.id)).toBe(1);
    expect(await executionKeys(parent.id)).toEqual([
      "environment-next-generation",
    ]);

    const response = await remove(parent.id);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.data).toMatchObject({
      threadId: parent.id,
      cleanup: "complete",
    });

    // Flue's history first (which stops a run), then the sandbox.
    expect(recorder.calls).toEqual([
      ["eraseAgentHistory", parent.id],
      ["destroySandbox", parent.id],
    ]);

    // The row is a scrubbed tombstone holding the ID.
    const row = await env.DB.prepare(
      "SELECT lifecycle_state, title, agent_instructions, owner_user_id FROM threads WHERE id = ?",
    )
      .bind(parent.id)
      .first();
    expect(row).toEqual({
      lifecycle_state: "deleted",
      title: "Deleted thread",
      agent_instructions: "",
      owner_user_id: owner,
    });
    const deletion = await env.DB.prepare(
      "SELECT owner_user_id, attempts, completed_at, last_error FROM thread_deletion WHERE thread_id = ?",
    )
      .bind(parent.id)
      .first<Record<string, unknown>>();
    expect(deletion).toMatchObject({
      owner_user_id: owner,
      attempts: 1,
      last_error: null,
    });
    expect(deletion?.completed_at).toEqual(expect.any(String));

    // Notifications, sidebar placement, sharing records, and automations
    // that would wake it are gone.
    for (const table of [
      "notification",
      "thread_follower",
      "thread_participant",
      "thread_seen",
      "thread_schedule",
      "github_subscription",
    ])
      expect(
        await count(
          `SELECT count(*) AS n FROM ${table} WHERE thread_id = ?`,
          parent.id,
        ),
      ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM sidebar_layout_entry WHERE item_id = ?",
        parent.id,
      ),
    ).toBe(0);

    // R2: its Changes and its own file go; another Thread's copies stay.
    expect(
      (await env.DX_STORAGE.list({ prefix: `threads/${parent.id}/` })).objects,
    ).toEqual([]);
    expect(await env.DX_STORAGE.head(onlyHere.key)).toBeNull();
    expect(await env.DX_STORAGE.head(alsoElsewhere.key)).not.toBeNull();
    expect(
      (await env.DX_STORAGE.list({ prefix: `threads/${other.id}/` })).objects,
    ).toHaveLength(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM attachments WHERE id = ?",
        onlyHere.id,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM attachment_threads WHERE thread_id = ?",
        parent.id,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM attachment_threads WHERE attachment_id = ?",
        alsoElsewhere.id,
      ),
    ).toBe(1);

    // The search index and the execution object hold nothing of it.
    expect(await indexedThreads(parent.id)).toBe(0);
    expect(await executionKeys(parent.id)).toEqual([]);

    // The child is now a top-level Thread, still listed; the parent is not.
    const listed = await listedIds();
    expect(listed).toContain(child.id);
    expect(listed).toContain(other.id);
    expect(listed).not.toContain(parent.id);
    expect(
      await count(
        "SELECT count(*) AS n FROM threads WHERE id = ? AND parent_thread_id IS NULL",
        child.id,
      ),
    ).toBe(1);
  });

  it("tells the owner the Thread was deleted, and everyone else nothing", async () => {
    expect((await remove(parent.id)).status).toBe(200);

    const detail = await send(owner, `/threads/${parent.id}`);
    expect(detail.status).toBe(410);
    expect((await json(detail)).data.code).toBe("THREAD_DELETED");
    const agent = await send(owner, `/agents/${parent.id}`);
    expect(agent.status).toBe(410);
    expect((await json(agent)).data.code).toBe("THREAD_DELETED");
    expect((await send(owner, `/threads/${parent.id}/list-item`)).status).toBe(
      404,
    );

    for (const userId of [member, outsider]) {
      expect((await send(userId, `/threads/${parent.id}`)).status).toBe(404);
      expect((await send(userId, `/agents/${parent.id}`)).status).toBe(404);
    }
  });

  it("never issues the ID again", async () => {
    expect((await remove(parent.id)).status).toBe(200);
    const outsiderProject = project(
      "prj_00000000-0000-4000-8000-000000000d02",
      outsider,
      "outsider-personal",
    );
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).insert(outsiderProject);
      }),
    );
    // Both Projects run on a profile the test catalog offers, so creation
    // passes every gate and reaches the insert the tombstone refuses.
    await env.DB.prepare(
      "UPDATE projects SET runner_profile_id = 'a1.medium' WHERE id IN (?, ?)",
    )
      .bind(ownerProject.id, outsiderProject.id)
      .run();

    for (const [userId, projectId] of [
      [owner, ownerProject.id],
      [outsider, outsiderProject.id],
    ] as const) {
      const created = await send(userId, "/threads", "POST", {
        projectId,
        title: "Reused",
        threadId: parent.id,
        initialMessage: { body: "Start over", attachments: [] },
      });
      expect(created.status).toBe(409);
      expect((await json(created)).data.code).toBe("THREAD_ID_UNAVAILABLE");
    }
    await expect(
      env.DB.prepare(
        "UPDATE threads SET lifecycle_state = 'active' WHERE id = ?",
      )
        .bind(parent.id)
        .run(),
    ).rejects.toThrow(/tombstone is permanent/);
    await expect(
      env.DB.prepare("DELETE FROM threads WHERE id = ?").bind(parent.id).run(),
    ).rejects.toThrow(/tombstone is permanent|FOREIGN KEY/);
    expect(
      await count("SELECT count(*) AS n FROM threads WHERE id = ?", parent.id),
    ).toBe(1);
  });

  it("reports a failed step as pending and finishes it on retry or by cron", async () => {
    await seedThreadData();
    recorder.failing.add("destroySandbox");

    const first = await remove(parent.id);
    expect(first.status).toBe(200);
    expect((await json(first)).data.cleanup).toBe("pending");
    // The Thread is gone for the owner even while cleanup is pending.
    expect((await send(owner, `/threads/${parent.id}`)).status).toBe(410);
    expect(
      await env.DB.prepare(
        "SELECT attempts, completed_at, last_error FROM thread_deletion WHERE thread_id = ?",
      )
        .bind(parent.id)
        .first(),
    ).toEqual({
      attempts: 1,
      completed_at: null,
      last_error: "Failed: sandbox",
    });
    // Steps after the failed one still ran.
    expect(await indexedThreads(parent.id)).toBe(0);

    // Repeating the DELETE retries; still failing, still pending.
    const repeat = await remove(parent.id);
    expect(repeat.status).toBe(200);
    expect((await json(repeat)).data.cleanup).toBe("pending");

    // The cron skips a cleanup attempted within the retry interval...
    expect(
      await sweepThreadDeletions(bindings, recorder.cleanup, new Date()),
    ).toBe(0);
    expect(
      recorder.calls.filter(([name]) => name === "destroySandbox"),
    ).toHaveLength(2);

    // ...and finishes it once the provider recovers.
    recorder.failing.clear();
    const later = new Date(Date.now() + 6 * 60 * 1_000);
    expect(await sweepThreadDeletions(bindings, recorder.cleanup, later)).toBe(
      1,
    );
    expect(
      await env.DB.prepare(
        "SELECT attempts, last_error FROM thread_deletion WHERE thread_id = ?",
      )
        .bind(parent.id)
        .first(),
    ).toEqual({ attempts: 3, last_error: null });

    // A finished cleanup is not repeated, by the cron or by DELETE.
    const callsBefore = recorder.calls.length;
    expect(
      await sweepThreadDeletions(
        bindings,
        recorder.cleanup,
        new Date(Date.now() + 60 * 60 * 1_000),
      ),
    ).toBe(0);
    const done = await remove(parent.id);
    expect(done.status).toBe(200);
    expect((await json(done)).data.cleanup).toBe("complete");
    expect(recorder.calls.length).toBe(callsBefore);
  });
});

describe("Deleting a Thread with its children", () => {
  /** `child` and `sibling` list under `parent`; the other two do not. */
  const seedFamily = async () => {
    await runRepositories(
      Effect.gen(function* () {
        const threads = yield* ThreadRepository;
        yield* threads.insert(sibling);
        yield* threads.insert(pinnedChild);
        yield* threads.insert(archivedChild);
      }),
    );
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE threads SET parent_thread_id = ?1 WHERE id IN (?2, ?3, ?4, ?5)",
      ).bind(parent.id, child.id, sibling.id, pinnedChild.id, archivedChild.id),
      env.DB.prepare("UPDATE threads SET pinned_at = ? WHERE id = ?").bind(
        new Date().toISOString(),
        pinnedChild.id,
      ),
      env.DB.prepare(
        "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
      ).bind(archivedChild.id),
    ]);
    for (const { id } of [child, sibling]) {
      await env.DX_STORAGE.put(`threads/${id}/changes/v1/capture-1.json`, "{}");
      await ownerSearchIndex(bindings, owner)?.indexMessages(id, "Child work", [
        { messageId: `m-${id}`, role: "user", text: "child secret" },
      ]);
      await runInDurableObject(
        env.THREAD_EXECUTION.get(env.THREAD_EXECUTION.idFromName(id)),
        (_instance, state) =>
          state.storage.put("environment-next-generation", 3),
      );
    }
  };

  const lifecycle = async (threadId: string) =>
    (await env.DB.prepare(
      "SELECT lifecycle_state AS state, parent_thread_id AS parent FROM threads WHERE id = ?",
    )
      .bind(threadId)
      .first<{ state: string; parent: string | null }>()) ?? undefined;

  const removeFamily = (threadId: string, userId = owner) =>
    send(userId, `/threads/${threadId}?includeChildren=true`, "DELETE");

  it("deletes the parent and the children listed under it, and only those", async () => {
    await seedFamily();
    expect(await indexedThreads(child.id)).toBe(1);

    const response = await removeFamily(parent.id);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.data).toMatchObject({
      threadId: parent.id,
      cleanup: "complete",
    });
    expect([...(body.data.deletedChildThreadIds as string[])].sort()).toEqual(
      [child.id, sibling.id].sort(),
    );

    // The parent and its listed children are scrubbed tombstones.
    for (const id of [parent.id, child.id, sibling.id]) {
      expect(await lifecycle(id)).toEqual({ state: "deleted", parent: null });
      expect(
        await env.DB.prepare(
          "SELECT title, completed_at IS NOT NULL AS done FROM threads JOIN thread_deletion ON thread_id = id WHERE id = ?",
        )
          .bind(id)
          .first(),
      ).toEqual({ title: "Deleted thread", done: 1 });
      expect((await send(owner, `/threads/${id}`)).status).toBe(410);
    }

    // Each one's history and sandbox, then its stored copies, are gone.
    for (const id of [parent.id, child.id, sibling.id]) {
      expect(recorder.calls).toContainEqual(["eraseAgentHistory", id]);
      expect(recorder.calls).toContainEqual(["destroySandbox", id]);
    }
    for (const id of [child.id, sibling.id]) {
      expect(await indexedThreads(id)).toBe(0);
      expect(await executionKeys(id)).toEqual([]);
      expect(
        (await env.DX_STORAGE.list({ prefix: `threads/${id}/` })).objects,
      ).toEqual([]);
    }

    // A pinned child and an archived child are not listed under the
    // parent: they survive, detached, as top-level Threads.
    expect(await lifecycle(pinnedChild.id)).toEqual({
      state: "active",
      parent: null,
    });
    expect(await lifecycle(archivedChild.id)).toEqual({
      state: "archived",
      parent: null,
    });
    expect(await lifecycle(other.id)).toEqual({
      state: "active",
      parent: null,
    });
    for (const id of [pinnedChild.id, archivedChild.id, other.id])
      expect(recorder.calls.map(([, threadId]) => threadId)).not.toContain(id);

    const listed = await listedIds();
    expect(listed).toContain(pinnedChild.id);
    expect(listed).toContain(other.id);
    for (const id of [parent.id, child.id, sibling.id])
      expect(listed).not.toContain(id);
  });

  it("deletes an archived parent with its archived children", async () => {
    await seedFamily();
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id IN (?, ?)",
    )
      .bind(parent.id, child.id)
      .run();

    const response = await removeFamily(parent.id);
    expect(response.status).toBe(200);
    expect((await json(response)).data.deletedChildThreadIds).toEqual(
      expect.arrayContaining([child.id, archivedChild.id]),
    );
    expect(await lifecycle(child.id)).toEqual({
      state: "deleted",
      parent: null,
    });
    expect(await lifecycle(archivedChild.id)).toEqual({
      state: "deleted",
      parent: null,
    });
    // Still active, so listed on its own, not under the archived parent.
    expect(await lifecycle(sibling.id)).toEqual({
      state: "active",
      parent: null,
    });
  });

  it("reports no children when none are listed under the Thread", async () => {
    const response = await removeFamily(other.id);
    expect(response.status).toBe(200);
    expect((await json(response)).data.deletedChildThreadIds).toEqual([]);
    expect(await lifecycle(other.id)).toEqual({
      state: "deleted",
      parent: null,
    });
  });

  it("refuses everyone but the owner and leaves the family intact", async () => {
    await seedFamily();
    for (const userId of [member, outsider]) {
      const response = await removeFamily(parent.id, userId);
      expect(response.status).toBe(404);
    }
    for (const id of [parent.id, child.id, sibling.id])
      expect((await lifecycle(id))?.state).toBe("active");
    expect(recorder.calls).toEqual([]);
  });
});
