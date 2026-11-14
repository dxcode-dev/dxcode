import { env } from "cloudflare:test";
import type {
  ArtifactLibraryItem,
  ArtifactLibraryItemResponse,
  ArtifactLibraryResponse,
  ThreadArtifactResponse,
} from "@dx/api";
import {
  Principal,
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
  UserId,
  WorkspaceId,
} from "@dx/domain";
import type { ToolDefinition } from "@flue/runtime";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { moveHomeArtifacts } from "../../src/artifact-library/moves.js";
import { artifactLibraryRoutes } from "../../src/artifact-library/routes.js";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { enforceThreadActive } from "../../src/auth/enforce-thread-active.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { createArtifactTools } from "../../src/thread-artifacts/agent-tools.js";
import {
  artifactCommented,
  type DeliverArtifactWake,
} from "../../src/thread-artifacts/ask-effects.js";
import {
  standaloneArtifactRoutes,
  threadArtifactRoutes,
} from "../../src/thread-artifacts/routes.js";
import { createArtifact } from "../../src/thread-artifacts/store.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * The Artifacts library, through workerd's real D1 and R2: standalone
 * artifacts with no Thread or Project, every artifact a person may open in one list,
 * per-artifact workspace sharing, the `/artifacts/<id>` link, and the
 * agent's `artifact` tool reaching beyond its Thread within its owner's
 * access.
 *
 * Ways it could fail, each covered below:
 * - a standalone artifact cannot be made without a Thread, or is made
 *   shared instead of private;
 * - a private artifact lists for, opens for, or saves for someone else;
 * - sharing does not reach a workspace member, or reaches an outsider;
 * - view sharing lets a member save, or edit sharing does not let them;
 * - a member, or the owner of a Thread artifact, changes a standalone
 *   artifact's sharing they do not own;
 * - title search misses, matches `%` as a wildcard, or the filters mix up
 *   who made what; All lists the agent's untouched artifacts, or hides one
 *   a person edited, commented on, pinned, or filed; pins do not list
 *   first, or another person's pins or folders reach the reader;
 * - a Thread's artifacts, or those of a Thread shared with the member, are
 *   missing from the library, or an unshared Thread's leak into it;
 * - a person with no Project cannot make one, or making one makes a
 *   Thread behind it; its bodies or images land under a Thread, or a
 *   delete leaves them stored, or another person reads its images;
 * - an old artifact home's bodies or images stay under the deleted home,
 *   its image links still point there, or its comments lose their text;
 * - Notify agent on a standalone artifact tries to wake an agent, or a
 *   comment that asks @dx there does, while a Thread's still wakes;
 * - the agent lists, reads, or edits an artifact its Thread's owner cannot
 *   open, edits one shared view-only, or cannot reach a shared one at all.
 */

const ORIGIN = "https://dx.test";
const owner = Schema.decodeSync(UserId)("library-owner");
const member = Schema.decodeSync(UserId)("library-member");
const outsider = Schema.decodeSync(UserId)("library-outsider");
const workspaceId = "library-workspace";

const ownerProject = {
  ...project("prj_00000000-0000-4000-8000-00000000b101", owner, "Storefront"),
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)(workspaceId),
};
const memberProject = {
  ...project("prj_00000000-0000-4000-8000-00000000b102", member, "Billing"),
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)(workspaceId),
};
const outsiderProject = project(
  "prj_00000000-0000-4000-8000-00000000b103",
  outsider,
  "Elsewhere",
);

const bindings: Bindings = {
  DB: env.DB,
  DX_STORAGE: env.DX_STORAGE,
  REALTIME_HUB: env.REALTIME_HUB,
  DX_AUTH_URL: ORIGIN,
};

let sequence = 0;
const newThread = async (ownerUserId: UserId, projectId = ownerProject.id) => {
  sequence += 1;
  const entity = thread(
    `thr_00000000-0000-4000-8000-${(0xb10000 + sequence).toString(16).padStart(12, "0")}`,
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

/** A signed-in person against the library, artifact, and agent routes. */
const as =
  (userId: UserId) =>
  async (path: string, method = "GET", body?: unknown) => {
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
    routes.route("/v1/artifacts", artifactLibraryRoutes);
    routes.route("/v1/standalone-artifacts", standaloneArtifactRoutes);
    routes.use("/v1/threads/:threadId/artifacts/*", authorizeThread);
    routes.route("/v1/threads", threadArtifactRoutes);
    // The agent's message route, behind the admission it really has.
    routes.use("/v1/agents/dx/:threadId", authorizeThread);
    routes.use("/v1/agents/dx/:threadId", enforceThreadActive);
    routes.post("/v1/agents/dx/:threadId", (context) =>
      context.json({ admitted: true }, 202),
    );
    routes.onError(errorHandler);
    const response = await routes.request(
      `${ORIGIN}${path}`,
      {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      },
      bindings,
    );
    return {
      status: response.status,
      body: (response.headers.get("content-type")?.includes("json")
        ? await response.json()
        : // biome-ignore lint/suspicious/noExplicitAny: each test reads its own shape.
          undefined) as any,
    };
  };

const ownerApi = as(owner);
const memberApi = as(member);
const outsiderApi = as(outsider);

const library = async (
  api: ReturnType<typeof as>,
  search = "",
): Promise<ReadonlyArray<ArtifactLibraryItem>> => {
  const { status, body } = await api(`/v1/artifacts${search}`);
  expect(status).toBe(200);
  return (body as ArtifactLibraryResponse).data.items;
};

const titles = (items: ReadonlyArray<ArtifactLibraryItem>) =>
  items.map((item) => item.title);

const createStandalone = async (
  api: ReturnType<typeof as>,
  title: string,
  extra: Record<string, unknown> = {},
) => {
  const { status, body } = await api("/v1/artifacts", "POST", {
    title,
    ...extra,
  });
  expect(status).toBe(201);
  return (body as ArtifactLibraryItemResponse).data.item;
};

const toolFor = (threadId: string) => {
  const [tool] = createArtifactTools(
    threadId,
    () => ({ db: env.DB, bindings }),
    "sub_library_test",
  );
  // biome-ignore lint/suspicious/noExplicitAny: the tool's output is JSON for the model.
  return async (data: Record<string, unknown>): Promise<any> =>
    (
      (await (tool as ToolDefinition).run({
        data,
        toolCallId: "call",
        log: { info() {}, warn() {}, error() {}, debug() {} },
      } as never)) as { output: unknown }
    ).output;
};

beforeEach(async () => {
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
      `INSERT INTO organization (id, name, slug, createdAt)
       VALUES (?, 'Library Team', 'library-team', 1) ON CONFLICT (id) DO NOTHING`,
    ).bind(workspaceId),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('library-m-owner', ?1, ?2, 'owner', 1),
         ('library-m-member', ?1, ?3, 'member', 2)
       ON CONFLICT (id) DO NOTHING`,
    ).bind(workspaceId, owner, member),
  ]);
  for (const entity of [ownerProject, memberProject, outsiderProject])
    if (
      (await env.DB.prepare("SELECT 1 AS found FROM projects WHERE id = ?")
        .bind(entity.id)
        .first("found")) === null
    )
      await runRepositories(
        Effect.gen(function* () {
          yield* (yield* ProjectRepository).insert(entity);
        }),
      );
});

describe("the Artifacts library", () => {
  it("makes a private standalone artifact that opens and saves with no Thread of its own", async () => {
    const created = await createStandalone(ownerApi, "Q4 roadmap", {
      markdown: "# Q4 roadmap\n\n- Ship the library\n",
    });
    expect(created).toMatchObject({
      title: "Q4 roadmap",
      kind: "document",
      source: { kind: "standalone" },
      access: "owner",
      sharing: "private",
      revision: 1,
    });

    // The link `/artifacts/<id>` resolves to where it is read and saved.
    const found = await ownerApi(`/v1/artifacts/${created.id}`);
    expect(found.status).toBe(200);
    expect(found.body.data.item.threadId).toBeNull();

    const read = await ownerApi(`/v1/standalone-artifacts/${created.id}`);
    expect(read.status).toBe(200);
    expect((read.body as ThreadArtifactResponse).data.markdown).toContain(
      "Ship the library",
    );
    const saved = await ownerApi(
      `/v1/standalone-artifacts/${created.id}`,
      "PUT",
      { baseRevision: 1, markdown: "# Q4 roadmap\n\n- Ship it\n" },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.data.artifact.revision).toBe(2);

    // Boards are standalone too.
    const board = await createStandalone(ownerApi, "Checkout flow", {
      kind: "board",
    });
    expect(board).toMatchObject({ kind: "board", sharing: "private" });
  });

  it("makes standalone artifacts for a person with no Project, with no Thread behind them", async () => {
    const loner = Schema.decodeSync(UserId)("library-loner");
    await env.DB.prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, 'Lee Loner', 'loner@example.com', 1, 1, 1)
       ON CONFLICT (id) DO NOTHING`,
    )
      .bind(loner)
      .run();
    const lonerApi = as(loner);
    const threadsBefore = await env.DB.prepare(
      "SELECT count(*) AS n FROM threads",
    ).first<number>("n");
    const created = await createStandalone(lonerApi, "Reading list", {
      markdown: "- Dune\n",
    });
    expect(created).toMatchObject({
      threadId: null,
      source: { kind: "standalone" },
      access: "owner",
      sharing: "private",
    });
    // No Thread was made for it, and no Project was needed.
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM threads").first<number>(
        "n",
      ),
    ).toBe(threadsBefore);
    expect(
      await env.DB.prepare(
        "SELECT thread_id, owner_user_id FROM thread_artifact WHERE id = ?",
      )
        .bind(created.id)
        .first(),
    ).toEqual({ thread_id: null, owner_user_id: loner });

    // Edit, comment, and see it listed.
    const saved = await lonerApi(
      `/v1/standalone-artifacts/${created.id}`,
      "PUT",
      { baseRevision: 1, markdown: "- Dune\n- Emma\n" },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.data.artifact).toMatchObject({
      revision: 2,
      threadId: null,
    });
    const commented = await lonerApi(
      `/v1/standalone-artifacts/${created.id}/comments`,
      "POST",
      { quote: "Emma", body: "Next up" },
    );
    expect(commented.status).toBe(201);
    const revision = await lonerApi(
      `/v1/standalone-artifacts/${created.id}/revisions/1`,
    );
    expect(revision.body.data.markdown).toBe("- Dune\n");
    expect(titles(await library(lonerApi))).toEqual(["Reading list"]);

    // Its bodies live under the artifact, not under any Thread.
    const stored = await env.DX_STORAGE.list({
      prefix: `standalone-artifacts/${created.id}/`,
    });
    expect(stored.objects).toHaveLength(2);

    // An image goes with the artifact and reads back for its readers only.
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d,
    ]);
    const routes = new Hono<AppEnv>();
    routes.use("*", requestId);
    routes.use("*", async (context, next) => {
      context.set(
        "principal",
        Schema.decodeUnknownSync(Principal)({
          userId: loner,
          credentialScopes: ["personal", "workspace"],
        }),
      );
      await next();
    });
    routes.route("/v1/standalone-artifacts", standaloneArtifactRoutes);
    const uploaded = await routes.request(
      `${ORIGIN}/v1/standalone-artifacts/${created.id}/images?name=cover.png`,
      { method: "POST", body: png },
      bindings,
    );
    expect(uploaded.status).toBe(201);
    const image = ((await uploaded.json()) as { data: { url: string } }).data;
    expect(image.url).toMatch(
      new RegExp(
        `/v1/standalone-artifacts/${created.id}/images/tsf_[0-9a-f]{32}/cover\\.png$`,
      ),
    );
    const path = new URL(image.url).pathname;
    const fetched = await routes.request(`${ORIGIN}${path}`, {}, bindings);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(png);
    expect((await ownerApi(path)).status).toBe(404);

    // Deleting it removes every object it stored.
    const deleted = await lonerApi(
      `/v1/standalone-artifacts/${created.id}`,
      "DELETE",
    );
    expect(deleted.status).toBe(200);
    expect(
      (
        await env.DX_STORAGE.list({
          prefix: `standalone-artifacts/${created.id}/`,
        })
      ).objects,
    ).toEqual([]);
    expect(titles(await library(lonerApi))).toEqual([]);
  });

  it("moves an old artifact home's bodies and images to the artifact, relinking them", async () => {
    // What 0198 leaves behind: a standalone artifact whose objects are still
    // under the deleted home's prefix, listed for the move.
    const home = "thr_00000000-0000-4000-8000-0000000b1ff0";
    const artifactId = `art_${"7".repeat(32)}`;
    const fileId = `tsf_${"8".repeat(32)}`;
    const oldLink = `/v1/threads/${home}/storage/${fileId}/cover.png`;
    const newLink = `/v1/standalone-artifacts/${artifactId}/images/${fileId}/cover.png`;
    const body = `# Moved\n\n![cover](${oldLink})\n\nShip it\n`;
    const bytes = new TextEncoder().encode(body);
    const sha = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    await env.DX_STORAGE.put(
      `thread-artifacts/${home}/${artifactId}/1-${sha}.md`,
      bytes,
    );
    await env.DX_STORAGE.put(`thread-storage/${home}/${fileId}`, png, {
      httpMetadata: { contentType: "image/png" },
    });
    const start = body.indexOf("Ship it");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO thread_artifact
           (id, thread_id, owner_user_id, shared_workspace_id, workspace_access,
            title, current_revision, size_bytes, stored_bytes, created_by_kind,
            created_by_user_id, created_at, updated_at)
         VALUES (?1, NULL, ?2, ?3, 'view', 'Moved', 1, ?4, ?4, 'user', ?2, 1, 1)`,
      ).bind(artifactId, owner, workspaceId, bytes.byteLength),
      env.DB.prepare(
        `INSERT INTO thread_artifact_revision
           (artifact_id, revision, author_kind, author_user_id, sha256,
            size_bytes, created_at)
         VALUES (?1, 1, 'user', ?2, ?3, ?4, 1)`,
      ).bind(artifactId, owner, sha, bytes.byteLength),
      env.DB.prepare(
        `INSERT INTO thread_artifact_comment
           (id, artifact_id, quote, anchor_revision, anchor_start, anchor_end,
            author_kind, author_user_id, body, created_at)
         VALUES (?1, ?2, 'Ship it', 1, ?3, ?4, 'user', ?5, 'When?', 1)`,
      ).bind(`cmt_${"9".repeat(32)}`, artifactId, start, start + 7, owner),
      env.DB.prepare(
        `INSERT INTO thread_storage_files
           (id, thread_id, object_key, name, mime_type, size, state, created_at)
         VALUES (?1, ?2, ?3, 'cover.png', 'image/png', ?4, 'ready', 1)`,
      ).bind(fileId, home, `thread-storage/${home}/${fileId}`, png.byteLength),
      env.DB.prepare(
        "INSERT INTO standalone_artifact_move (artifact_id, from_thread_id) VALUES (?, ?)",
      ).bind(artifactId, home),
    ]);

    expect(await moveHomeArtifacts(bindings)).toBe(1);
    expect(await moveHomeArtifacts(bindings)).toBe(0);

    const read = await ownerApi(`/v1/standalone-artifacts/${artifactId}`);
    expect(read.status).toBe(200);
    const markdown = (read.body as ThreadArtifactResponse).data.markdown;
    expect(markdown).toBe(body.replace(oldLink, newLink));
    expect(read.body.data.artifact.sizeBytes).toBe(
      new TextEncoder().encode(markdown).byteLength,
    );
    // The comment still sits on its text, now further along.
    const comments = await ownerApi(
      `/v1/standalone-artifacts/${artifactId}/comments`,
    );
    const anchor = comments.body.data.comments[0].anchor;
    expect(markdown.slice(anchor.start, anchor.end)).toBe("Ship it");
    // The image reads from the artifact, for the member it is shared with.
    const image = await memberApi(newLink);
    expect(image.status).toBe(200);
    // Nothing is left under the home.
    expect(
      (await env.DX_STORAGE.list({ prefix: `thread-artifacts/${home}/` }))
        .objects,
    ).toEqual([]);
    expect(await env.DX_STORAGE.get(`thread-storage/${home}/${fileId}`)).toBe(
      null,
    );
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM thread_storage_files WHERE thread_id = ?",
      )
        .bind(home)
        .first<number>("n"),
    ).toBe(0);
  });

  it("refuses Notify agent on a standalone artifact and wakes no agent for @dx in its comments", async () => {
    const created = await createStandalone(ownerApi, "No agent here", {
      markdown: "Ship it today.\n",
    });
    const notify = await ownerApi(
      `/v1/standalone-artifacts/${created.id}/notify`,
      "POST",
    );
    expect(notify.status).toBe(400);
    expect(notify.body.data).toMatchObject({
      code: "INVALID_REQUEST",
      message: "A standalone artifact has no agent to notify.",
    });

    const wakes: Parameters<DeliverArtifactWake>[0][] = [];
    const deliver: DeliverArtifactWake = async (wake) => {
      wakes.push(wake);
    };
    const asked = (
      threadId: ThreadId | null,
      artifactId: string,
      commentId: string,
    ) =>
      artifactCommented(
        bindings,
        {
          threadId,
          artifactId,
          commentId,
          quote: "Ship it",
          body: "@[dx](agent) can you check this?",
          writer: { kind: "user", userId: owner },
        },
        { deliver },
      );
    await asked(null, created.id, "cmt_standalone");
    expect(wakes).toEqual([]);

    // The control: the same comment in a Thread wakes its agent.
    const threadId = await newThread(owner);
    const inThread = await createArtifact(bindings, {
      threadId,
      title: "With an agent",
      markdown: "Ship it today.\n",
      writer: { kind: "user", userId: owner },
    });
    if (inThread.kind !== "saved") throw new Error("Expected the artifact.");
    await asked(threadId, inThread.value.artifact.id, "cmt_thread");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.threadId).toBe(threadId);
  });

  it("keeps a private artifact invisible to everyone else, then shares it with the workspace", async () => {
    const created = await createStandalone(ownerApi, "Pricing memo private");

    // Not shared: no list row, and every route answers as if it did not exist.
    expect(titles(await library(memberApi))).not.toContain(
      "Pricing memo private",
    );
    expect((await memberApi(`/v1/artifacts/${created.id}`)).status).toBe(404);
    expect(
      (await memberApi(`/v1/standalone-artifacts/${created.id}`)).status,
    ).toBe(404);
    expect(
      (
        await memberApi(`/v1/standalone-artifacts/${created.id}`, "PUT", {
          baseRevision: 1,
          markdown: "taken over",
        })
      ).status,
    ).toBe(404);

    // A member cannot change sharing of what they do not own.
    expect(
      (
        await memberApi(`/v1/artifacts/${created.id}/sharing`, "PUT", {
          sharing: "edit",
        })
      ).status,
    ).toBe(404);

    // View: the member lists and reads it, but cannot save.
    const viewed = await ownerApi(
      `/v1/artifacts/${created.id}/sharing`,
      "PUT",
      {
        sharing: "view",
      },
    );
    expect(viewed.status).toBe(200);
    expect(viewed.body.data.item.sharing).toBe("view");
    const asMember = (await library(memberApi)).find(
      (item) => item.id === created.id,
    );
    expect(asMember).toMatchObject({
      access: "view",
      sharing: "view",
      owner: { name: "Olive Owner" },
      source: { kind: "standalone" },
    });
    expect(
      (await memberApi(`/v1/standalone-artifacts/${created.id}`)).status,
    ).toBe(200);
    const refused = await memberApi(
      `/v1/standalone-artifacts/${created.id}`,
      "PUT",
      { baseRevision: 1, markdown: "# Pricing\n\nMember edit\n" },
    );
    expect(refused.status).toBe(403);
    expect(
      (
        await memberApi(`/v1/artifacts/${created.id}/sharing`, "PUT", {
          sharing: "edit",
        })
      ).status,
    ).toBe(403);

    // Edit: the member co-edits; their save is attributed to them.
    await ownerApi(`/v1/artifacts/${created.id}/sharing`, "PUT", {
      sharing: "edit",
    });
    const edited = await memberApi(
      `/v1/standalone-artifacts/${created.id}`,
      "PUT",
      { baseRevision: 1, markdown: "# Pricing\n\nMember edit\n" },
    );
    expect(edited.status).toBe(200);
    expect(edited.body.data.artifact.updatedBy).toMatchObject({
      kind: "user",
      name: "Maya Member",
    });
    const comment = await memberApi(
      `/v1/standalone-artifacts/${created.id}/comments`,
      "POST",
      { quote: "Member edit", body: "Looks right" },
    );
    expect(comment.status).toBe(201);

    // Someone outside the workspace never sees it.
    expect(titles(await library(outsiderApi))).not.toContain(
      "Pricing memo private",
    );
    expect((await outsiderApi(`/v1/artifacts/${created.id}`)).status).toBe(404);

    // Private again: gone for the member.
    await ownerApi(`/v1/artifacts/${created.id}/sharing`, "PUT", {
      sharing: "private",
    });
    expect((await memberApi(`/v1/artifacts/${created.id}`)).status).toBe(404);
  });

  it("orders pins, then the reader's own, labels who made each, filters, and keeps personal folders", async () => {
    const own = await newThread(owner);
    const threadArtifact = await createArtifact(bindings, {
      threadId: own,
      title: "Launch checklist 100%",
      markdown: "- [ ] Launch\n",
      writer: { kind: "agent" },
    });
    expect(threadArtifact.kind).toBe("saved");
    const unshared = await newThread(member, memberProject.id);
    await createArtifact(bindings, {
      threadId: unshared,
      title: "Member private notes",
      markdown: "secret",
      writer: { kind: "agent" },
    });
    const sharedThread = await newThread(member, memberProject.id);
    await createArtifact(bindings, {
      threadId: sharedThread,
      title: "Billing runbook",
      markdown: "steps",
      writer: { kind: "agent" },
    });
    await env.DB.prepare(
      `UPDATE threads SET workspace_access = 'view', shared_workspace_id = ?,
              visibility = 'workspace' WHERE id = ?`,
    )
      .bind(workspaceId, sharedThread)
      .run();
    const standalone = await createStandalone(ownerApi, "Launch notes");

    // All leaves out what the agent made that no person has touched.
    const everything = await library(ownerApi);
    const names = titles(everything);
    expect(names).toContain("Launch notes");
    expect(names).not.toContain("Launch checklist 100%");
    expect(names).not.toContain("Billing runbook");
    expect(names).not.toContain("Member private notes");
    // Made by agent lists all of it, labelled as the agent's.
    const byAgent = await library(ownerApi, "?filter=agent");
    expect(titles(byAgent)).toEqual(
      expect.arrayContaining(["Launch checklist 100%", "Billing runbook"]),
    );
    expect(titles(byAgent)).not.toContain("Launch notes");
    expect(
      byAgent.find((item) => item.title === "Billing runbook"),
    ).toMatchObject({
      source: { kind: "thread" },
      access: "view",
      createdBy: { kind: "agent" },
    });

    // A search finds what All leaves out; `%` matches itself.
    expect(titles(await library(ownerApi, "?q=launch"))).toEqual([
      "Launch notes",
      "Launch checklist 100%",
    ]);
    expect(titles(await library(ownerApi, "?q=100%25"))).toEqual([
      "Launch checklist 100%",
    ]);
    const mine = await library(ownerApi, "?filter=mine");
    expect(titles(mine)).toContain("Launch notes");
    expect(titles(mine)).not.toContain("Launch checklist 100%");
    expect(
      mine.find((item) => item.title === "Launch notes")?.createdBy,
    ).toMatchObject({ kind: "user", userId: owner, name: "Olive Owner" });
    expect(titles(await library(ownerApi, "?filter=shared"))).toEqual([
      "Billing runbook",
    ]);

    // A person's edit brings the agent's artifact into All.
    const checklistId =
      threadArtifact.kind === "saved" ? threadArtifact.value.artifact.id : "";
    const edited = await ownerApi(
      `/v1/threads/${own}/artifacts/${checklistId}`,
      "PUT",
      { baseRevision: 1, markdown: "- [x] Launch\n" },
    );
    expect(edited.status).toBe(200);
    expect(titles(await library(ownerApi))).toContain("Launch checklist 100%");
    // So does a person's comment, from the member on the shared Thread.
    const runbook = byAgent.find((item) => item.title === "Billing runbook");
    expect(titles(await library(memberApi))).not.toContain("Billing runbook");
    expect(
      (
        await memberApi(
          `/v1/threads/${sharedThread}/artifacts/${runbook?.id}/comments`,
          "POST",
          { quote: "steps", body: "Which steps?" },
        )
      ).status,
    ).toBe(201);
    expect(titles(await library(memberApi))).toContain("Billing runbook");

    // Ordering: the reader's pins, then what they made, then the rest.
    const pinned = await ownerApi(`/v1/artifacts/${runbook?.id}/pin`, "PUT");
    expect(pinned.status).toBe(200);
    expect(pinned.body.data.item.pinned).toBe(true);
    const ordered = titles(await library(ownerApi));
    expect(ordered[0]).toBe("Billing runbook");
    expect(ordered.indexOf("Launch notes")).toBeLessThan(
      ordered.indexOf("Launch checklist 100%"),
    );
    expect(titles(await library(ownerApi, "?filter=pinned"))).toEqual([
      "Billing runbook",
    ]);
    // Pins are the reader's own.
    expect(
      (await library(memberApi)).find((item) => item.id === runbook?.id)
        ?.pinned,
    ).toBe(false);
    await ownerApi(`/v1/artifacts/${runbook?.id}/pin`, "DELETE");
    expect(titles(await library(ownerApi, "?filter=pinned"))).toEqual([]);

    // Folders: the reader's own, one level, holding what they file there.
    const folder = await ownerApi("/v1/artifacts/folders", "POST", {
      name: "Launch",
    });
    expect(folder.status).toBe(201);
    const folderId = folder.body.data.folder.id as string;
    expect(
      (await ownerApi("/v1/artifacts/folders", "POST", { name: "Launch" }))
        .status,
    ).toBe(409);
    const filed = await ownerApi(
      `/v1/artifacts/${standalone.id}/folder`,
      "PUT",
      { folderId },
    );
    expect(filed.body.data.item.folderId).toBe(folderId);
    const listed = await ownerApi("/v1/artifacts");
    expect(listed.body.data.folders).toEqual([
      { id: folderId, name: "Launch" },
    ]);
    // Nobody else sees the folder, nor can they file into it.
    expect((await memberApi("/v1/artifacts")).body.data.folders).toEqual([]);
    expect(
      (
        await memberApi(`/v1/artifacts/${runbook?.id}/folder`, "PUT", {
          folderId,
        })
      ).status,
    ).toBe(404);
    // Filing the agent's untouched artifact keeps it in All.
    const agentOnly = await createArtifact(bindings, {
      threadId: own,
      title: "Agent scratch",
      markdown: "draft",
      writer: { kind: "agent" },
    });
    const scratchId =
      agentOnly.kind === "saved" ? agentOnly.value.artifact.id : "";
    expect(titles(await library(ownerApi))).not.toContain("Agent scratch");
    await ownerApi(`/v1/artifacts/${scratchId}/folder`, "PUT", { folderId });
    expect(titles(await library(ownerApi))).toContain("Agent scratch");
    const renamed = await ownerApi(
      `/v1/artifacts/folders/${folderId}`,
      "PATCH",
      { name: "Launch week" },
    );
    expect(renamed.body.data.folder.name).toBe("Launch week");
    expect(
      (
        await ownerApi(`/v1/artifacts/folders/${folderId}`, "PATCH", {
          name: "Launch week",
        })
      ).status,
    ).toBe(200);
    // Deleting the folder keeps its artifacts, back at the top.
    expect(
      (await ownerApi(`/v1/artifacts/folders/${folderId}`, "DELETE")).status,
    ).toBe(200);
    const after = await library(ownerApi, "?filter=mine");
    expect(after.find((item) => item.id === standalone.id)?.folderId).toBe(
      null,
    );
    expect((await ownerApi("/v1/artifacts")).body.data.folders).toEqual([]);

    // A Thread artifact is shared with its Thread, not on its own.
    expect(
      (
        await ownerApi(
          `/v1/artifacts/${threadArtifact.kind === "saved" ? threadArtifact.value.artifact.id : ""}/sharing`,
          "PUT",
          { sharing: "edit" },
        )
      ).status,
    ).toBe(409);
    expect(standalone.sharing).toBe("private");
  });

  it("keeps the agent's own notes out of people's lists until it publishes one", async () => {
    const own = await newThread(owner);
    const tool = toolFor(own);
    const note = await tool({
      action: "create",
      title: "Working notes",
      markdown: "Tried the cache; the flaky test is the clock.",
      audience: "agent",
    });
    expect(note).toMatchObject({ saved: true, audience: "agent" });
    const summary = await tool({
      action: "create",
      title: "Release summary",
      markdown: "# Release\n",
    });
    expect(summary.audience).toBeUndefined();

    // The Thread's list carries the mark, so the panel can hide the note.
    const listed = await ownerApi(`/v1/threads/${own}/artifacts`);
    expect(listed.status).toBe(200);
    const byTitle = new Map(
      (
        listed.body.data.artifacts as ReadonlyArray<{
          title: string;
          audience?: string;
        }>
      ).map((artifact) => [artifact.title, artifact.audience]),
    );
    expect(byTitle.get("Working notes")).toBe("agent");
    expect(byTitle.has("Release summary")).toBe(true);
    expect(byTitle.get("Release summary")).toBeUndefined();
    expect((await tool({ action: "list" })).artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Working notes", audience: "agent" }),
      ]),
    );

    // The library never lists it, not even under Made by agent.
    const names = titles(await library(ownerApi, "?filter=agent"));
    expect(names).toContain("Release summary");
    expect(names).not.toContain("Working notes");

    // Agent notes belong to a Thread.
    await expect(
      tool({
        action: "create",
        title: "Loose notes",
        markdown: "x",
        audience: "agent",
        standalone: true,
      }),
    ).rejects.toThrow(/belong to this Thread/);

    // Publishing it saves a revision and lists it for people.
    const published = await tool({
      action: "update",
      artifact_id: note.artifact_id,
      base_revision: note.revision,
      audience: "people",
    });
    expect(published.revision).toBe(note.revision + 1);
    expect(published.audience).toBeUndefined();
    expect(titles(await library(ownerApi, "?filter=agent"))).toContain(
      "Working notes",
    );
  });

  it("lets the agent search, read, and edit global artifacts only as far as its owner may", async () => {
    // The member's Thread runs the agent; the owner shares two artifacts.
    const agentThread = await newThread(member, memberProject.id);
    const artifact = toolFor(agentThread);
    const editable = await createStandalone(ownerApi, "Team glossary", {
      markdown: "# Team glossary\n\n- Orb: a sandbox\n",
    });
    const viewOnly = await createStandalone(ownerApi, "Team budget");
    const secret = await createStandalone(ownerApi, "Team secret plan", {
      markdown: "never for the member",
    });
    await ownerApi(`/v1/artifacts/${editable.id}/sharing`, "PUT", {
      sharing: "edit",
    });
    await ownerApi(`/v1/artifacts/${viewOnly.id}/sharing`, "PUT", {
      sharing: "view",
    });

    const listed = await artifact({
      action: "list",
      scope: "all",
      query: "team",
    });
    const ids = listed.artifacts.map(
      (entry: { artifact_id: string }) => entry.artifact_id,
    );
    expect(ids).toEqual(expect.arrayContaining([editable.id, viewOnly.id]));
    expect(ids).not.toContain(secret.id);
    expect(
      listed.artifacts.find(
        (entry: { artifact_id: string }) => entry.artifact_id === editable.id,
      ),
    ).toMatchObject({
      access: "edit",
      lives_in: "Artifacts library",
      link: `/artifacts/${editable.id}`,
    });

    const read = await artifact({ action: "read", artifact_id: editable.id });
    expect(read.markdown).toContain("Orb: a sandbox");
    const updated = await artifact({
      action: "update",
      artifact_id: editable.id,
      base_revision: read.revision,
      edits: [
        {
          old_str: "- Orb: a sandbox",
          new_str: "- Orb: a sandbox\n- Space: a shared goal",
        },
      ],
    });
    expect(updated).toMatchObject({ saved: true, revision: 2 });
    const after = await ownerApi(`/v1/standalone-artifacts/${editable.id}`);
    expect(after.body.data.markdown).toContain("Space: a shared goal");
    expect(after.body.data.artifact.updatedBy).toEqual({ kind: "agent" });

    await expect(
      artifact({
        action: "update",
        artifact_id: viewOnly.id,
        base_revision: 1,
        markdown: "overwritten",
      }),
    ).rejects.toThrow(/only view/);
    await expect(
      artifact({ action: "read", artifact_id: secret.id }),
    ).rejects.toThrow(/cannot open/);

    // The agent makes a standalone artifact in its owner's library.
    const made = await artifact({
      action: "create",
      standalone: true,
      title: "Agent summary",
      markdown: "# Agent summary\n",
    });
    expect(made).toMatchObject({ saved: true, revision: 1 });
    const mine = await library(memberApi, "?filter=agent");
    expect(mine.find((item) => item.id === made.artifact_id)).toMatchObject({
      title: "Agent summary",
      createdBy: { kind: "agent" },
      sharing: "private",
      access: "owner",
    });
    expect((await ownerApi(`/v1/artifacts/${made.artifact_id}`)).status).toBe(
      404,
    );
  });
});
