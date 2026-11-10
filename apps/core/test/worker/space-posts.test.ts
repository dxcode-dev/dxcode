import { env } from "cloudflare:test";
import {
  parseMessageAuthor,
  type SpaceData,
  type SpacePost,
  spaceWorkerReport,
} from "@dx/api";
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
import { buildSpaceSetupMessage } from "../../src/spaces/agent/setup-message.js";
import { messageCommentRoutes } from "../../src/spaces/message-comments/routes.js";
import { clearSpaceEyesOnSettle } from "../../src/spaces/posts/eyes.js";
import { reportTurnToSpace } from "../../src/spaces/report-back.js";
import { spaceRoutes } from "../../src/spaces/routes.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { createThreadTools } from "../../src/threads/agent-tools.js";
import { ownerRequest } from "../../src/threads/owner-request.js";
import { project } from "./fixtures.js";
import { runRepositories } from "./runtime.js";
import { turnSpacesOn } from "./spaces-flag.js";

/**
 * A Space's posts end to end in workerd with real D1, through the same
 * Thread authorization and message admission as the app: people post, edit
 * their own posts, react, and comment; every person's post reaches the
 * Space's agent tagged with its ID, and dx's `eyes` shows on it until the
 * agent's turn ends; children's results arrive as worker reports; a new
 * Space sends its agent a hidden setup message instead of a welcome.
 *
 * Ways it could go wrong: a post never reaches the agent, or reaches it
 * without its ID, or twice; a message sent straight to the agent skips the
 * post; a refused delivery leaves a post nobody's agent saw; someone edits
 * another's post, or an edit loses the earlier text; a viewer or outsider
 * posts or reacts, or anyone posts in an archived Space; a reaction counts
 * twice or names the wrong person; `eyes` stays after the turn, or leaves
 * before it; a change reaches no one watching; a child's report shows as a
 * post, or reaches the agent without saying whose it is; an @dx comment
 * reaches the agent without the post and the comments before it; the setup
 * message shows as a post or reaches the agent as a person's post.
 */

const flue = vi.hoisted(() => ({
  agent: [] as Array<{
    readonly threadId: string;
    readonly body: string;
    readonly delivered: Record<string, unknown>;
  }>,
  /** Deliveries the agent refuses, by body text. */
  refuse: undefined as RegExp | undefined,
}));

const realtime = vi.hoisted(() => ({
  events: [] as Array<{ readonly type: string; readonly threadId: string }>,
}));

// Thread creation runs for real; Flue's dispatch of a first message is
// skipped (a Space starts without one).
vi.mock("../../src/threads/routes.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/threads/routes.js")>();
  return {
    ...actual,
    threadRoutes: actual.createThreadRoutes(
      async (request) => ({ submissionId: `sub_${request.id}` }) as never,
      async () => undefined,
      async () => null,
    ),
  };
});

// DxAgent's routes behind the app's real Thread authorization, lifecycle
// check, and message attribution; Flue itself only records what it was
// given and answers with a submission.
vi.mock("../../src/agents/routes.js", async () => {
  const { Hono: Router } = await import("hono");
  const { authorizeThread: authorize } = await import(
    "../../src/auth/authorize-thread.js"
  );
  const { enforceThreadActive } = await import(
    "../../src/auth/enforce-thread-active.js"
  );
  const { attributeSubmission } = await import(
    "../../src/thread-sharing/middleware.js"
  );
  const routes = new Router<AppEnv>();
  routes.use("/:threadId", authorize);
  routes.use("/:threadId", enforceThreadActive);
  routes.use("/:threadId", attributeSubmission);
  routes.post("/:threadId", async (context) => {
    const delivered = (await context.req.json()) as Record<string, unknown> & {
      body: string;
    };
    if (flue.refuse?.test(delivered.body) === true)
      return context.json({ error: { type: "refused" } }, 409);
    flue.agent.push({
      threadId: context.req.param("threadId"),
      body: delivered.body,
      delivered,
    });
    return context.json({ submissionId: `sub_${flue.agent.length}` }, 202);
  });
  return {
    dxAgentRoutes: routes,
    stopThreadAgent: async () => undefined,
  };
});

const owner = "post-owner" as UserId;
const member = "post-member" as UserId;
const viewer = "post-viewer" as UserId;
const outsider = "post-outsider" as UserId;
const workspaceId = "post-workspace";
const otherWorkspaceId = "post-other-workspace";
const fixtureProject = project(
  "prj_00000000-0000-4000-8000-00000000d157",
  owner,
  "checkout",
);
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
  DX_AUTH_URL: "https://dx.example.com",
  // Records every realtime publication instead of fanning it out.
  REALTIME_HUB: {
    getByName: () => ({
      fetch: async (_url: string, init: RequestInit) => {
        realtime.events.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      },
    }),
  } as unknown as Bindings["REALTIME_HUB"],
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
  app.use("/v1/threads/:threadId/message-comments/*", authorizeThread);
  app.route("/v1/threads", messageCommentRoutes);
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

const createSpace = async (sharing: "workspace" | "private") => {
  const created = await send(owner, "/v1/spaces", "POST", {
    projectId: ownerProject.id,
    name: "Checkout v2",
    goal: "Ship the one-page checkout",
    sharing,
  });
  expect(created.status).toBe(201);
  return (created.body.data.space as SpaceData).threadId as ThreadId;
};

/** A Space whose setup message the test has already seen. */
const freshSpace = async (sharing: "workspace" | "private" = "workspace") => {
  const spaceId = await createSpace(sharing);
  flue.agent.length = 0;
  realtime.events.length = 0;
  return spaceId;
};

const post = (userId: UserId, spaceId: string, text: string) =>
  send(userId, `/v1/spaces/${spaceId}/posts`, "POST", { text });

const posts = async (userId: UserId, spaceId: string, query = "") =>
  (await send(userId, `/v1/spaces/${spaceId}/posts${query}`)).body.data as {
    items: SpacePost[];
    nextBefore?: string;
  };

const reactions = (item: SpacePost | undefined) =>
  Object.fromEntries(
    (item?.reactions ?? []).map(({ reaction, count, mine, agent }) => [
      reaction,
      { count, mine, agent },
    ]),
  );

const postsChanged = (spaceId: string) =>
  realtime.events.filter(
    ({ type, threadId }) =>
      type === "space.posts.invalidated" && threadId === spaceId,
  ).length;

const user = (id: string, name: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`);

beforeEach(async () => {
  flue.agent.length = 0;
  flue.refuse = undefined;
  realtime.events.length = 0;
  await env.DB.batch([
    user(owner, "Ada Owner"),
    user(member, "Ben Member"),
    user(viewer, "Vi Viewer"),
    user(outsider, "Cy Outsider"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1), (?, ?, ?, 1)",
    ).bind(
      workspaceId,
      "Post Team",
      "post-team",
      otherWorkspaceId,
      "Other",
      "post-other",
    ),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('pm-owner', ?1, ?2, 'owner', 1),
         ('pm-member', ?1, ?3, 'member', 2),
         ('pm-viewer', ?1, ?4, 'member', 3),
         ('pm-outsider', ?5, ?6, 'owner', 4)`,
    ).bind(workspaceId, owner, member, viewer, otherWorkspaceId, outsider),
    env.DB.prepare(
      "INSERT INTO workspace_policy (workspace_id, updated_at) VALUES (?1, 1), (?2, 1) ON CONFLICT DO NOTHING",
    ).bind(workspaceId, otherWorkspaceId),
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
beforeEach(() => turnSpacesOn([owner, member, viewer, outsider]));

describe("A new Space", () => {
  it("sends its agent a hidden setup message, which is not a post", async () => {
    const spaceId = await createSpace("private");
    expect(flue.agent).toHaveLength(1);
    const [setup] = flue.agent;
    expect(setup?.threadId).toBe(spaceId);
    const tag = parseMessageAuthor(setup?.body ?? "");
    // From the creator, so the agent knows whom to welcome.
    expect(tag.author).toMatchObject({ userId: owner, role: "owner" });
    expect(tag.text).toBe(
      buildSpaceSetupMessage({
        spaceName: "Checkout v2",
        project: { name: "checkout", repositories: [] },
        creatorName: "Ada Owner",
      }),
    );
    expect(tag.text).not.toContain("<post id=");
    // It creates the Space's agent with its owner's initialization.
    expect(setup?.delivered.initialData).toMatchObject({
      personalInstructions: expect.any(String),
    });
    expect((await posts(owner, spaceId)).items).toEqual([]);
    // It runs on the route picked once at creation (spaces/agent-model.ts):
    // here the creator's Space model through Model Routing, since the test
    // account has no Claude plan, in executor mode with no Orb.
    const row = await env.DB.prepare(
      "SELECT model_selection, execution_mode FROM threads WHERE id = ?",
    )
      .bind(spaceId)
      .first<{ model_selection: string; execution_mode: string }>();
    expect(JSON.parse(row?.model_selection ?? "{}")).toMatchObject({
      kind: "model",
      model: "cloudflare/@cf/zai-org/glm-5.3-flash",
      thinking: "medium",
    });
    expect(row?.execution_mode).toBe("executor");
  });
});

describe("Space posts", () => {
  it("makes every person's message a post that reaches the agent with its ID", async () => {
    const spaceId = await freshSpace();
    const first = await post(owner, spaceId, "Fix the coupon rounding.");
    expect(first.status).toBe(201);
    const created = first.body.data.post as SpacePost;
    expect(created).toMatchObject({
      author: { kind: "user", userId: owner, name: "Ada Owner" },
      text: "Fix the coupon rounding.",
      revisionCount: 0,
      comments: { count: 0, commenters: [] },
    });
    expect(created.id).toMatch(/^pst_[0-9a-z]{26}$/);
    expect(created.editedAt).toBeUndefined();
    const second = await post(member, spaceId, "And the tax line, please.");
    expect(second.status).toBe(201);
    const secondId = (second.body.data.post as SpacePost).id;

    // Each reached the agent once, as its author, followed by its tag.
    expect(flue.agent).toHaveLength(2);
    const [toAgent, fromMember] = flue.agent.map(({ body }) =>
      parseMessageAuthor(body),
    );
    expect(toAgent?.author).toMatchObject({ userId: owner, role: "owner" });
    expect(toAgent?.text).toBe(
      `Fix the coupon rounding.\n\n<post id="${created.id}" />`,
    );
    expect(fromMember?.author).toMatchObject({
      userId: member,
      role: "contributor",
      handle: "benm",
    });
    expect(fromMember?.text).toBe(
      `And the tax line, please.\n\n<post id="${secondId}" />`,
    );

    // A message sent straight to the agent, as an older client does, is a
    // post too.
    const direct = await ownerRequest(
      { bindings, ownerUserId: owner },
      "POST",
      `/v1/agents/dx/${spaceId}`,
      { kind: "user", body: "Also check refunds.", idempotencyKey: "k-1" },
    );
    expect(direct.response.status).toBe(202);
    const listed = await posts(member, spaceId);
    expect(listed.items.map(({ text }) => text)).toEqual([
      "Fix the coupon rounding.",
      "And the tax line, please.",
      "Also check refunds.",
    ]);
    const directId = listed.items[2]?.id;
    expect(parseMessageAuthor(flue.agent[2]?.body ?? "").text).toBe(
      `Also check refunds.\n\n<post id="${directId}" />`,
    );
    // Its retry converges on the same post.
    await ownerRequest(
      { bindings, ownerUserId: owner },
      "POST",
      `/v1/agents/dx/${spaceId}`,
      { kind: "user", body: "Also check refunds.", idempotencyKey: "k-1" },
    );
    expect((await posts(owner, spaceId)).items).toHaveLength(3);
    expect(parseMessageAuthor(flue.agent[3]?.body ?? "").text).toBe(
      `Also check refunds.\n\n<post id="${directId}" />`,
    );

    // Newest last; pages reach back with `before`.
    const page = await posts(owner, spaceId, "?limit=2");
    expect(page.items.map(({ text }) => text)).toEqual([
      "And the tax line, please.",
      "Also check refunds.",
    ]);
    expect(page.nextBefore).toBe(secondId);
    const older = await posts(owner, spaceId, `?limit=2&before=${secondId}`);
    expect(older.items.map(({ id }) => id)).toEqual([created.id]);
    expect(older.nextBefore).toBeUndefined();
    expect(
      (await send(owner, `/v1/spaces/${spaceId}/posts?limit=0`)).status,
    ).toBe(400);
  });

  it("stores nothing when the agent refuses a post", async () => {
    const spaceId = await freshSpace();
    flue.refuse = /Refuse me/;
    const refused = await post(owner, spaceId, "Refuse me");
    expect(refused.status).toBe(503);
    expect(refused.body.data.code).toBe("SPACE_AGENT_UNAVAILABLE");
    expect((await posts(owner, spaceId)).items).toEqual([]);
  });

  it("lets authors edit only their own posts, keeps every version, and tells the agent what changed", async () => {
    const spaceId = await freshSpace();
    const created = (await post(member, spaceId, "Ship on Friday.")).body.data
      .post as SpacePost;
    flue.agent.length = 0;

    const edited = await send(
      member,
      `/v1/spaces/${spaceId}/posts/${created.id}`,
      "PATCH",
      { text: "Ship on Thursday." },
    );
    expect(edited.status).toBe(200);
    expect(edited.body.data.post).toMatchObject({
      id: created.id,
      text: "Ship on Thursday.",
      revisionCount: 1,
    });
    expect(edited.body.data.post.editedAt).toBeDefined();
    expect(flue.agent).toHaveLength(1);
    const tag = parseMessageAuthor(flue.agent[0]?.body ?? "");
    expect(tag.author).toMatchObject({ userId: member });
    expect(tag.text).toBe(
      `Ship on Thursday.\n\n<edited_post id="${created.id}">\nShip on Friday.\n</edited_post>`,
    );

    await send(member, `/v1/spaces/${spaceId}/posts/${created.id}`, "PATCH", {
      text: "Ship on Thursday, after QA.",
    });
    const revisions = await send(
      owner,
      `/v1/spaces/${spaceId}/posts/${created.id}/revisions`,
    );
    expect(revisions.status).toBe(200);
    expect(
      revisions.body.data.items.map(
        ({ revision, text }: { revision: number; text: string }) => [
          revision,
          text,
        ],
      ),
    ).toEqual([
      [1, "Ship on Friday."],
      [2, "Ship on Thursday."],
      [3, "Ship on Thursday, after QA."],
    ]);

    // Not even the Space's owner edits someone else's post.
    const notYours = await send(
      owner,
      `/v1/spaces/${spaceId}/posts/${created.id}`,
      "PATCH",
      { text: "Ship whenever." },
    );
    expect(notYours.status).toBe(403);
    expect(notYours.body.data.code).toBe("POST_NOT_YOURS");
    const missing = await send(
      member,
      `/v1/spaces/${spaceId}/posts/pst_00000000000000000000000000`,
      "PATCH",
      { text: "Hi" },
    );
    expect(missing.status).toBe(404);
    expect(missing.body.data.code).toBe("POST_NOT_FOUND");
    expect((await posts(owner, spaceId)).items[0]?.text).toBe(
      "Ship on Thursday, after QA.",
    );
  });

  it("lets viewers read but not write, keeps outsiders out, and closes an archived Space", async () => {
    const spaceId = await freshSpace();
    const created = (await post(owner, spaceId, "Hello team")).body.data
      .post as SpacePost;
    await env.DB.prepare(
      "UPDATE threads SET workspace_access = 'view' WHERE id = ?",
    )
      .bind(spaceId)
      .run();
    expect((await send(viewer, `/v1/spaces/${spaceId}/posts`)).status).toBe(
      200,
    );
    expect((await post(viewer, spaceId, "Me too")).status).toBe(403);
    expect(
      (
        await send(
          viewer,
          `/v1/spaces/${spaceId}/posts/${created.id}/reactions/heart`,
          "PUT",
        )
      ).status,
    ).toBe(403);
    expect((await send(outsider, `/v1/spaces/${spaceId}/posts`)).status).toBe(
      404,
    );
    expect((await post(outsider, spaceId, "Hi")).status).toBe(404);

    // A private Space is its owner's alone.
    const privateId = await freshSpace("private");
    expect((await send(member, `/v1/spaces/${privateId}/posts`)).status).toBe(
      404,
    );

    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived', workspace_access = 'contribute' WHERE id = ?",
    )
      .bind(spaceId)
      .run();
    const archived = await post(owner, spaceId, "Anyone?");
    expect(archived.status).toBe(409);
    expect(archived.body.data.code).toBe("SPACE_ARCHIVED");
    expect((await posts(owner, spaceId)).items).toHaveLength(1);
    expect((await post(owner, spaceId, "")).status).toBe(400);
  });

  it("counts reactions per person and tells each viewer which are theirs", async () => {
    const spaceId = await freshSpace();
    const created = (await post(owner, spaceId, "Shipped the fix!")).body.data
      .post as SpacePost;
    const react = (userId: UserId, reaction: string, method = "PUT") =>
      send(
        userId,
        `/v1/spaces/${spaceId}/posts/${created.id}/reactions/${reaction}`,
        method,
      );
    expect((await react(member, "heart")).status).toBe(200);
    // Reacting twice counts once.
    const again = await react(member, "heart");
    expect(reactions(again.body.data.post).heart).toEqual({
      count: 1,
      mine: true,
      agent: false,
    });
    await react(owner, "heart");
    await react(owner, "joy");
    const seen = (await posts(member, spaceId)).items[0];
    expect(reactions(seen)).toMatchObject({
      heart: { count: 2, mine: true, agent: false },
      joy: { count: 1, mine: false, agent: false },
    });
    expect((await react(member, "fire")).status).toBe(400);

    const removed = await react(member, "heart", "DELETE");
    expect(removed.status).toBe(200);
    expect(reactions(removed.body.data.post).heart).toEqual({
      count: 1,
      mine: false,
      agent: false,
    });
    await react(owner, "heart", "DELETE");
    expect(
      reactions((await posts(owner, spaceId)).items[0]).heart,
    ).toBeUndefined();
  });

  it("shows eyes on a person's post until the agent's turn that received it ends", async () => {
    const spaceId = await freshSpace();
    const created = (await post(member, spaceId, "Can you look at CI?")).body
      .data.post as SpacePost;
    expect(reactions(created).eyes).toEqual({
      count: 1,
      mine: false,
      agent: true,
    });
    const submissionId = `sub_${flue.agent.length}`;

    // Another submission ending while the agent still works leaves it.
    await env.DB.prepare(
      "UPDATE threads SET activity_status = 'working' WHERE id = ?",
    )
      .bind(spaceId)
      .run();
    await clearSpaceEyesOnSettle(bindings, {
      type: "submission_settled",
      instanceId: spaceId,
      submissionId: "sub_other",
      outcome: "completed",
    } as never);
    expect(reactions((await posts(owner, spaceId)).items[0]).eyes).toEqual({
      count: 1,
      mine: false,
      agent: true,
    });

    realtime.events.length = 0;
    await clearSpaceEyesOnSettle(bindings, {
      type: "submission_settled",
      instanceId: spaceId,
      submissionId,
      outcome: "completed",
    } as never);
    expect(
      reactions((await posts(owner, spaceId)).items[0]).eyes,
    ).toBeUndefined();
    expect(postsChanged(spaceId)).toBe(1);

    // An edit reaches the agent again, so eyes shows again; a failed turn
    // still ends it, and so does the Space going idle.
    const edited = await send(
      member,
      `/v1/spaces/${spaceId}/posts/${created.id}`,
      "PATCH",
      { text: "Can you look at CI on main?" },
    );
    expect(reactions(edited.body.data.post).eyes?.agent).toBe(true);
    await env.DB.prepare(
      "UPDATE threads SET activity_status = 'idle' WHERE id = ?",
    )
      .bind(spaceId)
      .run();
    await clearSpaceEyesOnSettle(bindings, {
      type: "submission_settled",
      instanceId: spaceId,
      submissionId: "sub_unrelated",
      outcome: "failed",
    } as never);
    expect(
      reactions((await posts(owner, spaceId)).items[0]).eyes,
    ).toBeUndefined();
  });

  it("tells everyone watching the Space whenever posts change", async () => {
    const spaceId = await freshSpace();
    const created = (await post(owner, spaceId, "One")).body.data
      .post as SpacePost;
    expect(postsChanged(spaceId)).toBeGreaterThanOrEqual(1);
    realtime.events.length = 0;
    await send(owner, `/v1/spaces/${spaceId}/posts/${created.id}`, "PATCH", {
      text: "One, edited",
    });
    expect(postsChanged(spaceId)).toBeGreaterThanOrEqual(1);
    realtime.events.length = 0;
    await send(
      member,
      `/v1/spaces/${spaceId}/posts/${created.id}/reactions/thumbs_up`,
      "PUT",
    );
    expect(postsChanged(spaceId)).toBe(1);
    realtime.events.length = 0;
    // Reading never publishes.
    await posts(member, spaceId);
    expect(postsChanged(spaceId)).toBe(0);
  });
});

describe("Messages the Space's agent receives", () => {
  const startChild = async (spaceId: ThreadId) => {
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
      data: { prompt: "Fix the coupon rounding.", title: "Coupon rounding" },
      toolCallId: "call_child",
    } as never)) as { output: { threadId: string } };
    return started.output.threadId as ThreadId;
  };

  it("delivers a child's result as a worker report, never as a post", async () => {
    const spaceId = await freshSpace();
    const childId = await startChild(spaceId);
    flue.agent.length = 0;

    // The child reports itself with send_thread_message.
    const sent = await ownerRequest(
      { bindings, ownerUserId: owner, sourceThreadId: childId },
      "POST",
      `/v1/agents/dx/${spaceId}`,
      { kind: "user", body: "Rounding fixed; PR #12 is open." },
    );
    expect(sent.response.status).toBe(202);
    const report = parseMessageAuthor(flue.agent[0]?.body ?? "");
    expect(report.sourceThreadId).toBe(childId);
    expect(report.text).toBe(
      spaceWorkerReport({
        title: "Coupon rounding",
        url: `https://dx.example.com/threads/${childId}`,
        text: "Rounding fixed; PR #12 is open.",
      }),
    );
    expect(report.text.startsWith("Worker report from Coupon rounding (")).toBe(
      true,
    );

    // A turn that ended without reporting is reported by dx the same way.
    await reportTurnToSpace(bindings, {
      spaceThreadId: spaceId,
      threadId: childId,
      ownerUserId: owner,
      page: { messages: [] } as never,
      submissionId: "sub_child_turn",
      reply: "Done: totals now round to whole cents.",
    });
    expect(parseMessageAuthor(flue.agent[1]?.body ?? "").text).toBe(
      `Worker report from Coupon rounding (https://dx.example.com/threads/${childId})\n\nDone: totals now round to whole cents.`,
    );
    expect((await posts(owner, spaceId)).items).toEqual([]);
  });

  it("sends an @dx comment on a post with the post and every comment so far", async () => {
    const spaceId = await freshSpace();
    const created = (await post(owner, spaceId, "Start two threads.")).body.data
      .post as SpacePost;
    const comment = (userId: UserId, body: string) =>
      send(
        userId,
        `/v1/threads/${spaceId}/message-comments/${created.id}`,
        "POST",
        // The post's own text, author, and time win over what a client says.
        { body, message: { excerpt: "Something else", sentAt: 1 } },
      );
    flue.agent.length = 0;
    expect((await comment(member, "Is this urgent?")).status).toBe(201);
    expect(flue.agent).toEqual([]);
    const asked = await comment(
      member,
      "@[dx](agent) which one finished first? cc @[Ada Owner](user:post-owner)",
    );
    expect(asked.status).toBe(201);
    expect(asked.body.data.comment.messageId).toBe(created.id);
    expect(flue.agent).toHaveLength(1);
    const tag = parseMessageAuthor(flue.agent[0]?.body ?? "");
    expect(tag.author).toMatchObject({ userId: member, role: "contributor" });
    expect(tag.commentOn).toBe(created.id);
    expect(tag.text).toBe(
      [
        "@dx which one finished first? cc Ada Owner",
        "",
        `<comments message_thread="${created.id}">`,
        `<post id="${created.id}" author="Ada Owner">`,
        "Start two threads.",
        "</post>",
        '<comment author="Ben Member">',
        "Is this urgent?",
        "</comment>",
        '<comment author="Ben Member">',
        "@dx which one finished first? cc @Ada Owner",
        "</comment>",
        "</comments>",
      ].join("\n"),
    );
    // A comment is not a post, and the post counts it.
    const [listed] = (await posts(owner, spaceId)).items;
    expect(listed?.comments).toMatchObject({ count: 2 });
    expect(listed?.comments.commenters.map(({ userId }) => userId)).toEqual([
      member,
    ]);
    const summary = await send(
      owner,
      `/v1/threads/${spaceId}/message-comments`,
    );
    expect(summary.body.data.items[0].message).toMatchObject({
      messageId: created.id,
      excerpt: "Start two threads.",
      author: { userId: owner },
    });
    // A post ID that names no post of this Space takes no comment.
    expect(
      (
        await send(
          owner,
          `/v1/threads/${spaceId}/message-comments/pst_00000000000000000000000000`,
          "POST",
          { body: "Hi", message: { excerpt: "x" } },
        )
      ).status,
    ).toBe(404);
  });
});

describe("Mentions in people's posts", () => {
  const mentionsOf = async (postId: string) =>
    (
      await env.DB.prepare(
        `SELECT recipient_user_id, actor_user_id, message_id, excerpt, thread_id
           FROM notification WHERE source_key = ?
          ORDER BY recipient_user_id`,
      )
        .bind(`space-post-mention:${postId}`)
        .all<Record<string, unknown>>()
    ).results;

  const allMentionsIn = async (spaceId: string) =>
    (
      await env.DB.prepare(
        "SELECT recipient_user_id, source_key, excerpt FROM notification WHERE thread_id = ? AND topic = 'mention'",
      )
        .bind(spaceId)
        .all<Record<string, unknown>>()
    ).results;

  it("notifies each member a picked mention names, once, as the author, at the post", async () => {
    const spaceId = await freshSpace();
    // Cy is outside the workspace; Ada wrote it.
    const created = (
      await post(
        owner,
        spaceId,
        `Can @[Ben Member](user:${member}) review the rounding? cc @[Cy Outsider](user:${outsider}) @[Ada Owner](user:${owner})`,
      )
    ).body.data.post as SpacePost;
    expect(await mentionsOf(created.id)).toEqual([
      {
        recipient_user_id: member,
        actor_user_id: owner,
        message_id: created.id,
        // Picked mentions stay tokens, which the inbox shows as chips.
        excerpt: `Can @[Ben Member](user:${member}) review the rounding? cc @[Cy Outsider](user:${outsider}) @[Ada Owner](user:${owner})`,
        thread_id: spaceId,
      },
    ]);
    // Nothing else notified through the message path.
    expect(await allMentionsIn(spaceId)).toHaveLength(1);

    // An edit notifies only people it newly mentions.
    await send(owner, `/v1/spaces/${spaceId}/posts/${created.id}`, "PATCH", {
      text: `Can @[Ben Member](user:${member}) and @[Vi Viewer](user:${viewer}) review it?`,
    });
    const after = await mentionsOf(created.id);
    expect(after.map(({ recipient_user_id }) => recipient_user_id)).toEqual(
      [member, viewer].sort(),
    );
    expect(
      after.find(({ recipient_user_id }) => recipient_user_id === viewer),
    ).toMatchObject({
      actor_user_id: owner,
      message_id: created.id,
      excerpt: `Can @[Ben Member](user:${member}) and @[Vi Viewer](user:${viewer}) review it?`,
    });

    // Someone who turned Spaces off cannot open the Space: no notification.
    await turnSpacesOn([viewer], false);
    const unseen = (
      await post(owner, spaceId, `@[Vi Viewer](user:${viewer}) one more`)
    ).body.data.post as SpacePost;
    expect(await mentionsOf(unseen.id)).toEqual([]);
  });

  it("routes a typed @handle through the same path, with no internal tags", async () => {
    const spaceId = await freshSpace();
    const created = (await post(owner, spaceId, "@benm please check CI")).body
      .data.post as SpacePost;
    expect(await mentionsOf(created.id)).toEqual([
      {
        recipient_user_id: member,
        actor_user_id: owner,
        message_id: created.id,
        excerpt: "@benm please check CI",
        thread_id: spaceId,
      },
    ]);
    const all = await allMentionsIn(spaceId);
    expect(all).toHaveLength(1);
    expect(String(all[0]?.excerpt)).not.toContain("<post");

    // A message sent straight to the agent, as an older client does, too.
    await ownerRequest(
      { bindings, ownerUserId: owner },
      "POST",
      `/v1/agents/dx/${spaceId}`,
      { kind: "user", body: "@benm and the tax line", idempotencyKey: "k-m" },
    );
    const direct = (await posts(owner, spaceId)).items.at(-1);
    expect(await mentionsOf(direct?.id ?? "")).toMatchObject([
      {
        recipient_user_id: member,
        message_id: direct?.id,
        excerpt: "@benm and the tax line",
      },
    ]);
    expect(await allMentionsIn(spaceId)).toHaveLength(2);
  });

  it("cuts a long excerpt on its plain text, never inside a link or a token", async () => {
    const spaceId = await freshSpace();
    const filler = "word ".repeat(50).trim(); // 254 characters
    // A link across the cut becomes its label; nothing of its URL is left.
    const linked = (
      await post(
        owner,
        spaceId,
        `@benm **${filler}** see [the rounding thread](https://dx.example.com/threads/thr_x) for more context please`,
      )
    ).body.data.post as SpacePost;
    const [{ excerpt: cutLink } = {}] = await mentionsOf(linked.id);
    const linkText = String(cutLink);
    expect(linkText.length).toBeLessThanOrEqual(280);
    expect(linkText.endsWith("…")).toBe(true);
    expect(linkText).not.toMatch(/\]\(|https?:|\*\*|\[/);
    expect(linkText.startsWith(`@benm ${filler} see the rounding`)).toBe(true);

    // A token across the cut is left out whole.
    const tokened = (
      await post(
        owner,
        spaceId,
        `@benm ${filler} ok @[Vi Viewer](user:${viewer}) and more`,
      )
    ).body.data.post as SpacePost;
    const [{ excerpt: cutToken } = {}] = await mentionsOf(tokened.id);
    expect(String(cutToken)).toBe(`@benm ${filler} ok…`);
    // A token inside the limit stays whole.
    const short = (
      await post(
        owner,
        spaceId,
        `@[Vi Viewer](user:${viewer}) **look** [here](https://x.example)`,
      )
    ).body.data.post as SpacePost;
    const [{ excerpt: whole } = {}] = await mentionsOf(short.id);
    expect(whole).toBe(`@[Vi Viewer](user:${viewer}) look here`);
  });

  it("never takes a member whose name starts with dx for an @dx mention", async () => {
    const spaceId = await freshSpace();
    await env.DB.prepare('UPDATE "user" SET name = ? WHERE id = ?')
      .bind("dx second reviewer", member)
      .run();
    const created = (await post(owner, spaceId, "Start the rounding fix.")).body
      .data.post as SpacePost;
    flue.agent.length = 0;
    // A comment that picks them is a person's comment, not one for dx.
    const commented = await send(
      owner,
      `/v1/threads/${spaceId}/message-comments/${created.id}`,
      "POST",
      {
        body: `@[dx second reviewer](user:${member}) can you look?`,
        message: { excerpt: "x" },
      },
    );
    expect(commented.status).toBe(201);
    expect(commented.body.data.comment.asksAgent).toBe(false);
    expect(flue.agent).toEqual([]);
    // In a post, picking them notifies them.
    const picked = (
      await post(
        owner,
        spaceId,
        `@[dx second reviewer](user:${member}) please review`,
      )
    ).body.data.post as SpacePost;
    expect(await mentionsOf(picked.id)).toMatchObject([
      {
        recipient_user_id: member,
        // A token, so the inbox can never take it for a mention of dx.
        excerpt: `@[dx second reviewer](user:${member}) please review`,
      },
    ]);
  });
});
