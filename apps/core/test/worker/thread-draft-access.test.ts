import { env } from "cloudflare:test";
import {
  Principal,
  ProjectRepository,
  ThreadRepository,
  type UserId,
  WorkspaceId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { settingsRoutes } from "../../src/settings/routes.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";
import { tombstoneThreads } from "../../src/thread-deletion/tombstone.js";
import { threadSharingRoutes } from "../../src/thread-sharing/routes.js";
import { threadDraftRoutes } from "../../src/threads/thread-draft-route.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

// A draft holds whatever its person typed (#1169), so it must never outlive
// their access to the Thread: each way access ends deletes it.

const owner = "draft-owner" as UserId;
const member = "draft-member" as UserId;
const outsider = "draft-outsider" as UserId;
const workspaceId = "draft-workspace";
const slug = "draft-team";

const bindings: Bindings = {
  DB: env.DB,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  DX_AUTH_URL: "https://dx.example.test",
};
const executionContext = {
  waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined),
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

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
  app.route("/settings", settingsRoutes);
  app.route("/projects", projectRoutes);
  app.route("/threads", threadSharingRoutes);
  app.route("/threads", threadDraftRoutes);
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
    executionContext,
  );

const personalProject = project(
  "prj_00000000-0000-4000-8000-00000000d001",
  owner,
  "Personal",
);
const workspaceProject = {
  ...project("prj_00000000-0000-4000-8000-00000000d002", owner, "Team App"),
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)(workspaceId),
};
/** The owner's personal Thread, shared with the workspace in most tests. */
const sharedThread = thread(
  "thr_00000000-0000-4000-8000-00000000d101",
  personalProject.id,
  owner,
);
/** The member's own Thread in the workspace's Project. */
const memberTeamThread = thread(
  "thr_00000000-0000-4000-8000-00000000d102",
  workspaceProject.id,
  member,
);

const user = (id: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, id, `${id}@example.com`);

beforeEach(async () => {
  await env.DB.batch([
    user(owner),
    user(member),
    user(outsider),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Draft Team', ?, 1)",
    ).bind(workspaceId, slug),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('d-owner', ?1, ?2, 'owner', 1), ('d-member', ?1, ?3, 'member', 2)`,
    ).bind(workspaceId, owner, member),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      const threads = yield* ThreadRepository;
      yield* projects.insert(personalProject);
      yield* projects.insert(workspaceProject);
      yield* threads.insert(sharedThread);
      yield* threads.insert(memberTeamThread);
    }),
  );
});

const share = async (workspaceAccess: "view" | "contribute" | "none") =>
  expect(
    (
      await send(owner, `/threads/${sharedThread.id}/sharing`, "PUT", {
        workspaceAccess,
      })
    ).status,
  ).toBe(200);

const saveDraft = async (userId: UserId, threadId: string, text: string) =>
  expect(
    (await send(userId, `/threads/${threadId}/draft`, "PUT", { text })).status,
  ).toBe(200);

const readDraft = async (userId: UserId, threadId: string) => {
  const response = await send(userId, `/threads/${threadId}/draft`);
  return response.status === 200
    ? (await response.json<{ data: { text: string } }>()).data.text
    : response.status;
};

/** Every stored draft, as `user thread`. */
const stored = async () =>
  (
    await env.DB.prepare(
      "SELECT user_id, thread_id FROM thread_draft ORDER BY user_id, thread_id",
    ).all<{ user_id: string; thread_id: string }>()
  ).results.map(({ user_id, thread_id }) => `${user_id} ${thread_id}`);

/** The owner's and the member's drafts in the shared Thread, and the member's own. */
const draftEverywhere = async () => {
  await share("contribute");
  await saveDraft(owner, sharedThread.id, "owner's draft");
  await saveDraft(member, sharedThread.id, "member's draft");
  await saveDraft(member, memberTeamThread.id, "member's own draft");
  expect(await stored()).toEqual([
    `${member} ${sharedThread.id}`,
    `${member} ${memberTeamThread.id}`,
    `${owner} ${sharedThread.id}`,
  ]);
};

describe("Thread drafts never outlive access", () => {
  it("keeps each person's draft their own and refuses it to anyone who cannot read the Thread", async () => {
    await draftEverywhere();
    expect(await readDraft(owner, sharedThread.id)).toBe("owner's draft");
    expect(await readDraft(member, sharedThread.id)).toBe("member's draft");
    expect(await readDraft(outsider, sharedThread.id)).toBe(404);
    expect(
      (
        await send(outsider, `/threads/${sharedThread.id}/draft`, "PUT", {
          text: "x",
        })
      ).status,
    ).toBe(404);
  });

  it("deletes a member's draft when the owner unshares the Thread", async () => {
    await draftEverywhere();
    await share("none");
    expect(await readDraft(member, sharedThread.id)).toBe(404);
    expect(await stored()).toEqual([
      `${member} ${memberTeamThread.id}`,
      `${owner} ${sharedThread.id}`,
    ]);
  });

  it("deletes a member's drafts when they leave the workspace", async () => {
    await draftEverywhere();
    expect(
      (await send(member, `/settings/workspaces/${slug}/leave`, "POST")).status,
    ).toBe(200);
    expect(await readDraft(member, sharedThread.id)).toBe(404);
    expect(await readDraft(member, memberTeamThread.id)).toBe(404);
    expect(await stored()).toEqual([`${owner} ${sharedThread.id}`]);
  });

  it("deletes a member's drafts when an admin removes them", async () => {
    await draftEverywhere();
    expect(
      (
        await send(
          owner,
          `/settings/workspaces/${slug}/members/${member}`,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    expect(await stored()).toEqual([`${owner} ${sharedThread.id}`]);
  });

  it("deletes every draft in a deleted Project's Threads, kept or not", async () => {
    await draftEverywhere();
    expect(
      (
        await send(owner, `/projects/${workspaceProject.id}/delete`, "POST", {
          confirmName: "Team App",
          threads: "keep",
        })
      ).status,
    ).toBe(200);
    expect(await stored()).toEqual([
      `${member} ${sharedThread.id}`,
      `${owner} ${sharedThread.id}`,
    ]);
  });

  it("deletes the workspace's drafts, and members' drafts in Threads shared with it, when it is deleted", async () => {
    await draftEverywhere();
    expect(
      (
        await send(owner, `/settings/workspaces/${slug}/delete`, "POST", {
          confirmShortName: slug,
          threads: "keep",
        })
      ).status,
    ).toBe(200);
    expect(await stored()).toEqual([`${owner} ${sharedThread.id}`]);
  });

  it("deletes everyone's drafts with the Thread", async () => {
    await draftEverywhere();
    expect(
      await tombstoneThreads(
        env.DB,
        [sharedThread.id],
        owner,
        new Date().toISOString(),
      ),
    ).toEqual([sharedThread.id]);
    expect(await stored()).toEqual([`${member} ${memberTeamThread.id}`]);
  });

  it("deletes a person's drafts with their account", async () => {
    await draftEverywhere();
    await env.DB.prepare('DELETE FROM "user" WHERE id = ?').bind(member).run();
    expect(await stored()).toEqual([`${owner} ${sharedThread.id}`]);
  });
});
