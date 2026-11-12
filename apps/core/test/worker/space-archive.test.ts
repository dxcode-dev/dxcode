import { env } from "cloudflare:test";
import {
  Principal,
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { threadRoutes } from "../../src/threads/routes.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";
import { seedSpaceUsers } from "./space-users.js";

/**
 * Archived Spaces stay reachable: they list with the archived Threads in
 * the sidebar's Archived section, while active Spaces list only in the
 * Spaces section.
 *
 * Ways it could go wrong: an archived Space lists nowhere; an active Space
 * also lists as an ordinary Thread; an archived Space carries no kind, so
 * opening it shows a plain Thread page.
 */

const owner = "archive-space-owner" as UserId;
const fixtureProject = project(
  "prj_00000000-0000-4000-8000-00000000c151",
  owner,
  "storefront",
);
const id = (n: number) =>
  `thr_00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as ThreadId;
const ACTIVE_SPACE = id(1);
const ARCHIVED_SPACE = id(2);
const ARCHIVED_THREAD = id(3);

const bindings: Bindings = {
  DB: env.DB,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
};

const roots = async (lifecycleState: "active" | "archived") => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId: owner,
        credentialScopes: ["personal"],
      }),
    );
    await next();
  });
  app.route("/threads", threadRoutes);
  app.onError(errorHandler);
  const response = await app.request(
    `/threads?roots=true&lifecycleState=${lifecycleState}&limit=100`,
    {},
    bindings,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { items: Array<{ id: string; kind?: string }> };
  };
  return body.data.items.map(({ id: threadId, kind }) => ({
    id: threadId,
    ...(kind === undefined ? {} : { kind }),
  }));
};

beforeEach(async () => {
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(fixtureProject);
      const threads = yield* ThreadRepository;
      for (const threadId of [ACTIVE_SPACE, ARCHIVED_SPACE, ARCHIVED_THREAD])
        yield* threads.insert(thread(threadId, fixtureProject.id, owner));
    }),
  );
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE threads SET kind = 'space' WHERE id IN (?1, ?2)",
    ).bind(ACTIVE_SPACE, ARCHIVED_SPACE),
    env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id IN (?1, ?2)",
    ).bind(ARCHIVED_SPACE, ARCHIVED_THREAD),
  ]);
});

beforeEach(() => seedSpaceUsers([owner]));

describe("archived Spaces", () => {
  it("list with the archived Threads, and active ones stay out of the Threads", async () => {
    expect(await roots("active")).toEqual([]);
    const archived = await roots("archived");
    expect(archived).toHaveLength(2);
    expect(archived).toEqual(
      expect.arrayContaining([
        { id: ARCHIVED_SPACE, kind: "space" },
        { id: ARCHIVED_THREAD },
      ]),
    );
  });
});
