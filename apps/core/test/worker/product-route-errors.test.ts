import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  bindings,
  createProductApp,
  jsonHeaders,
} from "./product-route-fixture.js";

describe("Product route errors in workerd with real D1", () => {
  it("rejects malformed bodies, media, IDs, and query values", async () => {
    const invalidBodies: Array<[HeadersInit, string]> = [
      [{}, JSON.stringify({ name: "No media" })],
      [{ "content-type": "text/plain" }, JSON.stringify({ name: "Wrong" })],
      [{ "content-type": "application/json" }, "{"],
      [
        { "content-type": "application/json" },
        JSON.stringify({ name: "Extra", ownerUserId: "forbidden" }),
      ],
    ];
    for (const [headers, body] of invalidBodies) {
      const response = await createProductApp().request(
        "/projects",
        { method: "POST", headers, body },
        bindings,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        status: "error",
        data: { code: "INVALID_REQUEST" },
      });
    }

    for (const [headers, body] of [
      [{}, JSON.stringify({ projectId: "not-a-project" })],
      [jsonHeaders, "{"],
      [jsonHeaders, JSON.stringify({ projectId: "not-a-project" })],
    ] as const) {
      const invalidThreadBody = await createProductApp().request(
        "/threads",
        { method: "POST", headers, body },
        bindings,
      );
      expect(invalidThreadBody.status).toBe(400);
      expect(await invalidThreadBody.json()).toMatchObject({
        status: "error",
        data: { code: "INVALID_REQUEST" },
      });
    }

    for (const path of [
      "/projects/not-a-project",
      "/threads/not-a-thread",
      "/projects?unknown=value",
      "/threads?projectId=not-a-project",
      "/projects?cursor=abc",
      "/threads?cursor=abc",
      ...["0", "101", "2e1", "+20", "%2020", "2.0", "-1"].map(
        (limit) => `/threads?limit=${limit}`,
      ),
    ]) {
      const response = await createProductApp().request(path, {}, bindings);
      expect(response.status, path).toBe(400);
      expect(await response.json()).toMatchObject({
        status: "error",
        data: { code: "INVALID_REQUEST" },
      });
    }
  });

  it("maps D1 persistence failure to detail-free 503", async () => {
    await env.DB.exec("DROP TABLE projects");
    const response = await createProductApp().request(
      "/projects",
      {},
      bindings,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "error",
      data: {
        code: "PERSISTENCE_UNAVAILABLE",
        message: "Persistence is temporarily unavailable.",
        requestId: expect.any(String),
      },
    });
  });
});
