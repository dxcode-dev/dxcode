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
  it("fails safely and identifies only the missing category", async () => {
    const warn = await expectNotReady(
      createTestBindings({ DX_ENV: undefined }),
      "configuration",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("DX_ENV");
  });

  it("distinguishes authentication configuration without exposing it", async () => {
    const warn = await expectNotReady(
      createTestBindings({ BETTER_AUTH_SECRET: undefined }),
      "authentication_configuration",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TEST_AUTH_SECRET);
  });

  it("logs which deployment identity check failed without its value", async () => {
    const warn = await expectNotReady(
      createTestBindings({ DX_DEPLOYMENT_REVISION: "not-a-revision" }),
      "deployment_identity_configuration",
    );
    expect(warn).toHaveBeenCalledWith(
      "Runtime readiness check failed.",
      expect.objectContaining({ readinessCheck: "deployment_revision" }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("not-a-revision");
  });
});
