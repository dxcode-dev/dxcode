import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requestId } from "./request-id.js";
import type { AppEnv } from "./types.js";

const createApp = () => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.get("/", (context) => context.text(context.get("requestId")));
  return app;
};

describe("request ID middleware", () => {
  it("accepts and echoes a bounded request ID", async () => {
    const response = await createApp().request("/", {
      headers: { "x-request-id": "request_123.valid" },
    });

    expect(await response.text()).toBe("request_123.valid");
    expect(response.headers.get("x-request-id")).toBe("request_123.valid");
  });

  it.each(["", "contains spaces", "x".repeat(129)])(
    "replaces invalid request ID %j",
    async (candidate) => {
      const response = await createApp().request("/", {
        headers: { "x-request-id": candidate },
      });
      const requestId = response.headers.get("x-request-id");

      expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(await response.text()).toBe(requestId);
    },
  );
});
