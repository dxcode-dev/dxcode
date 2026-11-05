import { env } from "cloudflare:test";
import { parseMessageAuthor } from "@dx/api";
import {
  Principal,
  ProjectRepository,
  type RunnerProfileId,
  type ThreadId,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { sharedThreadRoutes } from "../../src/thread-sharing/routes.js";
import { initialSubmissionId } from "../../src/threads/initial-dispatch.js";
import { createThreadRoutes } from "../../src/threads/routes.js";
import { project } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * #1636: `@` in a new Thread's first message. Ways it could go wrong: a
 * private Thread's mention shares nothing yet still notifies; someone outside
 * the owner's workspace is notified or follows; the owner notifies
 * themself; a tag turns the first message into member chat, so the agent
 * never gets it; a retry of the same creation notifies twice; a mention
 * reaches the agent without the tag that lets the transcript show it.
 */

const owner = "mention-owner" as UserId;
const member = "mention-member" as UserId;
const outsider = "mention-outsider" as UserId;
const workspaceId = "mention-workspace";
const otherWorkspaceId = "mention-other-workspace";
const personalProject = project(
  "prj_00000000-0000-4000-8000-000000001636",
  owner,
  "mention-owner-personal",
);
// On a size the test catalog offers, as a Project created in dx would be.
const ownerProject = {
  ...personalProject,
  configuration: {
    ...personalProject.configuration,
    runnerProfileId: "a1.medium" as RunnerProfileId,
  },
};

const bindings: Bindings = {
  DB: env.DB,
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  // Admits the first message's Orb size, as in thread-creation-admission.
  BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
};

type Dispatch = NonNullable<Parameters<typeof createThreadRoutes>[0]>;
type Delivered = Parameters<Dispatch>[0];

const harness = () => {
  const dispatched: Array<Delivered> = [];
  const dispatch: Dispatch = async (request) => {
    dispatched.push(request);
    return {
      submissionId: await initialSubmissionId(request.id as never),
    } as Awaited<ReturnType<Dispatch>>;
  };
  const pending: Array<Promise<unknown>> = [];
  const execution = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: () => {},
    props: {},
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
    app.route("/shared-threads", sharedThreadRoutes);
    app.route(
      "/threads",
      createThreadRoutes(
        dispatch,
        async () => undefined,
        async () => null,
      ),
    );
    app.onError(errorHandler);
    return app;
  };
  const create = async (body: Record<string, unknown>) => {
    const response = await appFor(owner).request(
      "/threads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: ownerProject.id,
          title: "Mentions at creation",
          ...body,
        }),
      },
      bindings,
      execution,
    );
    // Admission, follows, and notifications run after the response.
    while (pending.length > 0) await Promise.allSettled(pending.splice(0));
    return response;
  };
  const sharedThreadIds = async (userId: UserId) =>
    (
      await (
        await appFor(userId).request("/shared-threads", {}, bindings)
      ).json<{ data: { items: ReadonlyArray<{ id: string }> } }>()
    ).data.items.map(({ id }) => id);
  return { create, dispatched, sharedThreadIds };
};

const mentionNotifications = (threadId: ThreadId) =>
  env.DB.prepare(
    `SELECT recipient_user_id, actor_user_id, excerpt FROM notification
      WHERE topic = 'mention' AND thread_id = ?
      ORDER BY recipient_user_id`,
  )
    .bind(threadId)
    .all<{
      recipient_user_id: string;
      actor_user_id: string;
      excerpt: string;
    }>()
    .then(({ results }) => results);

const user = (id: string, name: string, handle: string) => [
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`),
  env.DB.prepare(
    "UPDATE personal_account SET username = ?2 WHERE user_id = ?1",
  ).bind(id, handle),
];

beforeEach(async () => {
  await env.DB.batch([
    ...user(owner, "Ada Owner", "ada"),
    ...user(member, "Ben Member", "ben"),
    ...user(outsider, "Dan Outsider", "dan"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?1, 'Team', 'mention-team', 1), (?2, 'Other', 'mention-other', 1)",
    ).bind(workspaceId, otherWorkspaceId),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('m-owner', ?1, ?2, 'owner', 1),
         ('m-member', ?1, ?3, 'member', 2),
         ('m-outsider', ?4, ?5, 'owner', 3)`,
    ).bind(workspaceId, owner, member, otherWorkspaceId, outsider),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(ownerProject);
    }),
  );
});

const threadId = (n: number) =>
  `thr_00000000-0000-4000-8000-00000016360${n}` as ThreadId;

describe("Mentions in a new Thread's first message", () => {
  it("notifies and follows only workspace members a Workspace Thread tags", async () => {
    const { create, dispatched, sharedThreadIds } = harness();
    const id = threadId(1);
    const body = "@ben and @dan, please review the login fix. cc @ada";
    const response = await create({
      threadId: id,
      visibility: "workspace",
      initialMessage: { body, attachments: [] },
    });
    expect(response.status, await response.clone().text()).toBe(201);

    // The agent gets the message, tagged with whom it mentions.
    expect(dispatched).toHaveLength(1);
    const delivered = dispatched[0]?.message;
    expect(delivered?.kind).toBe("user");
    const tag = parseMessageAuthor(delivered?.body ?? "");
    expect(tag.author?.userId).toBe(owner);
    expect(tag.chat).toBeUndefined();
    // As in a shared Thread's later messages: every member it tags, the
    // owner included; only the others are notified.
    expect(tag.mentions).toEqual([
      { handle: "ada", userId: owner },
      { handle: "ben", userId: member },
    ]);
    expect(tag.messageId).toMatch(/^msg_[0-9a-f]{24}$/);
    expect(
      (
        await env.DB.prepare(
          "SELECT conversation_mode FROM threads WHERE id = ?",
        )
          .bind(id)
          .first<{ conversation_mode: string }>()
      )?.conversation_mode,
    ).toBe("agent");

    // Ben, a member, is told and finds it in his sidebar; Dan, outside the
    // workspace, and the owner are not.
    expect(await mentionNotifications(id)).toEqual([
      expect.objectContaining({
        recipient_user_id: member,
        actor_user_id: owner,
      }),
    ]);
    expect(await sharedThreadIds(member)).toEqual([id]);
    expect(await sharedThreadIds(outsider)).toEqual([]);
  });

  it("notifies once when the same creation is sent again", async () => {
    const { create } = harness();
    const id = threadId(2);
    const request = {
      threadId: id,
      visibility: "workspace",
      initialMessage: { body: "@ben take a look", attachments: [] },
    };
    expect((await create(request)).status).toBe(201);
    expect((await create(request)).status).toBe(201);
    expect(await mentionNotifications(id)).toHaveLength(1);
  });

  it("shares and notifies nothing for a private Thread's mentions", async () => {
    const { create, dispatched, sharedThreadIds } = harness();
    const id = threadId(3);
    const response = await create({
      threadId: id,
      initialMessage: { body: "@ben take a look", attachments: [] },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const tag = parseMessageAuthor(dispatched[0]?.message.body ?? "");
    expect(tag.mentions ?? []).toEqual([]);
    expect(await mentionNotifications(id)).toEqual([]);
    expect(await sharedThreadIds(member)).toEqual([]);
  });
});
