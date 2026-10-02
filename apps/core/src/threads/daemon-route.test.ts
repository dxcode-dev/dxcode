import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv, Bindings } from "../http/types.js";
import daemonIngressWorker from "./daemon-ingress.js";
import { threadDaemonRoutes } from "./daemon-route.js";

const threadId = "thr_00000000-0000-4000-8000-000000000292";

const harness = () => {
  const fetch = vi.fn(async (_request: Request) =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
  const get = vi.fn(() => ({ fetch }));
  const idFromName = vi.fn(() => ({ marker: "id" }));
  const binding = { idFromName, get } as unknown as DurableObjectNamespace;
  const app = new Hono<AppEnv>().route("/v1", threadDaemonRoutes);
  const request = (path: string, headers: HeadersInit = {}) =>
    app.request(`https://dx.test${path}`, { headers }, {
      THREAD_EXECUTION: binding,
    } as Bindings);
  return { request, fetch, get, idFromName };
};

describe("dxd ingress", () => {
  it.each([
    ["malformed ThreadId", "/v1/threads/not-a-thread/dxd", "websocket"],
    ["non-WebSocket request", `/v1/threads/${threadId}/dxd`, ""],
    [
      "malformed ThreadId on the ingress path",
      "/v1/dxd/not-a-thread",
      "websocket",
    ],
  ])(
    "rejects %s before Durable Object lookup",
    async (_name, path, upgrade) => {
      const fixture = harness();
      const response = await fixture.request(
        path,
        upgrade === "" ? {} : { upgrade },
      );
      expect(response.status).toBe(404);
      expect(fixture.idFromName).not.toHaveBeenCalled();
    },
  );

  it.each([`/v1/dxd/${threadId}`, `/v1/threads/${threadId}/dxd`])(
    "forwards the key and WebSocket transport headers of %s without touching D1",
    async (path) => {
      const fixture = harness();
      const response = await fixture.request(path, {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "test-key",
        authorization: "Bearer dxd_test-key-value-0123456789",
        cookie: "must-not-forward=true",
        "x-dx-thread-id": "thr_00000000-0000-4000-8000-999999999999",
        "x-dx-daemon-ingress": "attacker",
      });

      expect(response.status).toBe(200);
      expect(fixture.idFromName).toHaveBeenCalledWith(threadId);
      const forwarded = fixture.fetch.mock.calls[0]?.[0];
      expect(forwarded).toBeInstanceOf(Request);
      if (forwarded === undefined)
        throw new Error("Request was not forwarded.");
      expect(new URL(forwarded.url).pathname).toBe("/daemon/socket");
      expect(forwarded.headers.get("x-dx-thread-id")).toBe(threadId);
      expect(forwarded.headers.get("x-dx-daemon-ingress")).toBe("1");
      expect(forwarded.headers.get("authorization")).toBe(
        "Bearer dxd_test-key-value-0123456789",
      );
      expect(forwarded.headers.get("cookie")).toBeNull();
    },
  );

  it("rejects an absent Durable Object binding", async () => {
    const app = new Hono<AppEnv>().route("/v1", threadDaemonRoutes);
    const response = await app.request(
      `/v1/threads/${threadId}/dxd`,
      { headers: { upgrade: "websocket" } },
      {} as Bindings,
    );
    expect(response.status).toBe(404);
  });

  it("rejects a malformed daemon API key before Durable Object lookup", async () => {
    const fixture = harness();
    const response = await fixture.request(`/v1/threads/${threadId}/dxd`, {
      upgrade: "websocket",
      authorization: "Bearer invalid",
    });
    expect(response.status).toBe(401);
    expect(fixture.idFromName).not.toHaveBeenCalled();
  });

  it("serves only the ingress path as the dedicated ingress Worker", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const namespace = {
      idFromName: vi.fn(() => ({})),
      get: vi.fn(() => ({ fetch })),
    } as unknown as DurableObjectNamespace;
    const upgrade = (path: string) =>
      daemonIngressWorker.fetch(
        new Request(`https://dx.test${path}`, {
          headers: {
            upgrade: "websocket",
            authorization: "Bearer dxd_test-key-value-0123456789",
          },
        }),
        { THREAD_EXECUTION: namespace },
      );
    expect((await upgrade(`/v1/dxd/${threadId}`)).status).toBe(200);
    expect((await upgrade(`/v1/threads/${threadId}/files`)).status).toBe(404);
    expect((await upgrade(`/v1/dxd/${threadId}/extra`)).status).toBe(404);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
