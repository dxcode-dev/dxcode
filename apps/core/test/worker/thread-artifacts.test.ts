import { env } from "cloudflare:test";
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_RECENT_REVISIONS_KEPT,
  THREAD_ARTIFACT_MAX_STORED_BYTES,
  type ThreadArtifactCommentListResponse,
  type ThreadArtifactCommentResponse,
  type ThreadArtifactErrorResponse,
  type ThreadArtifactListResponse,
  type ThreadArtifactResponse,
  type ThreadArtifactRevisionResponse,
} from "@dx/api";
import {
  Principal,
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
  UserId,
  WorkspaceId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { settingsRoutes } from "../../src/settings/routes.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";
import { addArtifactComment } from "../../src/thread-artifacts/comments.js";
import { threadArtifactRoutes } from "../../src/thread-artifacts/routes.js";
import {
  saveArtifact,
  sweepDeletedArtifacts,
} from "../../src/thread-artifacts/store.js";
import { purgeDeletedThread } from "../../src/thread-deletion/cleanup.js";
import { tombstoneThreads } from "../../src/thread-deletion/tombstone.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Artifacts through workerd's real D1, R2, and Realtime Hub.
 *
 * Ways it could fail, each covered below:
 * - a save made from an older revision overwrites a newer one, including
 *   when two saves race from the same revision, or the losing save leaves
 *   its body behind or deletes the winner's;
 * - a refused save (conflict, too large, Thread full) writes a revision or
 *   a body;
 * - a revision over 2 MB is stored, or the Thread's total grows unbounded;
 * - retention removes a person's revision, the agent's newest, or one of
 *   the newest 50, or keeps the rest and their bodies;
 * - someone who cannot read the Thread reads or writes its artifacts; a
 *   View member writes; a Contribute member's save is recorded as the
 *   owner's;
 * - an artifact is read through a Thread it does not belong to;
 * - a deleted artifact stays readable, listed, or stored;
 * - deleting the Thread, deleting its workspace with its Threads, or deleting
 *   the owner's account leaves rows or bodies behind; deleting a
 *   contributor's account keeps their name on revisions;
 * - the realtime event carries artifact content, or is not sent.
 */

const ORIGIN = "https://dx.test";
const owner = Schema.decodeSync(UserId)("artifact-owner");
const member = Schema.decodeSync(UserId)("artifact-member");
const outsider = Schema.decodeSync(UserId)("artifact-outsider");
const workspaceId = "artifact-workspace";
const workspaceSlug = "artifact-team";

const workspaceProject = {
  ...project("prj_00000000-0000-4000-8000-00000000a701", owner, "Artifacts"),
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)(workspaceId),
};
const outsiderProject = project(
  "prj_00000000-0000-4000-8000-00000000a702",
  outsider,
  "Outsider",
);
let sequence = 0;

const bindings: Bindings = {
  DB: env.DB,
  DX_STORAGE: env.DX_STORAGE,
  REALTIME_HUB: env.REALTIME_HUB,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  DX_AUTH_URL: ORIGIN,
};

const background: Array<Promise<unknown>> = [];
const executionContext = {
  waitUntil: (promise: Promise<unknown>) => {
    background.push(promise.catch(() => undefined));
  },
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;
const settle = async () => {
  while (background.length > 0) await background.shift();
};

/** A signed-in person against Core's mounted routes. */
const as =
  (userId: UserId) =>
  (path: string, method = "GET", body?: unknown) => {
    const routes = new Hono<AppEnv>();
    routes.use("*", requestId);
    routes.use("*", async (context, next) => {
      context.set(
        "principal",
        Schema.decodeUnknownSync(Principal)({
          userId,
          credentialScopes: ["personal", "workspace"],
        }),
      );
      await next();
    });
    routes.use("/v1/threads/:threadId/artifacts/*", authorizeThread);
    routes.route("/v1/threads", threadArtifactRoutes);
    routes.route("/v1/settings", settingsRoutes);
    routes.onError(errorHandler);
    return routes.request(
      `${ORIGIN}${path}`,
      {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body:
                typeof body === "string" || body instanceof Uint8Array
                  ? body
                  : JSON.stringify(body),
            }),
      },
      bindings,
      executionContext,
    );
  };
const ownerApi = as(owner);
const memberApi = as(member);
const outsiderApi = as(outsider);

const newThread = async (
  ownerUserId: UserId = owner,
  projectId = workspaceProject.id,
) => {
  sequence += 1;
  const entity = thread(
    `thr_00000000-0000-4000-8000-${(0xa70000 + sequence).toString(16).padStart(12, "0")}`,
    projectId,
    ownerUserId,
  );
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ThreadRepository).insert(entity);
    }),
  );
  return entity.id as ThreadId;
};

const shareWithWorkspace = (threadId: string, access: "view" | "contribute") =>
  env.DB.prepare(
    `UPDATE threads SET shared_workspace_id = ?1, workspace_access = ?2,
            contribute_until = CASE WHEN ?2 = 'contribute' THEN ?3 ELSE NULL END
      WHERE id = ?4`,
  )
    .bind(
      workspaceId,
      access,
      new Date(Date.now() + 3_600_000).toISOString(),
      threadId,
    )
    .run();

const create = async (
  threadId: string,
  markdown: string,
  api = ownerApi,
  title = "Plan",
) => {
  const response = await api(`/v1/threads/${threadId}/artifacts`, "POST", {
    title,
    markdown,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as ThreadArtifactResponse).data;
};

const save = (
  threadId: string,
  artifactId: string,
  baseRevision: number,
  markdown: string,
  api = ownerApi,
) =>
  api(`/v1/threads/${threadId}/artifacts/${artifactId}`, "PUT", {
    baseRevision,
    markdown,
  });

const comment = async (
  threadId: string,
  artifactId: string,
  body: Record<string, unknown>,
  api = ownerApi,
) =>
  api(`/v1/threads/${threadId}/artifacts/${artifactId}/comments`, "POST", body);

const commentsOf = async (
  threadId: string,
  artifactId: string,
  api = ownerApi,
) =>
  (
    (await (
      await api(`/v1/threads/${threadId}/artifacts/${artifactId}/comments`)
    ).json()) as ThreadArtifactCommentListResponse
  ).data.comments;

const commentRows = (artifactId: string) =>
  count(
    "SELECT count(*) AS n FROM thread_artifact_comment WHERE artifact_id = ?",
    artifactId,
  );

const objects = async (threadId: string) =>
  (
    await env.DX_STORAGE.list({ prefix: `thread-artifacts/${threadId}/` })
  ).objects
    .map(({ key }) => key)
    .sort();

const count = async (sql: string, ...values: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...values)
    .first<number>("n")) ?? 0;

const errorOf = async (response: Response) =>
  ((await response.json()) as ThreadArtifactErrorResponse).data;

beforeEach(async () => {
  background.length = 0;
  await env.DB.batch([
    ...[
      [owner, "Olive Owner"],
      [member, "Maya Member"],
      [outsider, "Otto Outsider"],
    ].map(([id, name]) =>
      env.DB.prepare(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, ?, ?, 1, 1, 1) ON CONFLICT (id) DO NOTHING`,
      ).bind(id, name, `${id}@example.com`),
    ),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Artifact Team', ?, 1)
       ON CONFLICT (id) DO NOTHING`,
    ).bind(workspaceId, workspaceSlug),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('artifact-m-owner', ?1, ?2, 'owner', 1),
         ('artifact-m-member', ?1, ?3, 'member', 2)
       ON CONFLICT (id) DO NOTHING`,
    ).bind(workspaceId, owner, member),
  ]);
  if (
    (await count(
      "SELECT count(*) AS n FROM projects WHERE id = ?",
      workspaceProject.id,
    )) === 0
  )
    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        yield* projects.insert(workspaceProject);
        yield* projects.insert(outsiderProject);
      }),
    );
});

describe("artifacts", () => {
  it("creates, lists, and reads an artifact, its revisions, and who saved them", async () => {
    const threadId = await newThread();
    const created = await create(threadId, "# Plan\n\n- [ ] Ship it\n");
    expect(created.artifact).toMatchObject({
      threadId,
      title: "Plan",
      folder: "",
      revision: 1,
      sizeBytes: 22,
      createdBy: { kind: "user", userId: owner, name: "Olive Owner" },
      updatedBy: { kind: "user", userId: owner, name: "Olive Owner" },
    });
    expect(created.artifact.id).toMatch(/^art_[0-9a-f]{32}$/);

    const saved = await save(
      threadId,
      created.artifact.id,
      1,
      "# Plan\n\n- [x] Ship it\n",
    );
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as ThreadArtifactResponse).data).toMatchObject(
      { artifact: { revision: 2 }, markdown: "# Plan\n\n- [x] Ship it\n" },
    );

    const list = await ownerApi(`/v1/threads/${threadId}/artifacts`);
    expect(
      ((await list.json()) as ThreadArtifactListResponse).data.artifacts,
    ).toEqual([
      expect.objectContaining({ id: created.artifact.id, revision: 2 }),
    ]);
    const read = await ownerApi(
      `/v1/threads/${threadId}/artifacts/${created.artifact.id}`,
    );
    expect(((await read.json()) as ThreadArtifactResponse).data.markdown).toBe(
      "# Plan\n\n- [x] Ship it\n",
    );
    const first = await ownerApi(
      `/v1/threads/${threadId}/artifacts/${created.artifact.id}/revisions/1`,
    );
    expect(first.headers.get("cache-control")).toBe(
      "private, max-age=3600, immutable",
    );
    expect(
      ((await first.json()) as ThreadArtifactRevisionResponse).data,
    ).toMatchObject({
      revision: 1,
      baseRevision: null,
      markdown: "# Plan\n\n- [ ] Ship it\n",
      author: { kind: "user", userId: owner },
    });
    expect(await objects(threadId)).toHaveLength(2);
  });

  it("refuses a save from an older revision and returns the newer one, writing nothing", async () => {
    const threadId = await newThread();
    const { artifact } = await create(threadId, "one");
    expect((await save(threadId, artifact.id, 1, "two")).status).toBe(200);
    const before = await objects(threadId);

    const stale = await save(threadId, artifact.id, 1, "stale edit");
    expect(stale.status).toBe(409);
    expect(await errorOf(stale)).toMatchObject({
      code: "ARTIFACT_CONFLICT",
      current: { artifact: { revision: 2 }, markdown: "two" },
    });
    expect(await objects(threadId)).toEqual(before);
    expect(
      await count(
        "SELECT count(*) AS n FROM thread_artifact_revision WHERE artifact_id = ?",
        artifact.id,
      ),
    ).toBe(2);
  });

  it("lets exactly one of two racing saves from the same revision win", async () => {
    const threadId = await newThread();
    const { artifact } = await create(threadId, "base");
    const results = await Promise.all([
      save(threadId, artifact.id, 1, "from the agent"),
      save(threadId, artifact.id, 1, "from a person"),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 409]);
    const winner = results.find(({ status }) => status === 200);
    if (winner === undefined) throw new Error("Expected one save to win.");
    const winning = ((await winner.json()) as ThreadArtifactResponse).data;
    const read = await ownerApi(
      `/v1/threads/${threadId}/artifacts/${artifact.id}`,
    );
    expect(((await read.json()) as ThreadArtifactResponse).data).toMatchObject({
      artifact: { revision: 2 },
      markdown: winning.markdown,
    });
    // The loser's body is gone; the winner's and revision 1's stay.
    expect(await objects(threadId)).toHaveLength(2);
  });

  it("holds at most 2 MB per revision and a bounded total per Thread", async () => {
    const threadId = await newThread();
    const atLimit = "a".repeat(ARTIFACT_MAX_BYTES);
    const { artifact } = await create(threadId, atLimit);
    expect(artifact.sizeBytes).toBe(ARTIFACT_MAX_BYTES);

    // Multi-byte characters count in UTF-8 bytes, not characters.
    const tooLarge = await save(
      threadId,
      artifact.id,
      1,
      "é".repeat(ARTIFACT_MAX_BYTES / 2 + 1),
    );
    expect(tooLarge.status).toBe(413);
    expect((await errorOf(tooLarge)).code).toBe("ARTIFACT_TOO_LARGE");
    const tooLargeCreate = await ownerApi(
      `/v1/threads/${threadId}/artifacts`,
      "POST",
      { title: "Big", markdown: `${atLimit}a` },
    );
    expect((await errorOf(tooLargeCreate)).code).toBe("ARTIFACT_TOO_LARGE");

    await env.DB.prepare(
      "UPDATE thread_artifact SET stored_bytes = ? WHERE id = ?",
    )
      .bind(THREAD_ARTIFACT_MAX_STORED_BYTES - 10, artifact.id)
      .run();
    const full = await save(threadId, artifact.id, 1, "more than ten bytes");
    expect(full.status).toBe(413);
    expect((await errorOf(full)).code).toBe("ARTIFACT_STORAGE_FULL");
    expect(await objects(threadId)).toHaveLength(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM thread_artifact_revision WHERE artifact_id = ?",
        artifact.id,
      ),
    ).toBe(1);
  });

  it("keeps the newest 50 revisions, every person's, and the agent's newest, and removes the rest", async () => {
    const threadId = await newThread();
    const { artifact } = await create(threadId, "person revision 1");
    let revision = 1;
    const agentSave = async (markdown: string) => {
      const result = await saveArtifact(bindings, {
        threadId,
        artifactId: artifact.id,
        baseRevision: revision,
        markdown,
        writer: { kind: "agent", submissionId: "sub-1" },
      });
      expect(result.kind).toBe("saved");
      revision += 1;
    };
    for (let index = 0; index < 5; index++) await agentSave(`agent ${index}`);
    // A person's save at revision 7.
    expect(
      (await save(threadId, artifact.id, revision, "person revision 7")).status,
    ).toBe(200);
    revision += 1;
    for (let index = 0; index < 60; index++)
      await agentSave(`agent later ${index}`);
    expect(revision).toBe(67);

    const kept = (
      await env.DB.prepare(
        `SELECT revision, author_kind FROM thread_artifact_revision
          WHERE artifact_id = ? ORDER BY revision`,
      )
        .bind(artifact.id)
        .all<{ revision: number; author_kind: string }>()
    ).results;
    const newest = Array.from(
      { length: ARTIFACT_RECENT_REVISIONS_KEPT },
      (_, index) => revision - ARTIFACT_RECENT_REVISIONS_KEPT + 1 + index,
    );
    expect(kept.map((row) => row.revision)).toEqual([1, 7, ...newest]);
    expect(await objects(threadId)).toHaveLength(kept.length);
    const stored = await env.DB.prepare(
      `SELECT stored_bytes,
              (SELECT SUM(size_bytes) FROM thread_artifact_revision WHERE artifact_id = ?1) AS kept
         FROM thread_artifact WHERE id = ?1`,
    )
      .bind(artifact.id)
      .first<{ stored_bytes: number; kept: number }>();
    expect(stored?.stored_bytes).toBe(stored?.kept);

    // When people saved the newest 50, the agent's newest still stays.
    for (let index = 0; index < ARTIFACT_RECENT_REVISIONS_KEPT; index++) {
      expect(
        (await save(threadId, artifact.id, revision, `person ${index}`)).status,
      ).toBe(200);
      revision += 1;
    }
    // People's revisions are never compacted, so the agent's newest (67)
    // stays beside revisions 1 and 7.
    const agentKept = (
      await env.DB.prepare(
        `SELECT revision FROM thread_artifact_revision
          WHERE artifact_id = ? AND author_kind = 'agent' ORDER BY revision`,
      )
        .bind(artifact.id)
        .all<{ revision: number }>()
    ).results.map((row) => row.revision);
    expect(agentKept).toEqual([67]);
    // About 115 saves: more than the default timeout allows when every
    // worker test file runs at once.
  }, 30_000);

  it("lets only people with access read, and only the owner and Contribute members write", async () => {
    const threadId = await newThread();
    const { artifact } = await create(threadId, "owner's text");
    const paths = [
      `/v1/threads/${threadId}/artifacts`,
      `/v1/threads/${threadId}/artifacts/${artifact.id}`,
      `/v1/threads/${threadId}/artifacts/${artifact.id}/revisions/1`,
    ];

    for (const path of paths)
      expect((await outsiderApi(path)).status).toBe(404);
    expect(
      (await save(threadId, artifact.id, 1, "x", outsiderApi)).status,
    ).toBe(404);

    await shareWithWorkspace(threadId, "view");
    for (const path of paths) expect((await memberApi(path)).status).toBe(200);
    const refused = [
      await memberApi(`/v1/threads/${threadId}/artifacts`, "POST", {
        title: "Mine",
        markdown: "x",
      }),
      await save(threadId, artifact.id, 1, "viewer edit", memberApi),
      await memberApi(
        `/v1/threads/${threadId}/artifacts/${artifact.id}`,
        "DELETE",
      ),
    ];
    for (const response of refused) {
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("THREAD_READ_ONLY");
    }
    expect(await objects(threadId)).toHaveLength(1);

    await shareWithWorkspace(threadId, "contribute");
    const contributed = await save(
      threadId,
      artifact.id,
      1,
      "member's edit",
      memberApi,
    );
    expect(contributed.status).toBe(200);
    expect(
      ((await contributed.json()) as ThreadArtifactResponse).data.artifact
        .updatedBy,
    ).toEqual({ kind: "user", userId: member, name: "Maya Member" });

    // An artifact is read only through its own Thread.
    const otherThread = await newThread();
    expect(
      (await ownerApi(`/v1/threads/${otherThread}/artifacts/${artifact.id}`))
        .status,
    ).toBe(404);
    expect((await save(otherThread, artifact.id, 2, "elsewhere")).status).toBe(
      404,
    );
  });

  it("refuses malformed requests", async () => {
    const threadId = await newThread();
    const { artifact } = await create(threadId, "text");
    for (const body of [
      "not json",
      { title: "", markdown: "x" },
      { title: "x".repeat(201), markdown: "x" },
      { title: "Ok", folder: "../up", markdown: "x" },
      // Folders are one level deep.
      { title: "Ok", folder: "plans/q4", markdown: "x" },
      { title: "Ok" },
    ]) {
      const response = await ownerApi(
        `/v1/threads/${threadId}/artifacts`,
        "POST",
        body,
      );
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe("INVALID_REQUEST");
    }
    expect((await save(threadId, artifact.id, 0, "x")).status).toBe(400);
    expect(
      (
        await ownerApi(
          `/v1/threads/${threadId}/artifacts/${artifact.id}/revisions/9`,
        )
      ).status,
    ).toBe(404);
  });

  it("deletes an artifact: unreadable, unlisted, and its bodies gone", async () => {
    const threadId = await newThread();
    const { artifact } = await create(threadId, "one");
    await save(threadId, artifact.id, 1, "two");
    const kept = await create(threadId, "other", ownerApi, "Other");
    expect(
      (await comment(threadId, artifact.id, { quote: "two", body: "Why?" }))
        .status,
    ).toBe(201);

    const deleted = await ownerApi(
      `/v1/threads/${threadId}/artifacts/${artifact.id}`,
      "DELETE",
    );
    expect(deleted.status).toBe(200);
    expect(
      (await ownerApi(`/v1/threads/${threadId}/artifacts/${artifact.id}`))
        .status,
    ).toBe(404);
    expect((await save(threadId, artifact.id, 2, "after delete")).status).toBe(
      404,
    );
    const list = await ownerApi(`/v1/threads/${threadId}/artifacts`);
    expect(
      ((await list.json()) as ThreadArtifactListResponse).data.artifacts.map(
        ({ id }) => id,
      ),
    ).toEqual([kept.artifact.id]);
    expect(
      (await objects(threadId)).filter((key) => key.includes(artifact.id)),
    ).toEqual([]);
    expect(await commentRows(artifact.id)).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM thread_artifact_revision WHERE artifact_id = ?",
        artifact.id,
      ),
    ).toBe(0);
  });

  it("removes every artifact, revision, and body when the Thread is deleted", async () => {
    const threadId = await newThread();
    const sibling = await newThread();
    const { artifact } = await create(threadId, "one");
    await save(threadId, artifact.id, 1, "two");
    await comment(threadId, artifact.id, { quote: "two", body: "A note" });
    await create(sibling, "sibling stays");

    expect(
      await tombstoneThreads(
        env.DB,
        [threadId],
        owner,
        new Date().toISOString(),
      ),
    ).toEqual([threadId]);
    const result = await purgeDeletedThread(
      bindings,
      {
        eraseAgentHistory: async () => undefined,
        destroySandbox: async () => undefined,
      },
      threadId,
      owner,
    );
    expect(result.failedSteps).not.toContain("artifacts");
    expect(await objects(threadId)).toEqual([]);
    expect(
      await count(
        "SELECT count(*) AS n FROM thread_artifact WHERE thread_id = ?",
        threadId,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM thread_artifact_revision WHERE artifact_id = ?",
        artifact.id,
      ),
    ).toBe(0);
    expect(await commentRows(artifact.id)).toBe(0);
    expect(await objects(sibling)).toHaveLength(1);
  });

  it("removes them when the workspace is deleted with its Threads", async () => {
    const threadId = await newThread();
    const { artifact } = await create(threadId, "workspace plan");
    await save(threadId, artifact.id, 1, "workspace plan, edited");
    await comment(threadId, artifact.id, { quote: "edited", body: "Good" });
    const elsewhere = await newThread(outsider, outsiderProject.id);
    await create(elsewhere, "not in the workspace", outsiderApi);

    const deleted = await ownerApi(
      `/v1/settings/workspaces/${workspaceSlug}/delete`,
      "POST",
      { confirmShortName: workspaceSlug, threads: "delete" },
    );
    expect(deleted.status).toBe(200);
    await settle();
    expect(await objects(threadId)).toEqual([]);
    expect(await commentRows(artifact.id)).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM thread_artifact WHERE thread_id = ?",
        threadId,
      ),
    ).toBe(0);
    expect(await objects(elsewhere)).toHaveLength(1);
  });

  it("removes the owner's artifacts when their account is deleted, and forgets a contributor elsewhere", async () => {
    const ownedByOutsider = await newThread(outsider, outsiderProject.id);
    const { artifact: theirs } = await create(
      ownedByOutsider,
      "outsider's plan",
      outsiderApi,
    );
    await save(
      ownedByOutsider,
      theirs.id,
      1,
      "outsider's plan, v2",
      outsiderApi,
    );
    const ownersThread = await newThread();
    await shareWithWorkspace(ownersThread, "contribute");
    const { artifact: shared } = await create(ownersThread, "owner's plan");
    // The outsider can't reach the owner's Thread; record their authorship
    // directly, as a past member's would be.
    await saveArtifact(bindings, {
      threadId: ownersThread,
      artifactId: shared.id,
      baseRevision: 1,
      markdown: "edited by someone who later left",
      writer: { kind: "user", userId: outsider },
    });
    await addArtifactComment(bindings, {
      threadId: ownersThread,
      artifactId: shared.id,
      quote: "someone",
      body: "my comment",
      writer: { kind: "user", userId: outsider },
    });
    await comment(
      ownedByOutsider,
      theirs.id,
      { quote: "v2", body: "on my own plan" },
      outsiderApi,
    );

    await env.DB.prepare('DELETE FROM "user" WHERE id = ?')
      .bind(outsider)
      .run();
    // Their Thread's artifact is deleted at once; its bodies go with the sweep.
    expect(
      (await ownerApi(`/v1/threads/${ownedByOutsider}/artifacts`)).status,
    ).toBe(404);
    expect(
      await count(
        "SELECT count(*) AS n FROM thread_artifact WHERE thread_id = ? AND deleted_at IS NULL",
        ownedByOutsider,
      ),
    ).toBe(0);
    expect(await sweepDeletedArtifacts(bindings)).toBeGreaterThanOrEqual(1);
    expect(await objects(ownedByOutsider)).toEqual([]);
    expect(await commentRows(theirs.id)).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM thread_artifact_revision WHERE artifact_id = ?",
        theirs.id,
      ),
    ).toBe(0);
    // The owner's artifact stays, without the deleted person's identity.
    const revision = await ownerApi(
      `/v1/threads/${ownersThread}/artifacts/${shared.id}/revisions/2`,
    );
    expect(
      ((await revision.json()) as ThreadArtifactRevisionResponse).data.author,
    ).toEqual({ kind: "user", userId: null, name: null });
    expect(await objects(ownersThread)).toHaveLength(2);
    expect((await commentsOf(ownersThread, shared.id))[0]).toMatchObject({
      body: "my comment",
      author: { kind: "user", userId: null, name: null },
    });
  });

  it("tells the Thread's viewers that its artifacts changed, without their content", async () => {
    const threadId = await newThread();
    const audience = `workspace:${workspaceId}`;
    const response = await env.REALTIME_HUB.getByName(audience).fetch(
      "https://realtime.internal/subscribe",
      {
        headers: {
          upgrade: "websocket",
          "x-dx-realtime-audience": audience,
          "x-dx-realtime-participant": owner,
          "x-dx-realtime-client": crypto.randomUUID(),
        },
      },
    );
    const socket = response.webSocket;
    if (socket === null) throw new Error("Expected realtime WebSocket.");
    const frames: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(event.data as string);
      if (frame.type !== "ready") frames.push(frame);
    });
    socket.accept();

    const { artifact } = await create(threadId, "secret plan text");
    await save(threadId, artifact.id, 1, "secret plan text, edited");
    await ownerApi(
      `/v1/threads/${threadId}/artifacts/${artifact.id}`,
      "DELETE",
    );
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.close();

    const artifactFrames = frames.filter(
      (frame) => frame.type === "artifacts.invalidated",
    );
    expect(artifactFrames).toHaveLength(3);
    for (const frame of artifactFrames) {
      expect(Object.keys(frame).sort()).toEqual([
        "revision",
        "threadId",
        "type",
      ]);
      expect(frame.threadId).toBe(threadId);
    }
    expect(JSON.stringify(frames)).not.toContain("secret");
  });

  it("overwrites a newer revision only when the save asks to force it", async () => {
    const threadId = await newThread();
    const { artifact } = await create(threadId, "base");
    await save(threadId, artifact.id, 1, "someone else's newer text");
    const forced = await ownerApi(
      `/v1/threads/${threadId}/artifacts/${artifact.id}`,
      "PUT",
      { baseRevision: 1, markdown: "keep my version", force: true },
    );
    expect(forced.status).toBe(200);
    expect(
      ((await forced.json()) as ThreadArtifactResponse).data,
    ).toMatchObject({ artifact: { revision: 3 }, markdown: "keep my version" });
    // The replaced revision stays, so it can be recovered.
    const replaced = await ownerApi(
      `/v1/threads/${threadId}/artifacts/${artifact.id}/revisions/2`,
    );
    expect(
      ((await replaced.json()) as ThreadArtifactRevisionResponse).data.markdown,
    ).toBe("someone else's newer text");
  });

  it("lists one folder, one level deep", async () => {
    const threadId = await newThread();
    const top = await create(threadId, "top level");
    const filed = await ownerApi(`/v1/threads/${threadId}/artifacts`, "POST", {
      title: "Q4",
      folder: "  Plans ",
      markdown: "in a folder",
    });
    expect(
      ((await filed.json()) as ThreadArtifactResponse).data.artifact.folder,
    ).toBe("Plans");
    const ids = async (query: string) =>
      (
        (await (
          await ownerApi(`/v1/threads/${threadId}/artifacts${query}`)
        ).json()) as ThreadArtifactListResponse
      ).data.artifacts.map(({ title }) => title);
    expect(await ids("?folder=Plans")).toEqual(["Q4"]);
    expect(await ids("?folder=")).toEqual([top.artifact.title]);
    expect((await ids("")).sort()).toEqual(["Plan", "Q4"]);
  });

  it("keeps comments beside the Markdown and moves them with their text across saves", async () => {
    const threadId = await newThread();
    const markdown = "# Plan\n\nShip on Friday.\n\nShip on Friday.\n";
    const { artifact } = await create(threadId, markdown);
    // The second "Ship on Friday." is the one nearest `near`.
    const added = await comment(threadId, artifact.id, {
      quote: "Ship on Friday.",
      near: 25,
      body: "Is Friday realistic?",
    });
    expect(added.status).toBe(201);
    const top = ((await added.json()) as ThreadArtifactCommentResponse).data
      .comment;
    expect(top).toMatchObject({
      parentId: null,
      quote: "Ship on Friday.",
      anchor: { revision: 1, start: 25, end: 40 },
      author: { kind: "user", userId: owner, name: "Olive Owner" },
    });
    const reply = await comment(threadId, artifact.id, {
      parentId: top.id,
      body: "Yes, with the fix merged.",
    });
    expect(
      ((await reply.json()) as ThreadArtifactCommentResponse).data.comment,
    ).toMatchObject({ parentId: top.id, quote: "", anchor: null });

    // Text inserted above moves the anchor; the Markdown never holds it.
    const edited = `Intro line.\n${markdown}`;
    await save(threadId, artifact.id, 1, edited);
    const read = await ownerApi(
      `/v1/threads/${threadId}/artifacts/${artifact.id}`,
    );
    const current = ((await read.json()) as ThreadArtifactResponse).data;
    expect(current.markdown).toBe(edited);
    expect(current.artifact.openCommentCount).toBe(1);
    const [moved] = await commentsOf(threadId, artifact.id);
    expect(moved?.anchor).toEqual({ revision: 2, start: 37, end: 52 });
    expect(
      await env.DB.prepare(
        "SELECT anchor_revision, anchor_start FROM thread_artifact_comment WHERE id = ?",
      )
        .bind(top.id)
        .first(),
    ).toEqual({ anchor_revision: 2, anchor_start: 37 });

    // When the quoted text is gone, the comment is detached, not lost.
    await save(threadId, artifact.id, 2, "# Plan\n\nShip next week.\n");
    const [detached] = await commentsOf(threadId, artifact.id);
    expect(detached).toMatchObject({ id: top.id, anchor: null });

    // Resolving a reply resolves its thread; the count drops.
    const resolved = await ownerApi(
      `/v1/threads/${threadId}/artifacts/${artifact.id}/comments/${
        (await commentsOf(threadId, artifact.id))[1]?.id
      }/resolve`,
      "POST",
    );
    expect(
      ((await resolved.json()) as ThreadArtifactCommentResponse).data.comment,
    ).toMatchObject({ id: top.id, resolvedAt: expect.any(Number) });
    const list = await ownerApi(`/v1/threads/${threadId}/artifacts`);
    expect(
      ((await list.json()) as ThreadArtifactListResponse).data.artifacts[0]
        ?.openCommentCount,
    ).toBe(0);
  });

  it("refuses comments on text that is not there, from View members, and through another Thread", async () => {
    const threadId = await newThread();
    const { artifact } = await create(threadId, "Only this text.");
    const missing = await comment(threadId, artifact.id, {
      quote: "not in it",
      body: "?",
    });
    expect(missing.status).toBe(422);
    expect((await errorOf(missing)).code).toBe("ARTIFACT_QUOTE_NOT_FOUND");
    const strayReply = await comment(threadId, artifact.id, {
      parentId: "cmt_00000000000000000000000000000000",
      body: "?",
    });
    expect((await errorOf(strayReply)).code).toBe("ARTIFACT_COMMENT_NOT_FOUND");

    await shareWithWorkspace(threadId, "view");
    expect((await commentsOf(threadId, artifact.id, memberApi)).length).toBe(0);
    const viewer = await comment(
      threadId,
      artifact.id,
      { quote: "Only", body: "viewer" },
      memberApi,
    );
    expect(viewer.status).toBe(403);
    await shareWithWorkspace(threadId, "contribute");
    const contributor = await comment(
      threadId,
      artifact.id,
      { quote: "Only", body: "contributor" },
      memberApi,
    );
    expect(
      ((await contributor.json()) as ThreadArtifactCommentResponse).data.comment
        .author,
    ).toEqual({ kind: "user", userId: member, name: "Maya Member" });

    const otherThread = await newThread();
    expect(
      (await comment(otherThread, artifact.id, { quote: "Only", body: "x" }))
        .status,
    ).toBe(404);
    expect(
      (
        await outsiderApi(
          `/v1/threads/${threadId}/artifacts/${artifact.id}/comments`,
        )
      ).status,
    ).toBe(404);
  });

  it("stores images people add, only real images, only from people who can write, and with the Thread", async () => {
    const threadId = await newThread();
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68,
      82,
    ]);
    const upload = (
      api: typeof ownerApi,
      body: Uint8Array | string,
      name = "diagram.png",
    ) =>
      api(
        `/v1/threads/${threadId}/artifacts/images?name=${encodeURIComponent(name)}`,
        "POST",
        body,
      );
    const stored = await upload(ownerApi, png, "My diagram.PNG");
    expect(stored.status).toBe(201);
    const image = (
      (await stored.json()) as {
        data: {
          id: string;
          url: string;
          name: string;
          mimeType: string;
          size: number;
        };
      }
    ).data;
    expect(image).toMatchObject({
      name: "My diagram.png",
      mimeType: "image/png",
      size: png.byteLength,
    });
    expect(image.url).toBe(
      `${ORIGIN}/v1/threads/${threadId}/storage/${image.id}/My%20diagram.png`,
    );
    expect(
      (await env.DX_STORAGE.list({ prefix: `thread-storage/${threadId}/` }))
        .objects,
    ).toHaveLength(1);

    // The type comes from the bytes: text named .png is refused.
    const renamed = await upload(
      ownerApi,
      "<script>alert(1)</script>",
      "x.png",
    );
    expect(renamed.status).toBe(415);
    expect((await errorOf(renamed)).code).toBe("ARTIFACT_IMAGE_INVALID");
    const tooLarge = await upload(
      ownerApi,
      new Uint8Array(10 * 1024 * 1024 + 1).fill(0x89),
    );
    expect(tooLarge.status).toBe(413);

    await shareWithWorkspace(threadId, "view");
    const viewer = await upload(memberApi, png);
    expect(viewer.status).toBe(403);
    expect((await upload(outsiderApi, png)).status).toBe(404);

    // It goes with the Thread.
    await tombstoneThreads(env.DB, [threadId], owner, new Date().toISOString());
    await purgeDeletedThread(
      bindings,
      {
        eraseAgentHistory: async () => undefined,
        destroySandbox: async () => undefined,
      },
      threadId,
      owner,
    );
    expect(
      (await env.DX_STORAGE.list({ prefix: `thread-storage/${threadId}/` }))
        .objects,
    ).toEqual([]);
  });
});
