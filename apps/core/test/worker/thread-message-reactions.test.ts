import { env } from "cloudflare:test";
import {
  Principal,
  type ProjectId,
  ProjectRepository,
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
import { tombstoneThreads } from "../../src/thread-deletion/tombstone.js";
import { messageReactionRoutes } from "../../src/thread-sharing/message-reactions.js";
import { threadSharingRoutes } from "../../src/thread-sharing/routes.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Reactions on a shared Thread's messages, end to end in workerd with real
 * D1 behind the app's real Thread authorization and sharing routes.
 *
 * Ways it could go wrong: a private Thread shows or takes reactions; an
 * outsider reads or gives one; a View member cannot react, or a member's
 * reaction is filed under the owner they act as; a reaction counts twice or
 * `mine` marks someone else's; taking one back removes another person's; a
 * malformed message id or reaction is stored; an archived Thread takes one;
 * nobody watching hears a change, or everyone hears a no-op; unsharing
 * loses the reactions instead of hiding them; deleting the Thread or an
 * account leaves them behind.
 */

const owner = "react-owner" as UserId;
const member = "react-member" as UserId;
const viewer = "react-viewer" as UserId;
const outsider = "react-outsider" as UserId;
const workspaceId = "react-workspace";
const otherWorkspaceId = "react-other-workspace";
const ownerProject = project(
  "prj_00000000-0000-4000-8000-000000000e01",
  owner,
  "reactions",
);
const sharedThread = thread(
  "thr_00000000-0000-4000-8000-000000000e01",
  ownerProject.id as ProjectId,
  owner,
);
const threadId = sharedThread.id;
const replyId = "entry_01JREPLY000000000000000000";
const promptId = "entry_01JPROMPT00000000000000000";

const realtime: Array<{ type: string; threadId: string }> = [];
const bindings: Bindings = {
  DB: env.DB,
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  REALTIME_HUB: {
    getByName: () => ({
      fetch: async (_url: string, init: RequestInit) => {
        realtime.push(JSON.parse(String(init.body)));
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
  // As app.ts mounts them.
  app.route("/v1/threads", threadSharingRoutes);
  app.use("/v1/threads/:threadId/message-reactions/*", authorizeThread);
  app.route("/v1/threads", messageReactionRoutes);
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

const share = (workspaceAccess: "none" | "view" | "contribute") =>
  send(owner, `/v1/threads/${threadId}/sharing`, "PUT", { workspaceAccess });

const react = (
  userId: UserId,
  messageId: string,
  reaction: string,
  on = true,
) =>
  send(
    userId,
    `/v1/threads/${threadId}/message-reactions/${messageId}/${reaction}`,
    on ? "PUT" : "DELETE",
  );

const list = (userId: UserId) =>
  send(userId, `/v1/threads/${threadId}/message-reactions`);

/** One message's reactions as `{ reaction: [count, mine] }`. */
const counts = (
  items: ReadonlyArray<{
    messageId: string;
    reactions: ReadonlyArray<{
      reaction: string;
      count: number;
      mine: boolean;
    }>;
  }>,
  messageId: string,
) =>
  Object.fromEntries(
    (items.find((item) => item.messageId === messageId)?.reactions ?? []).map(
      ({ reaction, count, mine }) => [reaction, [count, mine]],
    ),
  );

const changes = () =>
  realtime.filter(
    (event) =>
      event.type === "reactions.invalidated" && event.threadId === threadId,
  ).length;

const user = (id: string, name: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`);

beforeEach(async () => {
  realtime.length = 0;
  await env.DB.batch([
    user(owner, "Ada Owner"),
    user(member, "Ben Member"),
    user(viewer, "Vi Viewer"),
    user(outsider, "Cy Outsider"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1), (?, ?, ?, 1)",
    ).bind(
      workspaceId,
      "React Team",
      "react-team",
      otherWorkspaceId,
      "Other",
      "react-other",
    ),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('r-owner', ?1, ?2, 'owner', 1),
         ('r-member', ?1, ?3, 'member', 2),
         ('r-viewer', ?1, ?4, 'member', 3),
         ('r-outsider', ?5, ?6, 'owner', 4)`,
    ).bind(workspaceId, owner, member, viewer, otherWorkspaceId, outsider),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(ownerProject);
      yield* (yield* ThreadRepository).insert(sharedThread);
    }),
  );
});

describe("Reactions on a Thread's messages", () => {
  it("are not offered while the Thread is private", async () => {
    const read = await list(owner);
    expect(read.status).toBe(200);
    expect(read.body.data).toEqual({ shared: false, items: [] });
    const given = await react(owner, replyId, "thumbs_up");
    expect(given.status).toBe(409);
    expect(given.body.data.code).toBe("THREAD_NOT_SHARED");
    expect(changes()).toBe(0);
    // Nobody else can even find the Thread.
    expect((await list(member)).status).toBe(404);
  });

  it("are counted per person across the owner and its members, View members included", async () => {
    expect((await share("view")).status).toBe(200);

    expect((await react(owner, replyId, "thumbs_up")).status).toBe(200);
    const byViewer = await react(viewer, replyId, "thumbs_up");
    expect(byViewer.status).toBe(200);
    // The response is the message's reactions, from the reactor's side.
    expect(byViewer.body.data).toEqual({
      messageId: replyId,
      reactions: [
        { reaction: "thumbs_up", count: 2, mine: true, agent: false },
      ],
    });
    // Giving one twice counts once and tells nobody.
    const before = changes();
    expect((await react(viewer, replyId, "thumbs_up")).status).toBe(200);
    expect(changes()).toBe(before);
    expect((await react(viewer, promptId, "heart")).status).toBe(200);

    const ownerView = (await list(owner)).body.data;
    expect(ownerView.shared).toBe(true);
    expect(counts(ownerView.items, replyId)).toEqual({
      thumbs_up: [2, true],
    });
    expect(counts(ownerView.items, promptId)).toEqual({ heart: [1, false] });
    // The viewer's reactions are the viewer's, not the owner's they read as.
    expect(counts((await list(viewer)).body.data.items, promptId)).toEqual({
      heart: [1, true],
    });

    // Taking one back removes only your own.
    expect((await react(owner, replyId, "thumbs_up", false)).status).toBe(200);
    expect(counts((await list(viewer)).body.data.items, replyId)).toEqual({
      thumbs_up: [1, true],
    });
    expect(changes()).toBe(4);
  });

  it("let Contribute members react, and refuse outsiders and bad input", async () => {
    await share("contribute");
    expect((await react(member, replyId, "joy")).status).toBe(200);
    expect((await react(outsider, replyId, "joy")).status).toBe(404);
    expect((await list(outsider)).status).toBe(404);
    expect((await react(member, replyId, "fire")).status).toBe(400);
    expect((await react(member, "not-a-message", "joy")).status).toBe(400);
    expect(counts((await list(owner)).body.data.items, replyId)).toEqual({
      joy: [1, false],
    });
  });

  it("hide while the Thread is private again and come back when it is shared", async () => {
    await share("view");
    await react(viewer, replyId, "wave");
    expect((await share("none")).status).toBe(200);
    expect((await list(owner)).body.data).toEqual({ shared: false, items: [] });
    expect((await react(owner, replyId, "wave")).status).toBe(409);
    expect((await list(viewer)).status).toBe(404);

    await share("view");
    expect(counts((await list(owner)).body.data.items, replyId)).toEqual({
      wave: [1, false],
    });
  });

  it("are not taken on an archived Thread", async () => {
    await share("view");
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(threadId)
      .run();
    const given = await react(owner, replyId, "heart");
    expect(given.status).toBe(409);
    expect(given.body.data.code).toBe("THREAD_ARCHIVED");
  });

  it("go with the Thread when it is deleted, and with an account", async () => {
    await share("view");
    await react(viewer, replyId, "heart");
    await react(owner, replyId, "eyes");
    await env.DB.prepare('DELETE FROM "user" WHERE id = ?').bind(viewer).run();
    const remaining = () =>
      env.DB.prepare("SELECT user_id FROM thread_reaction WHERE thread_id = ?")
        .bind(threadId)
        .all<{ user_id: string }>();
    expect((await remaining()).results).toEqual([{ user_id: owner }]);
    await tombstoneThreads(env.DB, [threadId], owner, new Date().toISOString());
    expect((await remaining()).results).toEqual([]);
  });
});
