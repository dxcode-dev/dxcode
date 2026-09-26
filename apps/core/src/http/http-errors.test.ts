import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { httpErrorLogger, requestLogger } from "../logging.js";
import { errorHandler, notFoundHandler } from "./http-errors.js";
import { requestId } from "./request-id.js";
import { requestLogging } from "./request-logging.js";
import type { AppEnv } from "./types.js";

const createApp = () => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", requestLogging);
  app.get("/failure", () => {
    throw new Error("secret diagnostic");
  });
  app.notFound(notFoundHandler);
  app.onError(errorHandler);
  return app;
};

afterEach(() => vi.restoreAllMocks());

describe("dx HTTP error mapping", () => {
  it("returns a stable not-found response", async () => {
    vi.spyOn(requestLogger, "info").mockImplementation(() => {});
    const response = await createApp().request("/missing", {
      headers: { "x-request-id": "not-found-id" },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      status: "error",
      data: {
        code: "NOT_FOUND",
        message: "Route not found.",
        requestId: "not-found-id",
      },
    });
  });

  it("does not expose an uncaught error", async () => {
    const error = vi
      .spyOn(httpErrorLogger, "error")
      .mockImplementation(() => {});
    const info = vi.spyOn(requestLogger, "info").mockImplementation(() => {});
    const response = await createApp().request("/failure", {
      headers: { "x-request-id": "failure-id" },
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      status: "error",
      data: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
        requestId: "failure-id",
      },
    });
    expect(response.headers.get("x-request-id")).toBe("failure-id");
    expect(info).toHaveBeenCalledWith(
      "Request completed.",
      expect.objectContaining({
        event: "request_completed",
        requestId: "failure-id",
        route: "/failure",
        status: 500,
      }),
    );
    expect(error).toHaveBeenCalledWith("Unhandled request error.", {
      event: "request_failed",
      category: "internal",
      requestId: "failure-id",
    });
    expect(JSON.stringify(body)).not.toContain("secret diagnostic");
  });
});
