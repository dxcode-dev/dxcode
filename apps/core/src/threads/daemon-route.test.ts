import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv, Bindings } from "../http/types.js";
import { threadDaemonRoutes } from "./daemon-route.js";

const mocks = vi.hoisted(() => ({
  verifyThreadDaemonApiKey: vi.fn(),
}));

vi.mock("../auth/daemon-api-key.js", () => ({
  verifyThreadDaemonApiKey: mocks.verifyThreadDaemonApiKey,
}));

const threadId = "thr_00000000-0000-4000-8000-000000000292";

const harness = () => {
  mocks.verifyThreadDaemonApiKey.mockResolvedValue({ keyId: "daemon-key-id" });
  const fetch = vi.fn(async (_request: Request) =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
  const get = vi.fn(() => ({ fetch }));
  const idFromName = vi.fn(() => ({ marker: "id" }));
  const binding = { idFromName, get } as unknown as DurableObjectNamespace;
  const app = new Hono<AppEnv>().route("/v1/threads", threadDaemonRoutes);
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

  it("forwards only WebSocket transport headers and server-owned authority", async () => {
    const fixture = harness();
    const response = await fixture.request(`/v1/threads/${threadId}/dxd`, {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "test-key",
      authorization: "Bearer dxd_test-key-value",
      cookie: "must-not-forward=true",
      "x-dx-thread-id": "thr_00000000-0000-4000-8000-999999999999",
      "x-dx-daemon-ingress": "attacker",
    });

    expect(response.status).toBe(200);
    expect(fixture.idFromName).toHaveBeenCalledWith(threadId);
    const forwarded = fixture.fetch.mock.calls[0]?.[0];
    expect(forwarded).toBeInstanceOf(Request);
    if (forwarded === undefined) throw new Error("Request was not forwarded.");
    expect(new URL(forwarded.url).pathname).toBe("/daemon/socket");
    expect(forwarded.headers.get("x-dx-thread-id")).toBe(threadId);
    expect(forwarded.headers.get("x-dx-daemon-ingress")).toBe("1");
    expect(forwarded.headers.get("x-dx-daemon-key-id")).toBe("daemon-key-id");
    expect(forwarded.headers.get("authorization")).toBeNull();
    expect(forwarded.headers.get("cookie")).toBeNull();
  });

  it("rejects an absent Durable Object binding", async () => {
    const app = new Hono<AppEnv>().route("/v1/threads", threadDaemonRoutes);
    const response = await app.request(
      `/v1/threads/${threadId}/dxd`,
      { headers: { upgrade: "websocket" } },
      {} as Bindings,
    );
    expect(response.status).toBe(404);
  });

  it("rejects an invalid daemon API key before Durable Object lookup", async () => {
    const fixture = harness();
    mocks.verifyThreadDaemonApiKey.mockResolvedValue(undefined);
    const response = await fixture.request(`/v1/threads/${threadId}/dxd`, {
      upgrade: "websocket",
      authorization: "Bearer invalid",
    });
    expect(response.status).toBe(401);
    expect(fixture.idFromName).not.toHaveBeenCalled();
  });
});
