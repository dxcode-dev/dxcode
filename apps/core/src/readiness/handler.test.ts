import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestId } from "../http/request-id.js";
import type { AppEnv, Bindings } from "../http/types.js";
import { readinessLogger } from "../logging.js";
import {
  createTestBindings,
  TEST_AUTH_SECRET,
  validR2Binding,
} from "../testing/bindings.js";
import { READINESS_CACHE_MS } from "./check.js";
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

describe("readiness endpoint load", () => {
  it("checks once per window however many requests arrive", async () => {
    const head = vi.fn(validR2Binding.head);
    const bindings = createTestBindings({
      DX_STORAGE: { ...validR2Binding, head } as unknown as R2Bucket,
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    // Every request gets its own env with its own D1 session wrapper.
    const readyz = () =>
      createReadinessApp().request("/readyz", undefined, {
        ...bindings,
        DB: { ...bindings.DB } as D1Database,
      });

    const responses = await Promise.all(Array.from({ length: 20 }, readyz));
    expect(responses.map(({ status }) => status)).toEqual(Array(20).fill(200));
    expect(head).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + READINESS_CACHE_MS - 1);
    expect((await readyz()).status).toBe(200);
    expect(head).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + READINESS_CACHE_MS);
    expect((await readyz()).status).toBe(200);
    expect(head).toHaveBeenCalledTimes(2);

    vi.spyOn(readinessLogger, "warn").mockImplementation(() => {});
    const changed = await createReadinessApp().request("/readyz", undefined, {
      ...bindings,
      DX_DEPLOYMENT_REVISION: "not-a-revision",
    });
    expect(changed.status).toBe(503);
  });
});
