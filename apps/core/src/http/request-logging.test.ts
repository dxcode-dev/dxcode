import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestLogger } from "../logging.js";
import { requestId } from "./request-id.js";
import { requestLogging } from "./request-logging.js";
import type { AppEnv } from "./types.js";

const createApp = () => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", requestLogging);
  app.get("/items/:id", (context) => context.json({ ok: true }));
  return app;
};

afterEach(() => vi.restoreAllMocks());

describe("request logging middleware", () => {
  it("logs a canonical route and safe request metadata", async () => {
    const info = vi.spyOn(requestLogger, "info").mockImplementation(() => {});
    await createApp().request("/items/sensitive-value", {
      headers: {
        authorization: "Bearer secret",
        "x-request-id": "known-id",
      },
    });

    expect(info).toHaveBeenCalledWith("Request completed.", {
      event: "request_completed",
      requestId: "known-id",
      method: "GET",
      route: "/items/:id",
      status: 200,
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain("sensitive-value");
    expect(JSON.stringify(info.mock.calls)).not.toContain("Bearer secret");
  });

  it("uses a stable sentinel for an unmatched route", async () => {
    const info = vi.spyOn(requestLogger, "info").mockImplementation(() => {});
    await createApp().request("/private-value");

    expect(info).toHaveBeenCalledWith(
      "Request completed.",
      expect.objectContaining({ route: "<unmatched>", status: 404 }),
    );
  });
});
