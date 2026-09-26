import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestId } from "../http/request-id.js";
import type { AppEnv, Bindings } from "../http/types.js";
import { readinessLogger } from "../logging.js";
import { createTestBindings, TEST_AUTH_SECRET } from "../testing/bindings.js";
import { readinessHandler } from "./handler.js";

const createReadinessApp = () => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.get("/readyz", readinessHandler);
  return app;
};

const expectNotReady = async (bindings: Bindings, category: string) => {
  const warn = vi.spyOn(readinessLogger, "warn").mockImplementation(() => {});
  const response = await createReadinessApp().request(
    "/readyz",
    undefined,
    bindings,
  );

  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({
    status: "error",
    data: {
      code: "SERVICE_NOT_READY",
      message: "Required runtime configuration is missing or invalid.",
      requestId: expect.any(String),
    },
  });
  expect(warn).toHaveBeenCalledWith(
    "Runtime readiness check failed.",
    expect.objectContaining({
      event: "readiness_failed",
      readinessCategory: category,
    }),
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain('"category":');
  return warn;
};

afterEach(() => vi.restoreAllMocks());

describe("readiness endpoint", () => {
  it("reports readiness when configuration and bindings are valid", async () => {
    const response = await createReadinessApp().request(
      "/readyz",
      undefined,
      createTestBindings(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "success",
      data: { state: "ready" },
    });
  });

  it("fails safely and identifies only the missing category", async () => {
    const warn = await expectNotReady(
      createTestBindings({ DX_ENV: undefined }),
      "configuration",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("DX_ENV");
  });

  it.each([
    ["missing", undefined],
    ["malformed", {}],
  ])(
    "fails safely when the generated binding is %s",
    async (_label, binding) => {
      await expectNotReady(
        createTestBindings({
          FLUE_DX_AGENT_AGENT: binding as DurableObjectNamespace | undefined,
        }),
        "agent_binding",
      );
    },
  );

  it.each([
    ["missing", undefined],
    ["malformed", {}],
  ])("fails safely when the AI binding is %s", async (_label, binding) => {
    await expectNotReady(
      createTestBindings({ AI: binding as Ai | undefined }),
      "ai_binding",
    );
  });

  it("distinguishes authentication configuration without exposing it", async () => {
    const warn = await expectNotReady(
      createTestBindings({ BETTER_AUTH_SECRET: undefined }),
      "authentication_configuration",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TEST_AUTH_SECRET);
  });

  it.each([
    ["missing", undefined],
    ["malformed", {}],
  ])("fails safely when the D1 binding is %s", async (_label, binding) => {
    await expectNotReady(
      createTestBindings({ DB: binding as D1Database | undefined }),
      "d1_binding",
    );
  });
});
