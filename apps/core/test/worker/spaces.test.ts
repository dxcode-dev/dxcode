import { env } from "cloudflare:test";
import { parseMessageAuthor, type SpaceData } from "@dx/api";
import {
  Principal,
  ProjectRepository,
  type ThreadId,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { spaceRoutes } from "../../src/spaces/routes.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { followThread } from "../../src/thread-sharing/members.js";
import {
  attributeSubmission,
  shareThreadReads,
} from "../../src/thread-sharing/middleware.js";
import { sharedThreadRoutes } from "../../src/thread-sharing/routes.js";
import { createThreadTools } from "../../src/threads/agent-tools.js";
import { threadRoutes } from "../../src/threads/routes.js";
import { project } from "./fixtures.js";
import { runRepositories } from "./runtime.js";
import { turnSpacesOn } from "./spaces-flag.js";

/**
 * Spaces end to end in workerd with real D1: creating, listing, discovering,
 * joining, leaving, editing, writing in, and listing the threads of a Space.
 *
 * Ways it could go wrong: a private Space reaches someone else, in a list,
 * by ID, or by joining; a workspace Space is read-only for members, expires
 * like multiplayer, or never shows in Discover; a member's message becomes
 * chat the agent never reads; a joined Space stays listed after leaving, or
 * an unjoined one lists in the sidebar; a contributor edits the Space; a
 * Space also lists as an ordinary Thread; a child loses who asked for it;
 * archiving leaves no time, or restoring keeps it.
 */

const flue = vi.hoisted(() => ({
  dispatched: [] as Array<{
    readonly id: string;
    readonly message: { readonly body: string };
  }>,
}));

// Thread creation runs for real; Flue's dispatch records the first message
// instead of running a model.
vi.mock("../../src/threads/routes.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/threads/routes.js")>();
  return {
    ...actual,
    threadRoutes: actual.createThreadRoutes(
      async (request) => {
        flue.dispatched.push(
          request as unknown as (typeof flue.dispatched)[number],
        );
        return { submissionId: `sub_${request.id}` } as never;
      },
      async () => undefined,
      async () => null,
    ),
  };
});

const owner = "space-owner" as UserId;
const member = "space-member" as UserId;
const outsider = "space-outsider" as UserId;
const workspaceId = "space-workspace";
const otherWorkspaceId = "space-other-workspace";
const fixtureProject = project(
  "prj_00000000-0000-4000-8000-00000000a151",
  owner,
  "checkout",
);
// A child Thread's first message admits the Project's Orb, so it names one
// the test catalog offers.
const ownerProject = {
  ...fixtureProject,
  configuration: {
    ...fixtureProject.configuration,
    runnerProfileId: "a1.medium",
  },
} as typeof fixtureProject;

const bindings: Bindings = {
  DB: env.DB,
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
};

const appFor = (userId: UserId) => {
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
  app.route("/v1/spaces", spaceRoutes);
  app.route("/v1/shared-threads", sharedThreadRoutes);
  app.use("/v1/threads/:threadId", shareThreadReads);
  app.route("/v1/threads", threadRoutes);
  app.use("/agents/:threadId", authorizeThread);
  app.use("/agents/:threadId", attributeSubmission);
  // Stands in for Flue's router: reports what it was delivered.
  app.post("/agents/:id", async (context) =>
    context.json({ delivered: await context.req.json() }, 202),
  );
  app.onError(errorHandler);
  return app;
};

const send = async (
  userId: UserId,
  path: string,
  method = "GET",
  body?: unknown,
) => {
  const response = await appFor(userId).request(
    path,
    {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
  return {
    status: response.status,
    // biome-ignore lint/suspicious/noExplicitAny: test reads loose JSON.
    body: (await response.json().catch(() => undefined)) as any,
  };
};

const create = async (body: Record<string, unknown>, userId = owner) =>
  send(userId, "/v1/spaces", "POST", {
    projectId: ownerProject.id,
    ...body,
  });

const joined = async (userId: UserId) =>
  ((await send(userId, "/v1/spaces")).body.data.items as SpaceData[]).map(
    ({ threadId }) => threadId,
  );

const discovered = async (userId: UserId, q?: string) =>
  (
    (
      await send(
        userId,
        `/v1/spaces/discover${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`,
      )
    ).body.data.items as SpaceData[]
  ).map(({ threadId }) => threadId);

const user = (id: string, name: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`);

const threadRow = (threadId: string) =>
  env.DB.prepare(
    `SELECT kind, parent_thread_id, requested_by_user_id, archived_at,
            lifecycle_state, conversation_mode, workspace_access, title, color
       FROM threads WHERE id = ?`,
  )
    .bind(threadId)
    .first<Record<string, unknown>>();

beforeEach(async () => {
  flue.dispatched.length = 0;
  await env.DB.batch([
    user(owner, "Ada Owner"),
    user(member, "Ben Member"),
    user(outsider, "Cy Outsider"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1), (?, ?, ?, 1)",
    ).bind(
      workspaceId,
      "Space Team",
      "space-team",
      otherWorkspaceId,
      "Other",
      "space-other",
    ),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('sp-owner', ?1, ?2, 'owner', 1),
         ('sp-member', ?1, ?3, 'member', 2),
         ('sp-outsider', ?4, ?5, 'owner', 3)`,
    ).bind(workspaceId, owner, member, otherWorkspaceId, outsider),
    // Creating a workspace writes its policy; starting a Thread reads it.
    env.DB.prepare(
      "INSERT INTO workspace_policy (workspace_id, updated_at) VALUES (?1, 1), (?2, 1) ON CONFLICT DO NOTHING",
    ).bind(workspaceId, otherWorkspaceId),
    // Signing up creates the account; Ben picked a username.
    env.DB.prepare(
      "UPDATE personal_account SET username = 'benm' WHERE user_id = ?1",
    ).bind(member),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      yield* projects.insert(ownerProject);
    }),
  );
});

// Spaces is a personal experimental feature (spaces/gate.ts).
beforeEach(() => turnSpacesOn([owner, member, outsider]));

describe("Spaces in workerd with real D1", () => {
  it("creates a private Space as a Thread only its owner reaches", async () => {
    const created = await create({
      name: "Checkout polish",
      goal: "Ship the new checkout flow",
      sharing: "private",
      color: "green",
    });
    expect(created.status).toBe(201);
    const space = created.body.data.space as SpaceData;
    expect(space).toMatchObject({
      name: "Checkout polish",
      goal: "Ship the new checkout flow",
      color: "green",
      projectId: ownerProject.id,
      projectName: "checkout",
      sharing: "private",
      ownerUserId: owner,
      joined: true,
      access: "owner",
      lifecycleState: "active",
    });
    expect(space.members.map(({ userId }) => userId)).toEqual([owner]);
    expect(await threadRow(space.threadId)).toMatchObject({
      kind: "space",
      title: "Checkout polish",
      conversation_mode: "agent",
      workspace_access: "none",
    });
    // No first turn from Thread creation: the new Space's agent hears its
    // hidden setup message and posts the welcome itself (space-posts.test).
    expect(flue.dispatched).toEqual([]);

    // The Thread page sees a Space; the sidebar lists it only as one.
    const detail = await send(owner, `/v1/threads/${space.threadId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      kind: "space",
      title: "Checkout polish",
    });
    const roots = await send(owner, "/v1/threads?roots=true");
    expect(
      roots.body.data.items.map(({ id }: { id: string }) => id),
    ).not.toContain(space.threadId);
    expect(await joined(owner)).toEqual([space.threadId]);

    // Nobody else reaches it.
    expect((await send(member, `/v1/spaces/${space.threadId}`)).status).toBe(
      404,
    );
    expect(
      (await send(member, `/v1/spaces/${space.threadId}/join`, "POST")).status,
    ).toBe(404);
    expect(
      (await send(member, `/v1/spaces/${space.threadId}/threads`)).status,
    ).toBe(404);
    expect((await send(member, `/v1/threads/${space.threadId}`)).status).toBe(
      404,
    );
    expect(await joined(member)).toEqual([]);
    expect(await discovered(member)).toEqual([]);
  });

  it("lets workspace members discover, join, chat in, and leave a shared Space", async () => {
    const created = await create({
      name: "Payments",
      goal: "Cut refund time in half",
      sharing: "workspace",
    });
    expect(created.status).toBe(201);
    const spaceId = (created.body.data.space as SpaceData).threadId;
    expect(created.body.data.space.sharing).toBe("workspace");
    expect(await threadRow(spaceId)).toMatchObject({
      workspace_access: "contribute",
    });

    // Members find it in Discover, matched by name or goal; outsiders never.
    expect(await discovered(member)).toEqual([spaceId]);
    expect(await discovered(member, "refund")).toEqual([spaceId]);
    expect(await discovered(member, "PAYM")).toEqual([spaceId]);
    expect(await discovered(member, "inventory")).toEqual([]);
    expect(await discovered(owner)).toEqual([]);
    expect(await discovered(outsider)).toEqual([]);
    expect((await send(outsider, `/v1/spaces/${spaceId}`)).status).toBe(404);
    expect(await joined(member)).toEqual([]);
    const seen = await send(member, `/v1/spaces/${spaceId}`);
    expect(seen.body.data.space).toMatchObject({
      joined: false,
      access: "contribute",
    });

    // Every member may chat, with no end to it.
    const detail = await send(member, `/v1/threads/${spaceId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      kind: "space",
      access: "contribute",
      sharing: { workspaceAccess: "contribute" },
    });
    expect(detail.body.data.sharing.contributeUntil).toBeUndefined();

    // Joining lists it in the member's sidebar.
    const join = await send(member, `/v1/spaces/${spaceId}/join`, "POST");
    expect(join.status).toBe(200);
    expect(join.body.data.space).toMatchObject({ joined: true });
    expect(
      (join.body.data.space as SpaceData).members.map(({ userId }) => userId),
    ).toEqual([owner, member]);
    expect(await joined(member)).toEqual([spaceId]);
    expect(await discovered(member)).toEqual([]);

    // The owner archives their Space rather than leaving it.
    const ownerLeave = await send(owner, `/v1/spaces/${spaceId}/leave`, "POST");
    expect(ownerLeave.status).toBe(409);
    expect(await joined(owner)).toEqual([spaceId]);

    // Leaving takes it out again, and back into Discover.
    const leave = await send(member, `/v1/spaces/${spaceId}/leave`, "POST");
    expect(leave.status).toBe(200);
    expect(leave.body.data.space.joined).toBe(false);
    expect(await joined(member)).toEqual([]);
    expect(await discovered(member)).toEqual([spaceId]);

    // Every message in a Space goes to its agent, even one that tags a
    // member, which in a shared Thread would be chat; and writing joins.
    await env.DB.prepare(
      "UPDATE threads SET conversation_mode = 'chat' WHERE id = ?",
    )
      .bind(spaceId)
      .run();
    const message = await send(member, `/agents/${spaceId}`, "POST", {
      kind: "user",
      body: "@benm can you take refunds? Add a retry to the refund job.",
    });
    expect(message.status).toBe(202);
    expect(message.body.delivered.kind).toBe("user");
    const tag = parseMessageAuthor(message.body.delivered.body);
    expect(tag.author).toMatchObject({ userId: member, role: "contributor" });
    expect(tag.chat).toBeUndefined();
    expect(await joined(member)).toEqual([spaceId]);
  });

  it("lets only the owner edit a Space, and making it private shuts members out", async () => {
    const spaceId = (
      await create({ name: "Docs", sharing: "workspace", color: "blue" })
    ).body.data.space.threadId as ThreadId;
    await send(member, `/v1/spaces/${spaceId}/join`, "POST");

    const refused = await send(member, `/v1/spaces/${spaceId}`, "PATCH", {
      name: "Mine now",
    });
    expect(refused.status).toBe(403);
    expect(refused.body.data.code).toBe("SPACE_OWNER_ONLY");
    expect(
      (await send(owner, `/v1/spaces/${spaceId}`, "PATCH", { name: "" }))
        .status,
    ).toBe(400);

    const edited = await send(owner, `/v1/spaces/${spaceId}`, "PATCH", {
      name: "Docs site",
      goal: "Rewrite the getting started guide",
      color: "purple",
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.space).toMatchObject({
      name: "Docs site",
      goal: "Rewrite the getting started guide",
      color: "purple",
      sharing: "workspace",
    });
    expect(await threadRow(spaceId)).toMatchObject({
      title: "Docs site",
      color: "purple",
    });
    const cleared = await send(owner, `/v1/spaces/${spaceId}`, "PATCH", {
      goal: null,
    });
    expect(cleared.body.data.space.goal).toBeNull();

    const closed = await send(owner, `/v1/spaces/${spaceId}`, "PATCH", {
      sharing: "private",
    });
    expect(closed.status).toBe(200);
    expect(closed.body.data.space.sharing).toBe("private");
    expect((await send(member, `/v1/spaces/${spaceId}`)).status).toBe(404);
    expect(await joined(member)).toEqual([]);
    expect(
      (closed.body.data.space as SpaceData).members.map(({ userId }) => userId),
    ).toEqual([owner]);
  });

  it("lists the threads a Space started with who asked, and records archive times", async () => {
    const spaceId = (await create({ name: "Launch", sharing: "workspace" }))
      .body.data.space.threadId as ThreadId;
    // The Space's agent starts a child for the member whose message it
    // answers, through the create_thread tool.
    const tools = createThreadTools(
      spaceId,
      () => ({ db: env.DB, bindings }),
      "sub_space_turn",
      false,
      member,
    );
    const createThread = tools.find(({ name }) => name === "create_thread");
    if (createThread === undefined) throw new Error("No create_thread tool.");
    const started = (await createThread.run({
      data: {
        prompt: '"Add a retry to the refund job." — Ben',
        title: "Retry refunds",
      },
      toolCallId: "call_child",
    } as never)) as { output: { threadId: string } };
    const childId = started.output.threadId as ThreadId;
    expect(await threadRow(childId)).toMatchObject({
      kind: "thread",
      parent_thread_id: spaceId,
      requested_by_user_id: member,
      workspace_access: "contribute",
    });
    // Without a person behind the turn, the owner asked.
    const ownTools = createThreadTools(spaceId, () => ({
      db: env.DB,
      bindings,
    }));
    const ownCreateThread = ownTools.find(
      ({ name }) => name === "create_thread",
    );
    if (ownCreateThread === undefined)
      throw new Error("No create_thread tool.");
    const ownChild = (
      (await ownCreateThread.run({
        data: { prompt: "Write release notes.", title: "Release notes" },
        toolCallId: "call_own",
      } as never)) as { output: { threadId: string } }
    ).output.threadId;
    expect(await threadRow(ownChild)).toMatchObject({
      requested_by_user_id: owner,
    });
    await env.DB.prepare(
      "UPDATE threads SET activity_status = 'working', status_line = 'Running the refund tests' WHERE id = ?",
    )
      .bind(childId)
      .run();

    const listed = await send(member, `/v1/spaces/${spaceId}/threads`);
    expect(listed.status).toBe(200);
    const items = listed.body.data.items as Array<Record<string, unknown>>;
    expect(items.map(({ id }) => id).sort()).toEqual(
      [childId, ownChild].sort(),
    );
    expect(items.find(({ id }) => id === childId)).toMatchObject({
      title: "Retry refunds",
      parentThreadId: spaceId,
      requestedBy: { userId: member, name: "Ben Member" },
      statusLine: "Running the refund tests",
      state: "working",
      shippedAt: null,
      archivedAt: null,
    });
    // Its first message started its first turn, which is still running.
    expect(items.find(({ id }) => id === ownChild)).toMatchObject({
      requestedBy: { userId: owner, name: "Ada Owner" },
      state: "working",
    });

    // Archiving records when; restoring clears it.
    const archive = await send(
      owner,
      `/v1/threads/${ownChild}/archive`,
      "PATCH",
      {
        archived: true,
      },
    );
    expect(archive.status).toBe(200);
    const archivedAt = (await threadRow(ownChild))?.archived_at;
    expect(typeof archivedAt).toBe("number");
    expect(Math.abs(Date.now() - (archivedAt as number))).toBeLessThan(60_000);
    const afterArchive = (
      await send(owner, `/v1/spaces/${spaceId}/threads`)
    ).body.data.items.find(({ id }: { id: string }) => id === ownChild);
    expect(afterArchive).toMatchObject({ state: "archived" });
    expect(Date.parse(afterArchive.archivedAt)).toBe(archivedAt);
    await send(owner, `/v1/threads/${ownChild}/archive`, "PATCH", {
      archived: false,
    });
    expect((await threadRow(ownChild))?.archived_at).toBeNull();
  });

  it("lists a Space's threads only in the Space, never in anyone's ordinary sidebar", async () => {
    const spaceId = (await create({ name: "Sidebar", sharing: "workspace" }))
      .body.data.space.threadId as ThreadId;
    const tools = createThreadTools(spaceId, () => ({ db: env.DB, bindings }));
    const createThread = tools.find(({ name }) => name === "create_thread");
    if (createThread === undefined) throw new Error("No create_thread tool.");
    const startChild = async (title: string) =>
      (
        (await createThread.run({
          data: { prompt: `${title}, research only.`, title },
          toolCallId: `call_${title.replaceAll(" ", "_")}`,
        } as never)) as { output: { threadId: string } }
      ).output.threadId as ThreadId;
    const childId = await startChild("Walk the tools folder");
    const archivedChildId = await startChild("Survey the tests");
    // The member follows the child, as a mention in it or opening it can
    // make them; the owner archives the other one and pins nothing.
    await followThread(env.DB, childId, [member]);
    expect(
      (
        await send(owner, `/v1/threads/${archivedChildId}/archive`, "PATCH", {
          archived: true,
        })
      ).status,
    ).toBe(200);

    const listed = (await send(member, `/v1/spaces/${spaceId}/threads`)).body
      .data.items as Array<{ id: string }>;
    expect(listed.map(({ id }) => id).sort()).toEqual(
      [childId, archivedChildId].sort(),
    );
    const shared = await send(member, "/v1/shared-threads");
    expect(shared.status).toBe(200);
    expect(
      (shared.body.data.items as Array<{ id: string }>).map(({ id }) => id),
    ).not.toContain(childId);
    for (const lifecycleState of ["active", "archived"]) {
      const roots = await send(
        owner,
        `/v1/threads?limit=100&lifecycleState=${lifecycleState}&roots=true`,
      );
      expect(roots.status).toBe(200);
      const ids = [
        ...roots.body.data.items,
        ...(roots.body.data.children ?? []),
      ].map(({ id }: { id: string }) => id);
      expect(ids).not.toContain(childId);
      expect(ids).not.toContain(archivedChildId);
    }
  });
});
