import { env } from "cloudflare:test";
import { parseMessageAuthor, type SpaceData, type SpacePost } from "@dx/api";
import {
  Principal,
  ProjectRepository,
  shipWorkflowOf,
  type ThreadId,
  type UserId,
} from "@dx/domain";
import type { ToolDefinition } from "@flue/runtime";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { listNotifications } from "../../src/notifications/repository.js";
import { createSpaceTools } from "../../src/spaces/agent/tools.js";
import { spaceRoutes } from "../../src/spaces/routes.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { createThreadTools } from "../../src/threads/agent-tools.js";
import { ownerRequest } from "../../src/threads/owner-request.js";
import { project } from "./fixtures.js";
import { runRepositories } from "./runtime.js";
import { turnSpacesOn } from "./spaces-flag.js";

/**
 * The tools only a Space's main thread has, run as the Space's agent runs
 * them, against real D1 and the same routes people use.
 *
 * Ways they could go wrong: a retried `post` posts twice; the agent edits a
 * person's post, or an edit loses the earlier text; `read_posts` hides IDs,
 * authors, edits, or reactions, or pages the wrong way; a reaction lands on
 * another Space's post; `list_space_threads` lists threads outside the
 * Space, misfiles a state, or never pages; `update_space` takes a color dx
 * lacks; `add_thread_to_space` takes someone else's thread or leaves its
 * started threads behind; `set_thread_status` writes a child's card;
 * `archive_threads` archives without a dry run's count, touches the Space
 * itself, or another person's thread; identity and members name the wrong
 * people; the docs search finds nothing for a plain question; a child
 * started for a post forgets the post or its author.
 */

const flue = vi.hoisted(() => ({
  agent: [] as Array<{ readonly threadId: string; readonly body: string }>,
}));

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

const owner = "tools-owner" as UserId;
const member = "tools-member" as UserId;
const outsider = "tools-outsider" as UserId;
const workspaceId = "tools-workspace";
const fixtureProject = project(
  "prj_00000000-0000-4000-8000-00000000e157",
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

const createSpace = async () => {
  const created = await send(owner, "/v1/spaces", "POST", {
    projectId: ownerProject.id,
    name: "Checkout v2",
    goal: "Ship the one-page checkout",
    sharing: "workspace",
  });
  expect(created.status).toBe(201);
  flue.agent.length = 0;
  return (created.body.data.space as SpaceData).threadId as ThreadId;
};

const toolsFor = (
  spaceId: string,
  requester?: UserId,
  submissionId = "sub_turn",
) => {
  const tools = createSpaceTools(
    spaceId,
    () => ({ db: env.DB, bindings }),
    submissionId,
    requester,
  );
  return Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<
    string,
    ToolDefinition
  >;
};

const call = async (
  tools: Record<string, ToolDefinition>,
  name: string,
  data: Record<string, unknown>,
  toolCallId = `call_${crypto.randomUUID()}`,
  // biome-ignore lint/suspicious/noExplicitAny: test reads loose output.
): Promise<any> => {
  const tool = tools[name];
  if (tool === undefined) throw new Error(`No ${name} tool.`);
  const result = (await tool.run({ data, toolCallId } as never)) as {
    output?: unknown;
  };
  return result?.output ?? result;
};

const posts = async (userId: UserId, spaceId: string) =>
  (await send(userId, `/v1/spaces/${spaceId}/posts`)).body.data
    .items as SpacePost[];

/** An ordinary Thread of the owner's, through the Thread routes. */
const ordinaryThread = async (
  title: string,
  parentThreadId?: string,
  ownerUserId = owner,
) => {
  const { response, payload } = await ownerRequest(
    { bindings, ownerUserId },
    "POST",
    "/v1/threads",
    {
      projectId: ownerProject.id,
      title,
      generateTitle: false,
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
    },
  );
  expect(response.status).toBeLessThan(300);
  return (payload?.data as { id: string } | undefined)
    ?.id as string as ThreadId;
};

const threadRow = (threadId: string) =>
  env.DB.prepare(
    `SELECT parent_thread_id, lifecycle_state, status_line, title, color,
            requested_by_user_id, request_post_id
       FROM threads WHERE id = ?`,
  )
    .bind(threadId)
    .first<Record<string, unknown>>();

const user = (id: string, name: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`);

beforeEach(async () => {
  flue.agent.length = 0;
  await env.DB.batch([
    user(owner, "Ada Owner"),
    user(member, "Ben Member"),
    user(outsider, "Cy Outsider"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1)",
    ).bind(workspaceId, "Tools Team", "tools-team"),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('tm-owner', ?1, ?2, 'owner', 1),
         ('tm-member', ?1, ?3, 'member', 2)`,
    ).bind(workspaceId, owner, member),
    env.DB.prepare(
      "INSERT INTO workspace_policy (workspace_id, updated_at) VALUES (?1, 1) ON CONFLICT DO NOTHING",
    ).bind(workspaceId),
    env.DB.prepare(
      "UPDATE personal_account SET username = 'benm' WHERE user_id = ?1",
    ).bind(member),
    env.DB.prepare(
      "UPDATE personal_account SET username = 'ada' WHERE user_id = ?1",
    ).bind(owner),
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

describe("The Space agent's post tools", () => {
  it("posts once per tool call, edits only its own posts, and keeps revisions", async () => {
    const spaceId = await createSpace();
    const tools = toolsFor(spaceId);
    const first = await call(tools, "post", { text: "Welcome, Ada." }, "c1");
    expect(first.post_id).toMatch(/^pst_[0-9a-z]{26}$/);
    expect(first.duplicate).toBe(false);
    // A retried call returns the same post.
    const retried = await call(tools, "post", { text: "Welcome, Ada." }, "c1");
    expect(retried).toEqual({ post_id: first.post_id, duplicate: true });
    // The same call ID in another submission is another call.
    const later = await call(
      toolsFor(spaceId, undefined, "sub_next"),
      "post",
      { text: "Second." },
      "c1",
    );
    expect(later.post_id).not.toBe(first.post_id);
    const listed = await posts(member, spaceId);
    expect(
      listed.map(({ author, text }) => [author.kind, author.name, text]),
    ).toEqual([
      ["agent", "dx", "Welcome, Ada."],
      ["agent", "dx", "Second."],
    ]);
    // dx's own posts carry no eyes.
    expect(listed[0]?.reactions).toEqual([]);

    await call(tools, "edit_post", {
      post_id: first.post_id,
      text: "~~Welcome, Ada.~~ Welcome, Ada! [Edit: fixed tone]",
    });
    const revisions = await send(
      owner,
      `/v1/spaces/${spaceId}/posts/${first.post_id}/revisions`,
    );
    expect(
      revisions.body.data.items.map(({ text }: { text: string }) => text),
    ).toEqual([
      "Welcome, Ada.",
      "~~Welcome, Ada.~~ Welcome, Ada! [Edit: fixed tone]",
    ]);

    // A person's post is theirs to edit.
    const personal = await send(member, `/v1/spaces/${spaceId}/posts`, "POST", {
      text: "Hi dx",
    });
    await expect(
      call(tools, "edit_post", {
        post_id: personal.body.data.post.id,
        text: "Hi",
      }),
    ).rejects.toThrow(/only your own posts/i);
    await expect(
      call(tools, "edit_post", {
        post_id: "pst_00000000000000000000000000",
        text: "Hi",
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      call(tools, "post", { text: "x".repeat(20_001) }),
    ).rejects.toThrow();

    // A post that tags a member by handle notifies them, once; a handle
    // nobody in the Space has notifies no one.
    const tagged = await call(
      tools,
      "post",
      { text: "@benm could you review [Coupon rounding](x)? cc @nobody" },
      "c-tag",
    );
    const notified = await env.DB.prepare(
      "SELECT recipient_user_id, message_id FROM notification WHERE source_key = ?",
    )
      .bind(`space-post-mention:${tagged.post_id}`)
      .all<{ recipient_user_id: string; message_id: string }>();
    expect(notified.results).toEqual([
      { recipient_user_id: member, message_id: tagged.post_id },
    ]);
    // The agent's post is an agent notification: pushed, and kept out of
    // the Mentions inbox, which is for people.
    expect(
      await env.DB.prepare(
        "SELECT topic FROM notification WHERE source_key = ?",
      )
        .bind(`space-post-mention:${tagged.post_id}`)
        .first<string>("topic"),
    ).toBe("agent_notification");
    expect(await listNotifications(env.DB, member)).toEqual([]);
  });

  it("posts when the model's tool call ID carries a long encrypted suffix", async () => {
    // OpenAI Responses models send `call_…|<encrypted reasoning>`: a call ID
    // of several hundred characters (seen in production, Nov 2026).
    const spaceId = await createSpace();
    const tools = toolsFor(spaceId);
    const longId = `call_Eb8LTEqIxqSEN6mc5lHMTze0|${"D2hVRS9N8JAZpknSSVcF+/".repeat(16)}=`;
    const first = await call(tools, "post", { text: "Welcome, Ada." }, longId);
    expect(first.duplicate).toBe(false);
    // A retry of that call is still the same post.
    expect(
      await call(tools, "post", { text: "Welcome, Ada." }, longId),
    ).toEqual({ post_id: first.post_id, duplicate: true });
    // Another long ID that shares the first 256 characters is another call.
    const other = await call(
      tools,
      "post",
      { text: "Second." },
      `${longId.slice(0, -1)}A`,
    );
    expect(other.post_id).not.toBe(first.post_id);
    // A member who is not the owner reads both, like the owner does.
    for (const reader of [member, owner])
      expect(
        (await posts(reader, spaceId)).map(({ author, text }) => [
          author.kind,
          text,
        ]),
      ).toEqual([
        ["agent", "Welcome, Ada."],
        ["agent", "Second."],
      ]);
  });

  it("reads posts with IDs, authors, edits, and reactions, newest last", async () => {
    const spaceId = await createSpace();
    const tools = toolsFor(spaceId);
    const welcome = await call(tools, "post", { text: "Welcome." });
    const asked = (
      await send(member, `/v1/spaces/${spaceId}/posts`, "POST", {
        text: "Fix the coupon rounding.",
      })
    ).body.data.post as SpacePost;
    await send(member, `/v1/spaces/${spaceId}/posts/${asked.id}`, "PATCH", {
      text: "Fix the coupon and tax rounding.",
    });
    await call(tools, "react", { post_id: asked.id, reaction: "thumbs_up" });

    const read = await call(tools, "read_posts", {});
    expect(
      read.posts.map(({ post_id }: { post_id: string }) => post_id),
    ).toEqual([welcome.post_id, asked.id]);
    expect(read.posts[1]).toMatchObject({
      post_id: asked.id,
      author: { kind: "user", name: "Ben Member", handle: "benm" },
      text: "Fix the coupon and tax rounding.",
      edited: true,
    });
    expect(read.posts[1].reactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reaction: "thumbs_up", by_you: true }),
      ]),
    );
    expect(typeof read.posts[1].created_at).toBe("string");

    const older = await call(tools, "read_posts", {
      limit: 1,
      before_post_id: asked.id,
    });
    expect(
      older.posts.map(({ post_id }: { post_id: string }) => post_id),
    ).toEqual([welcome.post_id]);

    await call(tools, "unreact", { post_id: asked.id, reaction: "thumbs_up" });
    const after = (await posts(owner, spaceId)).find(
      ({ id }) => id === asked.id,
    );
    expect(
      after?.reactions.find(({ reaction }) => reaction === "thumbs_up"),
    ).toBeUndefined();

    // Another Space's post is out of reach.
    const otherSpace = await createSpace();
    const elsewhere = await call(toolsFor(otherSpace), "post", { text: "Hi" });
    await expect(
      call(tools, "react", { post_id: elsewhere.post_id, reaction: "heart" }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("The Space agent's management tools", () => {
  it("lists the Space's threads by state, with requester, status line, and links", async () => {
    const spaceId = await createSpace();
    const asked = (
      await send(member, `/v1/spaces/${spaceId}/posts`, "POST", {
        text: "Fix rounding and write release notes.",
      })
    ).body.data.post as SpacePost;
    // The turn answers someone else's message; the post names Ben.
    const threadTools = createThreadTools(
      spaceId,
      () => ({ db: env.DB, bindings }),
      "sub_space_turn",
      false,
      owner,
      { space: true },
    );
    const createThread = threadTools.find(
      ({ name }) => name === "create_thread",
    );
    if (createThread === undefined) throw new Error("No create_thread tool.");
    const start = async (title: string, toolCallId: string) =>
      (
        (await createThread.run({
          data: {
            prompt: `"${title}" — Ben`,
            title,
            request_post_id: asked.id,
          },
          toolCallId,
        } as never)) as { output: { threadId: ThreadId } }
      ).output.threadId;
    const working = await start("Coupon rounding", "call_a");
    const idle = await start("Release notes", "call_b");
    const shipped = await start("Tax rounding", "call_c");
    const asking = await start("Refund provider", "call_d");
    expect(await threadRow(working)).toMatchObject({
      parent_thread_id: spaceId,
      requested_by_user_id: member,
      request_post_id: asked.id,
    });
    await expect(
      createThread.run({
        data: {
          prompt: "x",
          title: "x",
          request_post_id: "pst_00000000000000000000000000",
        },
        toolCallId: "call_bad",
      } as never),
    ).rejects.toThrow(/post/i);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE threads SET activity_status = 'working', status_line = 'Running the rounding tests' WHERE id = ?",
      ).bind(working),
      env.DB.prepare(
        "UPDATE threads SET activity_status = 'idle', last_activity_at = '2026-01-01T00:00:00.000Z', updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
      ).bind(idle),
      env.DB.prepare(
        "UPDATE threads SET activity_status = 'idle', shipped_at = 1, ship_reason = 'default_branch' WHERE id = ?",
      ).bind(shipped),
      // It asked a person a question days ago and still waits on them.
      env.DB.prepare(
        "UPDATE threads SET activity_status = 'idle', last_activity_at = '2026-01-01T00:00:00.000Z', updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
      ).bind(asking),
      env.DB.prepare(
        "INSERT INTO thread_attention_request (thread_id, kind, requested_at) VALUES (?, 'question', '2026-01-01T00:00:00.000Z')",
      ).bind(asking),
    ]);

    const tools = toolsFor(spaceId);
    const all = await call(tools, "list_space_threads", {});
    const byTitle = Object.fromEntries(
      all.threads.map((thread: Record<string, unknown>) => [
        thread.title,
        thread,
      ]),
    );
    expect(Object.keys(byTitle).sort()).toEqual([
      "Coupon rounding",
      "Refund provider",
      "Release notes",
      "Tax rounding",
    ]);
    expect(byTitle["Coupon rounding"]).toMatchObject({
      thread_id: working,
      url: `https://dx.example.com/threads/${working}`,
      state: "working",
      status_line: "Running the rounding tests",
      owner: { name: "Ada Owner" },
      requester: { name: "Ben Member" },
      request_post_id: asked.id,
    });
    expect(byTitle["Release notes"]).toMatchObject({ state: "inactive" });
    // A question nobody answered is never just inactive.
    expect(byTitle["Refund provider"]).toMatchObject({ state: "needs-input" });
    expect(byTitle["Tax rounding"]).toMatchObject({
      state: "shipped",
      commits_landed: true,
    });
    const onlyWorking = await call(tools, "list_space_threads", {
      state: "working",
    });
    expect(
      onlyWorking.threads.map(({ title }: { title: string }) => title),
    ).toEqual(["Coupon rounding"]);
    const recent = await call(tools, "list_space_threads", {
      since: "2026-06-01T00:00:00Z",
    });
    expect(
      recent.threads.map(({ title }: { title: string }) => title).sort(),
    ).toEqual(["Coupon rounding", "Tax rounding"]);
    const page = await call(tools, "list_space_threads", { limit: 2 });
    expect(page.threads).toHaveLength(2);
    expect(typeof page.nextCursor).toBe("string");
    const rest = await call(tools, "list_space_threads", {
      limit: 2,
      cursor: page.nextCursor,
    });
    expect(rest.threads).toHaveLength(2);
    expect(rest.nextCursor).toBeUndefined();
  });

  it("relays a ship request with the project's Ship Behavior prompt first", async () => {
    const spaceId = await createSpace();
    const threadTools = createThreadTools(
      spaceId,
      () => ({ db: env.DB, bindings }),
      "sub_ship",
      false,
      member,
      { space: true },
    );
    const byName = (name: string) => {
      const found = threadTools.find((tool) => tool.name === name);
      if (found === undefined) throw new Error(`No ${name} tool.`);
      return found;
    };
    const childId = (
      (await byName("create_thread").run({
        data: { prompt: "Fix rounding.", title: "Coupon rounding" },
        toolCallId: "call_child",
      } as never)) as { output: { threadId: string } }
    ).output.threadId;
    flue.agent.length = 0;
    await byName("send_thread_message").run({
      data: {
        thread: childId,
        message: "Ben Member asked to ship this.",
        ship: true,
      },
      toolCallId: "call_ship",
    } as never);
    const shipped = flue.agent.find(({ threadId }) => threadId === childId);
    const text = parseMessageAuthor(shipped?.body ?? "").text;
    expect(shipWorkflowOf(text)).toBe("ship");
    expect(text.endsWith("Ben Member asked to ship this.")).toBe(true);
    // Without ship, the message goes as written.
    await byName("send_thread_message").run({
      data: { thread: childId, message: "Status?" },
      toolCallId: "call_plain",
    } as never);
    expect(parseMessageAuthor(flue.agent.at(-1)?.body ?? "").text).toBe(
      "Status?",
    );
    // Each send waits briefly for the child's activity, which no Flue
    // records here.
  }, 30_000);

  it("updates the Space and sets its own status", async () => {
    const spaceId = await createSpace();
    const tools = toolsFor(spaceId);
    await call(tools, "update_space", {
      name: "Checkout v3",
      goal: "Ship it by June",
      color: "purple",
    });
    const space = (await send(owner, `/v1/spaces/${spaceId}`)).body.data
      .space as SpaceData;
    expect(space).toMatchObject({
      name: "Checkout v3",
      goal: "Ship it by June",
      color: "purple",
    });
    await call(tools, "update_space", { goal: "" });
    expect(
      (await send(owner, `/v1/spaces/${spaceId}`)).body.data.space.goal,
    ).toBeNull();
    await expect(
      call(tools, "update_space", { color: "chartreuse" }),
    ).rejects.toThrow();

    await call(tools, "set_thread_status", {
      status: "Waiting on Ben's call",
      waiting_on_input: true,
    });
    // The sidebar and lists show it beside the Space's name.
    expect(
      (await send(member, `/v1/spaces/${spaceId}`)).body.data.space,
    ).toMatchObject({
      statusLine: "Waiting on Ben's call",
      waitingOnInput: true,
    });
    expect(await threadRow(spaceId)).toMatchObject({
      status_line: "Waiting on Ben's call",
    });
    expect(
      await env.DB.prepare(
        "SELECT waiting_on_input FROM space WHERE thread_id = ?",
      )
        .bind(spaceId)
        .first("waiting_on_input"),
    ).toBe(1);
    // An answer reaching the agent ends the wait, even before its turn sets
    // a new status; the status itself stays until the agent replaces it.
    expect(
      (
        await send(member, `/v1/spaces/${spaceId}/posts`, "POST", {
          text: "Drop it.",
        })
      ).status,
    ).toBe(201);
    expect(
      (await send(member, `/v1/spaces/${spaceId}`)).body.data.space,
    ).toMatchObject({
      statusLine: "Waiting on Ben's call",
      waitingOnInput: false,
    });
    await call(tools, "set_thread_status", { status: "" });
    expect(await threadRow(spaceId)).toMatchObject({ status_line: null });
    expect(
      await env.DB.prepare(
        "SELECT waiting_on_input FROM space WHERE thread_id = ?",
      )
        .bind(spaceId)
        .first("waiting_on_input"),
    ).toBe(0);
  });

  it("adds a thread and the threads it started to the Space", async () => {
    const spaceId = await createSpace();
    const root = await ordinaryThread("Payments cleanup");
    const started = await ordinaryThread("Payments follow-up", root);
    const tools = toolsFor(spaceId, owner);
    const added = await call(tools, "add_thread_to_space", {
      thread: `https://dx.example.com/threads/${root}`,
    });
    expect(added).toMatchObject({ added: [root, started].sort() });
    expect(await threadRow(root)).toMatchObject({ parent_thread_id: spaceId });
    expect(await threadRow(started)).toMatchObject({
      parent_thread_id: spaceId,
    });
    const listed = await send(owner, `/v1/spaces/${spaceId}/threads`);
    expect(
      listed.body.data.items.map(({ id }: { id: string }) => id).sort(),
    ).toEqual([root, started].sort());

    // Never the Space itself, another Space, or someone else's thread.
    await expect(
      call(tools, "add_thread_to_space", { thread: spaceId }),
    ).rejects.toThrow();
    const otherSpace = await createSpace();
    await expect(
      call(tools, "add_thread_to_space", { thread: otherSpace }),
    ).rejects.toThrow();
    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        yield* projects.insert(
          project("prj_00000000-0000-4000-8000-00000000e158", member, "mine"),
        );
      }),
    );
    const { payload } = await ownerRequest(
      { bindings, ownerUserId: member },
      "POST",
      "/v1/threads",
      {
        projectId: "prj_00000000-0000-4000-8000-00000000e158",
        title: "Ben's own",
        generateTitle: false,
      },
    );
    const others = (payload?.data as { id: string } | undefined)?.id ?? "";
    await expect(
      call(toolsFor(spaceId, member), "add_thread_to_space", {
        thread: others,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("archives the owner's matching threads only after a dry run", async () => {
    const spaceId = await createSpace();
    const stale = await ordinaryThread("Stale spike alpha");
    const staleToo = await ordinaryThread("Stale spike beta");
    const keep = await ordinaryThread("Keep this one");
    await env.DB.prepare(
      "UPDATE threads SET last_activity_at = '2026-01-01T00:00:00.000Z', updated_at = '2026-01-01T00:00:00.000Z' WHERE id IN (?, ?)",
    )
      .bind(stale, staleToo)
      .run();
    const tools = toolsFor(spaceId, owner);
    const query = "updated_before:30d archived:false";
    const preview = await call(tools, "archive_threads", {
      query,
      dryRun: true,
    });
    expect(preview).toMatchObject({ dryRun: true, count: 2 });
    expect((await threadRow(stale))?.lifecycle_state).toBe("active");
    const done = await call(tools, "archive_threads", {
      query,
      dryRun: false,
    });
    expect(done).toMatchObject({ dryRun: false, archived: 2 });
    expect((await threadRow(stale))?.lifecycle_state).toBe("archived");
    expect((await threadRow(staleToo))?.lifecycle_state).toBe("archived");
    expect((await threadRow(keep))?.lifecycle_state).toBe("active");
    // The Space never archives itself, whatever the query.
    await call(tools, "archive_threads", {
      query: `id:${spaceId}`,
      dryRun: false,
    });
    expect((await threadRow(spaceId))?.lifecycle_state).toBe("active");
  });

  it("answers the time, who it acts as, the workspace's members, and dx's docs", async () => {
    const spaceId = await createSpace();
    const tools = toolsFor(spaceId, member);
    // UTC until the owner's browser records their zone, then theirs.
    const time = await call(tools, "get_current_time", {});
    expect(Math.abs(Date.parse(time.now) - Date.now())).toBeLessThan(60_000);
    expect(time.timeZone).toBe("UTC");
    await env.DB.prepare(
      "INSERT INTO user_time_zone (user_id, time_zone, updated_at) VALUES (?, 'Asia/Kolkata', '2026-11-09T00:00:00Z')",
    )
      .bind(owner)
      .run();
    expect((await call(tools, "get_current_time", {})).timeZone).toBe(
      "Asia/Kolkata",
    );

    const identity = await call(tools, "get_current_user_identity", {});
    expect(identity).toMatchObject({
      actsAs: { userId: owner, name: "Ada Owner", handle: "ada" },
      asker: { userId: member, name: "Ben Member", handle: "benm" },
    });

    const members = await call(tools, "list_workspace_members", {});
    expect(
      members.members.map(({ name, handle }: Record<string, string>) => [
        name,
        handle,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["Ada Owner", "ada"],
        ["Ben Member", "benm"],
      ]),
    );
    expect(
      members.members.some(
        ({ name }: { name: string }) => name === "Cy Outsider",
      ),
    ).toBe(false);

    const docs = await call(tools, "search_dx_documentation", {
      query: "connect an Orb provider",
    });
    expect(docs.results.length).toBeGreaterThan(0);
    expect(docs.results[0]).toMatchObject({
      title: expect.any(String),
      url: expect.stringMatching(/^https:\/\/dxcode\.dev\/docs\//),
      excerpt: expect.any(String),
    });
    expect(
      docs.results.some(({ url }: { url: string }) =>
        url.includes("connect-an-orb-provider"),
      ),
    ).toBe(true);
    const nothing = await call(tools, "search_dx_documentation", {
      query: "zzqxv",
    });
    expect(nothing.results).toEqual([]);
  });
});
