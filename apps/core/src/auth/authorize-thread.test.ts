import { defaultThreadModelSelection, Principal } from "@dx/domain";
import { Schema } from "effect";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../http/http-errors.js";
import { requestId } from "../http/request-id.js";
import type { AppEnv } from "../http/types.js";
import { authorizationLogger, httpErrorLogger } from "../logging.js";
import { authorizeThread } from "./authorize-thread.js";

const ownedThreadId = "thr_00000000-0000-4000-8000-000000000041";
const missingThreadId = "thr_00000000-0000-4000-8000-000000000042";
const principal = Schema.decodeSync(Principal)({ userId: "owner-a" });
const row = {
  id: ownedThreadId,
  title: "Test thread",
  project_id: "prj_00000000-0000-4000-8000-000000000031",
  owner_user_id: "owner-a",
  agent_instructions: "",
  agent_instructions_revision: 0,
  agent_instructions_version: 1,
  model_selection: JSON.stringify(defaultThreadModelSelection()),
  plugin_snapshot_json: "[]",
  skill_snapshot_json: "[]",
  visibility: "private",
  workspace_policy_revision: 0,
  workspace_policy_migration_state: "grandfathered",
  created_at: "2026-08-20T12:00:00.000Z",
  updated_at: "2026-08-20T12:00:00.000Z",
  last_activity_at: "2026-08-20T12:00:00.000Z",
  activity_status: "idle",
  lifecycle_state: "active",
  pinned_at: null,
};

const createD1Binding = (options: { readonly fail?: boolean } = {}) => {
  const prepare = vi.fn(() => ({
    bind: (threadId: string, ownerUserId: string) => ({
      all: async () => {
        if (options.fail) throw new Error("simulated D1 outage");
        return {
          results:
            threadId === row.id && ownerUserId === row.owner_user_id
              ? [row]
              : [],
        };
      },
    }),
  }));
  return { binding: { prepare } as unknown as D1Database, prepare };
};

const createAuthorizationApp = () => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set("principal", principal);
    await next();
  });
  app.use("/:threadId/*", authorizeThread);
  app.all("/:threadId/*", (context) => context.body(null, 204));
  app.onError(errorHandler);
  return app;
};

afterEach(() => vi.restoreAllMocks());

describe("Thread authorization middleware", () => {
  it("allows an owned Thread through the direct D1 repository Layer", async () => {
    const { binding } = createD1Binding();
    const response = await createAuthorizationApp().request(
      `/${ownedThreadId}`,
      undefined,
      { DB: binding },
    );

    expect(response.status).toBe(204);
  });

  it("does not query D1 for an invalid ThreadId", async () => {
    const { binding, prepare } = createD1Binding();
    const response = await createAuthorizationApp().request(
      "/not-a-thread-id/abort",
      { method: "POST" },
      { DB: binding },
    );

    expect(response.status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    ["nonexistent", missingThreadId, principal],
    [
      "other owner",
      ownedThreadId,
      Schema.decodeSync(Principal)({ userId: "owner-b" }),
    ],
  ])(
    "returns the same Thread-owned 404 for a %s Thread",
    async (_label, threadId, requestPrincipal) => {
      const { binding } = createD1Binding();
      const app = new Hono<AppEnv>();
      app.use("*", requestId);
      app.use("*", async (context, next) => {
        context.set("principal", requestPrincipal);
        await next();
      });
      app.use("/:threadId/*", authorizeThread);
      app.all("/:threadId/*", (context) => context.body(null, 204));
      const response = await app.request(`/${threadId}`, undefined, {
        DB: binding,
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        status: "error",
        data: {
          code: "THREAD_NOT_FOUND",
          message: "Thread not found.",
          requestId: expect.any(String),
        },
      });
    },
  );

  it("keeps D1 failures as generic server errors", async () => {
    vi.spyOn(authorizationLogger, "error").mockImplementation(() => {});
    vi.spyOn(httpErrorLogger, "error").mockImplementation(() => {});
    const { binding } = createD1Binding({ fail: true });
    const response = await createAuthorizationApp().request(
      `/${ownedThreadId}`,
      undefined,
      { DB: binding },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      data: { code: "INTERNAL_SERVER_ERROR" },
    });
  });

  it.each([
    ["missing", undefined],
    ["malformed", {}],
  ])(
    "keeps a %s request-time D1 binding as a generic 500",
    async (_label, DB) => {
      vi.spyOn(authorizationLogger, "error").mockImplementation(() => {});
      vi.spyOn(httpErrorLogger, "error").mockImplementation(() => {});
      const response = await createAuthorizationApp().request(
        `/${ownedThreadId}`,
        undefined,
        { DB: DB as D1Database | undefined },
      );

      expect(response.status).toBe(500);
    },
  );

  it("logs only safe authorization correlation fields", async () => {
    const warn = vi
      .spyOn(authorizationLogger, "warn")
      .mockImplementation(() => {});
    const { binding } = createD1Binding();
    await createAuthorizationApp().request(`/${missingThreadId}`, undefined, {
      DB: binding,
    });

    const captured = JSON.stringify(warn.mock.calls);
    expect(captured).toContain(missingThreadId);
    expect(captured).not.toContain(principal.userId);
    expect(warn).toHaveBeenCalledWith(
      "Thread authorization found no owned Thread.",
      expect.objectContaining({
        outcome: "not_found",
        threadId: missingThreadId,
        requestId: expect.any(String),
        durationMs: expect.any(Number),
      }),
    );
  });
});
