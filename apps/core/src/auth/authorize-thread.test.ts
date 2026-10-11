import { Principal } from "@dx/domain";
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
const createD1Binding = (options: { readonly fail?: boolean } = {}) => {
  const prepare = () => ({
    bind: () => ({
      // The shared-Thread lookup: no workspace grants in these tests.
      first: async () => null,
      all: async () => {
        if (options.fail) throw new Error("simulated D1 outage");
        return { results: [] };
      },
    }),
  });
  return { binding: { prepare } as unknown as D1Database };
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
