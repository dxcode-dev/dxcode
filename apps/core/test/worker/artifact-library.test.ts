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
import { threadArtifactRoutes } from "../../src/thread-artifacts/routes.js";
import { createArtifact } from "../../src/thread-artifacts/store.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * The Artifacts library, through workerd's real D1 and R2: standalone
 * artifacts with no Thread, every artifact a person may open in one list,
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
 *   sources; the newest save does not list first;
 * - a Thread's artifacts, or those of a Thread shared with the member, are
 *   missing from the library, or an unshared Thread's leak into it;
 * - the artifact home shows up as a Thread in the owner's Thread list, or
 *   an agent message or Orb request reaches it;
 * - Notify agent on a standalone artifact tries to wake its home, or a
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
      // biome-ignore lint/suspicious/noExplicitAny: each test reads its own shape.
      body: (await response.json()) as any,
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
    expect(found.body.data.item.threadId).toBe(created.threadId);

    const read = await ownerApi(
      `/v1/threads/${created.threadId}/artifacts/${created.id}`,
    );
    expect(read.status).toBe(200);
    expect((read.body as ThreadArtifactResponse).data.markdown).toContain(
      "Ship the library",
    );
    const saved = await ownerApi(
      `/v1/threads/${created.threadId}/artifacts/${created.id}`,
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

  it("never shows the home as a Thread, and admits no agent message to it", async () => {
    const created = await createStandalone(ownerApi, "Hidden home check");
    const ordinary = await newThread(owner);
    const listed = await runRepositories(
      Effect.gen(function* () {
        return yield* (yield* ThreadRepository).listOwned(
          { userId: owner },
          undefined,
          { limit: 100 },
        );
      }),
    );
    const ids = listed.items.map((item) => item.id);
    expect(ids).toContain(ordinary);
    expect(ids).not.toContain(created.threadId);

    const message = await ownerApi(
      `/v1/agents/dx/${created.threadId}`,
      "POST",
      {
        message: "hello",
      },
    );
    expect(message.status).toBe(404);
    const control = await ownerApi(`/v1/agents/dx/${ordinary}`, "POST", {
      message: "hello",
    });
    expect(control.status).toBe(202);
  });

  it("refuses Notify agent on a standalone artifact and wakes no agent for @dx in its comments", async () => {
    const created = await createStandalone(ownerApi, "No agent here", {
      markdown: "Ship it today.\n",
    });
    const notify = await ownerApi(
      `/v1/threads/${created.threadId}/artifacts/${created.id}/notify`,
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
    const asked = (threadId: ThreadId, artifactId: string, commentId: string) =>
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
    await asked(created.threadId, created.id, "cmt_standalone");
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
      (
        await memberApi(
          `/v1/threads/${created.threadId}/artifacts/${created.id}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await memberApi(
          `/v1/threads/${created.threadId}/artifacts/${created.id}`,
          "PUT",
          { baseRevision: 1, markdown: "taken over" },
        )
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
      (
        await memberApi(
          `/v1/threads/${created.threadId}/artifacts/${created.id}`,
        )
      ).status,
    ).toBe(200);
    const refused = await memberApi(
      `/v1/threads/${created.threadId}/artifacts/${created.id}`,
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
      `/v1/threads/${created.threadId}/artifacts/${created.id}`,
      "PUT",
      { baseRevision: 1, markdown: "# Pricing\n\nMember edit\n" },
    );
    expect(edited.status).toBe(200);
    expect(edited.body.data.artifact.updatedBy).toMatchObject({
      kind: "user",
      name: "Maya Member",
    });
    const comment = await memberApi(
      `/v1/threads/${created.threadId}/artifacts/${created.id}/comments`,
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

  it("lists Thread artifacts beside standalone ones, searches titles, and filters by source", async () => {
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

    const everything = await library(ownerApi);
    const names = titles(everything);
    expect(names).toEqual(
      expect.arrayContaining([
        "Launch checklist 100%",
        "Launch notes",
        "Billing runbook",
      ]),
    );
    expect(names).not.toContain("Member private notes");
    // Newest save first.
    expect(names.indexOf("Launch notes")).toBeLessThan(
      names.indexOf("Launch checklist 100%"),
    );
    expect(
      everything.find((item) => item.title === "Billing runbook"),
    ).toMatchObject({ source: { kind: "thread" }, access: "view" });

    expect(titles(await library(ownerApi, "?q=launch"))).toEqual([
      "Launch notes",
      "Launch checklist 100%",
    ]);
    // `%` matches itself, not everything.
    expect(titles(await library(ownerApi, "?q=100%25"))).toEqual([
      "Launch checklist 100%",
    ]);
    const mine = titles(await library(ownerApi, "?filter=mine"));
    expect(mine).toContain("Launch notes");
    expect(mine).not.toContain("Launch checklist 100%");
    expect(titles(await library(ownerApi, "?filter=shared"))).toEqual([
      "Billing runbook",
    ]);
    const fromThreads = titles(await library(ownerApi, "?filter=threads"));
    expect(fromThreads).toContain("Launch checklist 100%");
    expect(fromThreads).not.toContain("Launch notes");

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
    const after = await ownerApi(
      `/v1/threads/${editable.threadId}/artifacts/${editable.id}`,
    );
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
    const mine = await library(memberApi, "?filter=mine");
    expect(mine.find((item) => item.id === made.artifact_id)).toMatchObject({
      title: "Agent summary",
      sharing: "private",
      access: "owner",
    });
    expect((await ownerApi(`/v1/artifacts/${made.artifact_id}`)).status).toBe(
      404,
    );
  });
});
