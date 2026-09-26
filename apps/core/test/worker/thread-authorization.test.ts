import {
  Principal,
  ProjectRepository,
  ThreadRepository,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv } from "../../src/http/types.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

const owner = Schema.decodeSync(UserId)("worker-owner-a");
const otherOwner = Schema.decodeSync(UserId)("worker-owner-b");
const principal = Schema.decodeSync(Principal)({ userId: owner });
const otherPrincipal = Schema.decodeSync(Principal)({ userId: otherOwner });
const projectEntity = project(
  "prj_00000000-0000-4000-8000-000000000061",
  owner,
  "Authorization",
);
const threadEntity = thread(
  "thr_00000000-0000-4000-8000-000000000062",
  projectEntity.id,
  owner,
);

const createApp = (requestPrincipal: typeof principal) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set("principal", requestPrincipal);
    await next();
  });
  app.use("/agents/:threadId/*", authorizeThread);
  app.all("/agents/:threadId/*", (context) => context.body(null, 204));
  return app;
};

describe("Thread authorization in workerd with D1", () => {
  it("uses the owner-scoped repository for base and nested routes", async () => {
    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const threads = yield* ThreadRepository;
        yield* projects.insert(projectEntity);
        yield* threads.insert(threadEntity);
      }),
    );

    for (const path of [
      `/agents/${threadEntity.id}`,
      `/agents/${threadEntity.id}/abort`,
      `/agents/${threadEntity.id}/future/native/path`,
    ]) {
      const response = await createApp(principal).request(
        path,
        { method: "PATCH" },
        { DB: env.DB },
      );
      expect(response.status, path).toBe(204);
    }

    const otherOwnerResponse = await createApp(otherPrincipal).request(
      `/agents/${threadEntity.id}`,
      { headers: { "x-request-id": "authorization-404" } },
      { DB: env.DB },
    );
    const nonexistentResponse = await createApp(principal).request(
      "/agents/thr_00000000-0000-4000-8000-000000000063",
      { headers: { "x-request-id": "authorization-404" } },
      { DB: env.DB },
    );

    expect(otherOwnerResponse.status).toBe(404);
    expect(nonexistentResponse.status).toBe(404);
    expect(await otherOwnerResponse.json()).toEqual(
      await nonexistentResponse.json(),
    );
  });
});
