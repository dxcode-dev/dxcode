import { env } from "cloudflare:test";
import {
  commentLinkId,
  type MessageComment,
  type MessageCommentSummary,
  parseCommentLinkId,
  parseMessageAuthor,
  type SpaceData,
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
import { messageCommentRoutes } from "../../src/spaces/message-comments/routes.js";
import { spaceRoutes } from "../../src/spaces/routes.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { tombstoneThreads } from "../../src/thread-deletion/tombstone.js";
import { project } from "./fixtures.js";
import { runRepositories } from "./runtime.js";
import { seedSpaceUsers } from "./space-users.js";

/**
 * Comments on a Space's messages end to end in workerd with real D1, through
 * the same Thread authorization and message admission as the app.
 *
 * Ways it could go wrong: a comment reaches the agent without @dx, or one
 * with @dx never does, or reaches it as the owner instead of the commenter;
 * a View member comments, or an outsider reads; the summary miscounts, names
 * the wrong last comment, or orders messages by comment time; a mentioned
 * person who cannot open the Space is notified, or the writer is; a comment
 * on an ordinary Thread is accepted; a client names someone outside the
 * Space as a message's author; deleting the Space or an account leaves
 * comments or names behind.
 */

const flue = vi.hoisted(() => ({
  agent: [] as Array<{ readonly threadId: string; readonly body: string }>,
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

// DxAgent's routes behind the app's real Thread authorization and message
// attribution; Flue itself only records what it was given.
vi.mock("../../src/agents/routes.js", async () => {
  const { Hono: Router } = await import("hono");
  const { authorizeThread: authorize } = await import(
    "../../src/auth/authorize-thread.js"
  );
  const { attributeSubmission } = await import(
    "../../src/thread-sharing/middleware.js"
  );
  const routes = new Router<AppEnv>();
  routes.use("/:threadId", authorize);
  routes.use("/:threadId", attributeSubmission);
  routes.post("/:threadId", async (context) => {
    const delivered = (await context.req.json()) as { body: string };
    flue.agent.push({
      threadId: context.req.param("threadId"),
      body: delivered.body,
    });
    return context.json({ submissionId: `sub_${flue.agent.length}` }, 202);
  });
  return {
    dxAgentRoutes: routes,
    stopThreadAgent: async () => undefined,
  };
});

const owner = "comment-owner" as UserId;
const member = "comment-member" as UserId;
const viewer = "comment-viewer" as UserId;
const outsider = "comment-outsider" as UserId;
const workspaceId = "comment-workspace";
const otherWorkspaceId = "comment-other-workspace";
const fixtureProject = project(
  "prj_00000000-0000-4000-8000-00000000c152",
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
  // A new Space's hidden setup message is not a comment.
  flue.agent.length = 0;
  return (created.body.data.space as SpaceData).threadId as ThreadId;
};

const comment = (
  userId: UserId,
  spaceId: string,
  messageId: string,
  body: string,
  message: Record<string, unknown> = {},
) =>
  send(userId, `/v1/threads/${spaceId}/message-comments/${messageId}`, "POST", {
    body,
    message: { excerpt: "Coupon totals are off by a cent.", ...message },
  });

const summaries = async (userId: UserId, spaceId: string) =>
  (await send(userId, `/v1/threads/${spaceId}/message-comments`)).body.data
    .items as MessageCommentSummary[];

const notified = (recipient: string, commentId: string) =>
  env.DB.prepare(
    "SELECT count(*) AS n FROM notification WHERE recipient_user_id = ? AND source_key = ?",
  )
    .bind(recipient, `message-comment-mention:${commentId}`)
    .first<number>("n");

const user = (id: string, name: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`);

beforeEach(async () => {
  flue.agent.length = 0;
  await env.DB.batch([
    user(owner, "Ada Owner"),
    user(member, "Ben Member"),
    user(viewer, "Vi Viewer"),
    user(outsider, "Cy Outsider"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1), (?, ?, ?, 1)",
    ).bind(
      workspaceId,
      "Comment Team",
      "comment-team",
      otherWorkspaceId,
      "Other",
      "comment-other",
    ),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('cm-owner', ?1, ?2, 'owner', 1),
         ('cm-member', ?1, ?3, 'member', 2),
         ('cm-viewer', ?1, ?4, 'member', 3),
         ('cm-outsider', ?5, ?6, 'owner', 4)`,
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

beforeEach(() => seedSpaceUsers([owner, member, viewer, outsider]));

describe("Comments on a Space's messages", () => {
  it("lists comments per message and summarizes each commented message in message order", async () => {
    const spaceId = await createSpace("workspace");
    expect(await summaries(owner, spaceId)).toEqual([]);
    const empty = await send(
      member,
      `/v1/threads/${spaceId}/message-comments/msg-later`,
    );
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual({ message: null, comments: [] });

    // A later message is commented on first; the list still follows the chat.
    const first = await comment(
      member,
      spaceId,
      "msg-later",
      "Is this SAVE10?",
      {
        excerpt: "Started a thread on the rounding.",
        sentAt: 2_000,
      },
    );
    expect(first.status).toBe(201);
    expect(first.body.data.comment).toMatchObject({
      messageId: "msg-later",
      author: { userId: member, name: "Ben Member", handle: "benm" },
      body: "Is this SAVE10?",
      asksAgent: false,
    });
    await comment(
      owner,
      spaceId,
      "msg-earlier",
      "Yep, a cent off once tax is added.",
      {
        excerpt: "Coupon totals are off by a cent. Can we get a fix going too?",
        authorUserId: member,
        sentAt: 1_000,
      },
    );
    await comment(
      member,
      spaceId,
      "msg-earlier",
      "I'll check the receipt email.\nOnce the fix lands.",
      {
        // Later comments keep the message as the first comment recorded it.
        excerpt: "something else",
        sentAt: 9_000,
      },
    );

    const items = await summaries(member, spaceId);
    expect(items.map(({ message }) => message.messageId)).toEqual([
      "msg-earlier",
      "msg-later",
    ]);
    expect(items[0]).toMatchObject({
      message: {
        messageId: "msg-earlier",
        excerpt: "Coupon totals are off by a cent. Can we get a fix going too?",
        author: { userId: member, name: "Ben Member" },
        sentAt: 1_000,
      },
      count: 2,
      lastComment: {
        author: { userId: member },
        excerpt: "I'll check the receipt email.",
      },
    });
    expect(items[0]?.commenters.map(({ userId }) => userId)).toEqual([
      member,
      owner,
    ]);
    expect(items[1]).toMatchObject({
      count: 1,
      message: { excerpt: "Started a thread on the rounding.", author: null },
    });

    const thread = await send(
      owner,
      `/v1/threads/${spaceId}/message-comments/msg-earlier`,
    );
    expect(
      (thread.body.data.comments as MessageComment[]).map(({ body }) => body),
    ).toEqual([
      "Yep, a cent off once tax is added.",
      "I'll check the receipt email.\nOnce the fix lands.",
    ]);
    expect(thread.body.data.message.excerpt).toBe(
      "Coupon totals are off by a cent. Can we get a fix going too?",
    );
  });

  it("lets viewers read, contributors comment, and keeps outsiders and ordinary Threads out", async () => {
    const spaceId = await createSpace("workspace");
    await comment(owner, spaceId, "msg-1", "First");

    // A View member reads but may not write.
    await env.DB.prepare(
      "UPDATE threads SET workspace_access = 'view' WHERE id = ?",
    )
      .bind(spaceId)
      .run();
    expect(
      (await send(viewer, `/v1/threads/${spaceId}/message-comments`)).status,
    ).toBe(200);
    const refused = await comment(viewer, spaceId, "msg-1", "Mine");
    expect(refused.status).toBe(403);
    expect(refused.body.data.code).toBe("THREAD_READ_ONLY");
    await env.DB.prepare(
      "UPDATE threads SET workspace_access = 'contribute' WHERE id = ?",
    )
      .bind(spaceId)
      .run();
    expect((await comment(viewer, spaceId, "msg-1", "Now I can")).status).toBe(
      201,
    );

    // Someone outside the workspace never reaches it.
    expect(
      (await send(outsider, `/v1/threads/${spaceId}/message-comments`)).status,
    ).toBe(404);
    expect((await comment(outsider, spaceId, "msg-1", "Hi")).status).toBe(404);

    // A private Space is its owner's alone.
    const privateId = await createSpace("private");
    expect(
      (await send(member, `/v1/threads/${privateId}/message-comments`)).status,
    ).toBe(404);
    expect(
      (await comment(owner, privateId, "msg-1", "Note to self")).status,
    ).toBe(201);

    // An ordinary Thread's messages take no comments.
    await env.DB.prepare("UPDATE threads SET kind = 'thread' WHERE id = ?")
      .bind(privateId)
      .run();
    const ordinary = await comment(owner, privateId, "msg-1", "Hi");
    expect(ordinary.status).toBe(404);
    expect(ordinary.body.data.code).toBe("NOT_A_SPACE");

    // Bad input is refused; a message author outside the Space is dropped.
    expect((await comment(owner, spaceId, "bad id!", "Hi")).status).toBe(400);
    expect((await comment(owner, spaceId, "msg-2", "   ")).status).toBe(400);
    await comment(owner, spaceId, "msg-3", "Who wrote this?", {
      authorUserId: outsider,
    });
    const named = (await summaries(owner, spaceId)).find(
      ({ message }) => message.messageId === "msg-3",
    );
    expect(named?.message.author).toBeNull();
  });

  it("sends a comment that mentions dx to the agent as the commenter, and never a plain one", async () => {
    const spaceId = await createSpace("workspace");
    const plain = await comment(
      member,
      spaceId,
      "msg-1",
      "Is this the SAVE10 code from the newsletter?",
      { excerpt: "Start two small threads in parallel.", authorUserId: owner },
    );
    expect(plain.status).toBe(201);
    expect(flue.agent).toEqual([]);

    const asked = await comment(
      member,
      spaceId,
      "msg-1",
      "@[dx](agent) which of the two threads finished first? cc @[Ada Owner](user:comment-owner)",
      { excerpt: "Start two small threads in parallel.", authorUserId: owner },
    );
    expect(asked.status).toBe(201);
    expect(asked.body.data.comment.asksAgent).toBe(true);
    expect(flue.agent).toHaveLength(1);
    const [delivery] = flue.agent;
    expect(delivery?.threadId).toBe(spaceId);
    const tag = parseMessageAuthor(delivery?.body ?? "");
    // Attributed to Ben, a contributor, through the same admission as chat.
    expect(tag.author).toMatchObject({
      userId: member,
      role: "contributor",
      name: "Ben Member",
      handle: "benm",
    });
    expect(tag.commentOn).toBe("msg-1");
    expect(tag.chat).toBeUndefined();
    // The comment, then the message and every comment on it so far.
    expect(tag.text).toBe(
      [
        "@dx which of the two threads finished first? cc Ada Owner",
        "",
        '<comments message_thread="msg-1">',
        '<post id="msg-1" author="Ada Owner">',
        "Start two small threads in parallel.",
        "</post>",
        '<comment author="Ben Member">',
        "Is this the SAVE10 code from the newsletter?",
        "</comment>",
        '<comment author="Ben Member">',
        "@dx which of the two threads finished first? cc @Ada Owner",
        "</comment>",
        "</comments>",
      ].join("\n"),
    );

    // The owner's own comment reaches the agent as the owner.
    await comment(owner, spaceId, "msg-1", "@[dx](agent) status?");
    expect(parseMessageAuthor(flue.agent[1]?.body ?? "").author).toMatchObject({
      userId: owner,
      role: "owner",
    });
  });

  it("notifies the people a comment mentions who can open the Space", async () => {
    const spaceId = await createSpace("workspace");
    const mentioned = await comment(
      member,
      spaceId,
      "msg-1",
      "@[Ada Owner](user:comment-owner) @[Cy Outsider](user:comment-outsider) @[Ben Member](user:comment-member) can you check?",
    );
    const id = mentioned.body.data.comment.id as string;
    expect(await notified(owner, id)).toBe(1);
    // Cy cannot open the Space; Ben wrote it.
    expect(await notified(outsider, id)).toBe(0);
    expect(await notified(member, id)).toBe(0);

    const everyone = await comment(
      owner,
      spaceId,
      "msg-1",
      "@[here](here) heads up",
    );
    const hereId = everyone.body.data.comment.id as string;
    expect(await notified(member, hereId)).toBe(1);
    expect(await notified(viewer, hereId)).toBe(1);
    expect(await notified(owner, hereId)).toBe(0);
    expect(await notified(outsider, hereId)).toBe(0);
    // A comment that mentions no one notifies no one.
    const quiet = await comment(owner, spaceId, "msg-1", "noted");
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM notification WHERE source_key = ?",
      )
        .bind(`message-comment-mention:${quiet.body.data.comment.id}`)
        .first<number>("n"),
    ).toBe(0);
  });

  it("links a comment's mention to the comment, on its post, for the Comments panel", async () => {
    const spaceId = await createSpace("workspace");
    const postId = `pst_${"7".repeat(26)}`;
    await env.DB.prepare(
      `INSERT INTO space_post (id, space_thread_id, author_kind, author_user_id, text, request_key, created_at)
       VALUES (?, ?, 'user', ?, 'Coupon totals are off by a cent.', ?, ?)`,
    )
      .bind(postId, spaceId, owner, `test:${postId}`, Date.now())
      .run();
    const mentioned = await comment(
      member,
      spaceId,
      postId,
      "@[Ada Owner](user:comment-owner) can you check the totals?",
    );
    const id = mentioned.body.data.comment.id as string;
    const row = await env.DB.prepare(
      "SELECT message_id FROM notification WHERE recipient_user_id = ? AND source_key = ?",
    )
      .bind(owner, `message-comment-mention:${id}`)
      .first<{ message_id: string | null }>();
    // `?message=` opens the post's comments at this comment; it fits the
    // notification's 64 characters.
    expect(row?.message_id).toBe(commentLinkId(postId, id));
    expect(parseCommentLinkId(row?.message_id ?? "")).toEqual({
      postId,
      commentId: id,
    });
    expect(row?.message_id?.length).toBeLessThanOrEqual(64);
  });

  it("removes a deleted Space's comments and forgets a deleted account's name", async () => {
    const spaceId = await createSpace("workspace");
    await comment(member, spaceId, "msg-1", "From Ben", {
      authorUserId: member,
    });
    await comment(owner, spaceId, "msg-1", "From Ada");

    await env.DB.prepare('DELETE FROM "user" WHERE id = ?').bind(member).run();
    const [item] = await summaries(owner, spaceId);
    expect(item?.message.author).toBeNull();
    expect(item?.commenters.map(({ userId }) => userId)).toEqual([owner]);
    const listed = await send(
      owner,
      `/v1/threads/${spaceId}/message-comments/msg-1`,
    );
    expect(
      (listed.body.data.comments as MessageComment[]).map(
        ({ author }) => author?.userId ?? null,
      ),
    ).toEqual([null, owner]);

    expect(
      await tombstoneThreads(
        env.DB,
        [spaceId],
        owner,
        new Date().toISOString(),
      ),
    ).toEqual([spaceId]);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM space_comment WHERE thread_id = ?",
      )
        .bind(spaceId)
        .first<number>("n"),
    ).toBe(0);
  });
});
