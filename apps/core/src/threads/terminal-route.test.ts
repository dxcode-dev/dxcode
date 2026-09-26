import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv, Bindings } from "../http/types.js";
import { threadTerminalRoutes } from "./terminal-route.js";

const threadId = "thr_00000000-0000-4000-8000-000000000183";

const harness = (bindings: Partial<Bindings> = {}) => {
  const fetch = vi.fn<(request: Request) => Promise<Response>>(
    async () => new Response(null, { status: 200 }),
  );
  const get = vi.fn(() => ({ fetch }));
  const idFromName = vi.fn(() => ({ marker: "id" }));
  const binding = { idFromName, get } as unknown as DurableObjectNamespace;
  const app = new Hono<AppEnv>().route("/v1/threads", threadTerminalRoutes);
  const request = (path: string, headers: HeadersInit = {}) =>
    app.request(`http://dx.test${path}`, { headers }, {
      THREAD_EXECUTION: binding,
      ...bindings,
    } as Bindings);
  return { request, fetch, get, idFromName };
};

describe("Thread terminal ingress", () => {
  it.each([
    [
      "malformed ThreadId",
      "/v1/threads/not-a-thread/terminal",
      {
        upgrade: "websocket",
        origin: "http://dx.test",
        "sec-websocket-protocol": "dx-terminal.v1",
      },
    ],
    [
      "missing Origin",
      `/v1/threads/${threadId}/terminal`,
      { upgrade: "websocket", "sec-websocket-protocol": "dx-terminal.v1" },
    ],
    [
      "wrong Origin",
      `/v1/threads/${threadId}/terminal`,
      {
        upgrade: "websocket",
        origin: "http://attacker.test",
        "sec-websocket-protocol": "dx-terminal.v1",
      },
    ],
    [
      "non-WebSocket",
      `/v1/threads/${threadId}/terminal`,
      {
        origin: "http://dx.test",
        "sec-websocket-protocol": "dx-terminal.v1",
      },
    ],
    [
      "missing subprotocol",
      `/v1/threads/${threadId}/terminal`,
      { upgrade: "websocket", origin: "http://dx.test" },
    ],
    [
      "wrong subprotocol",
      `/v1/threads/${threadId}/terminal`,
      {
        upgrade: "websocket",
        origin: "http://dx.test",
        "sec-websocket-protocol": "unknown.v1",
      },
    ],
  ])(
    "rejects %s before Durable Object lookup",
    async (_name, path, headers) => {
      const fixture = harness();
      expect((await fixture.request(path, headers)).status).toBe(404);
      expect(fixture.idFromName).not.toHaveBeenCalled();
      expect(fixture.get).not.toHaveBeenCalled();
      expect(fixture.fetch).not.toHaveBeenCalled();
    },
  );

  it("selects the local resident runtime before dispatch", async () => {
    const fixture = harness({ DX_RUNTIME_MODE: "local" });
    const response = await fixture.request(`/v1/threads/${threadId}/terminal`, {
      upgrade: "websocket",
      origin: "http://dx.test",
      "sec-websocket-protocol": "other.v1, dx-terminal.v1",
      authorization: "Bearer must-not-be-forwarded",
      cookie: "better-auth.session_token=must-not-be-forwarded",
      "x-dx-thread-id": "thr_00000000-0000-4000-8000-999999999999",
      "x-provider-secret": "must-not-be-added-by-server",
    });
    expect(response.status).toBe(200);
    expect(fixture.idFromName).toHaveBeenCalledWith(threadId);
    expect(fixture.get).toHaveBeenCalledOnce();
    const forwarded = fixture.fetch.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get("x-dx-thread-id")).toBe(threadId);
    expect(forwarded.headers.get("x-dx-request-id")).toMatch(
      /^[A-Za-z0-9._-]{1,128}$/,
    );
    expect(forwarded.headers.get("x-dx-started-at")).toMatch(/^\d{13}$/);
    expect(forwarded.headers.get("x-dx-authenticated-duration")).toMatch(
      /^\d+$/,
    );
    expect(forwarded.headers.get("x-dx-authorized-duration")).toMatch(/^\d+$/);
    expect(forwarded.headers.get("x-dx-admitted-duration")).toMatch(/^\d+$/);
    expect(forwarded.headers.get("x-dx-terminal-route")).toBe("resident");
    expect(forwarded.headers.get("sec-websocket-protocol")).toBe(
      "dx-terminal.v1",
    );
    expect(forwarded.headers.get("authorization")).toBeNull();
    expect(forwarded.headers.get("cookie")).toBeNull();
    expect(forwarded.headers.get("x-provider-secret")).toBeNull();
  });

  it("selects the deployed resident runtime before dispatch", async () => {
    const fixture = harness({ DX_RUNTIME_MODE: "deployed" });
    const response = await fixture.request(`/v1/threads/${threadId}/terminal`, {
      upgrade: "websocket",
      origin: "http://dx.test",
      "sec-websocket-protocol": "dx-terminal.v1",
    });
    expect(response.status).toBe(200);
    const forwarded = fixture.fetch.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get("x-dx-terminal-route")).toBe("resident");
  });

  it("never reconsiders a resident selection after a failed dispatch", async () => {
    const fixture = harness({ DX_RUNTIME_MODE: "deployed" });
    fixture.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));

    const response = await fixture.request(`/v1/threads/${threadId}/terminal`, {
      upgrade: "websocket",
      origin: "http://dx.test",
      "sec-websocket-protocol": "dx-terminal.v1",
    });

    expect(response.status).toBe(503);
    expect(fixture.fetch).toHaveBeenCalledOnce();
    const dispatched = fixture.fetch.mock.calls[0]?.[0] as Request;
    expect(dispatched.headers.get("x-dx-terminal-route")).toBe("resident");
  });

  it("fails closed on an absent runtime mode before dispatch", async () => {
    const fixture = harness();
    const response = await fixture.request(`/v1/threads/${threadId}/terminal`, {
      upgrade: "websocket",
      origin: "http://dx.test",
      "sec-websocket-protocol": "dx-terminal.v1",
    });
    expect(response.status).toBe(404);
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown runtime mode before dispatch", async () => {
    const fixture = harness({ DX_RUNTIME_MODE: "preview" });
    const response = await fixture.request(`/v1/threads/${threadId}/terminal`, {
      upgrade: "websocket",
      origin: "http://dx.test",
      "sec-websocket-protocol": "dx-terminal.v1",
    });
    expect(response.status).toBe(404);
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("rejects an absent Durable Object binding", async () => {
    const app = new Hono<AppEnv>().route("/v1/threads", threadTerminalRoutes);
    const response = await app.request(
      `/v1/threads/${threadId}/terminal`,
      {
        headers: {
          upgrade: "websocket",
          origin: "http://localhost",
          "sec-websocket-protocol": "dx-terminal.v1",
        },
      },
      { DX_RUNTIME_MODE: "local" } as Bindings,
    );
    expect(response.status).toBe(404);
  });
});
