import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requestId } from "../http/request-id.js";
import type { AppEnv } from "../http/types.js";
import { healthHandler } from "./handler.js";

const createHealthApp = () => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.get("/healthz", healthHandler);
  return app;
};

describe("health endpoint", () => {
  it("reports Worker reachability", async () => {
    const response = await createHealthApp().request("/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "success",
      data: { state: "live" },
    });
  });
});
