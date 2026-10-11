import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv, Bindings } from "../http/types.js";
import { threadTerminalRoutes } from "./terminal-route.js";

const threadId = "thr_00000000-0000-4000-8000-000000000183";

const harness = () => {
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
      DX_RUNTIME_MODE: "deployed",
    } as Bindings);
  return { request, fetch, get, idFromName };
};

describe("Thread terminal ingress", () => {
  it.each([
    ["missing subprotocol", { upgrade: "websocket", origin: "http://dx.test" }],
    [
      "wrong subprotocol",
      {
        upgrade: "websocket",
        origin: "http://dx.test",
        "sec-websocket-protocol": "unknown.v1",
      },
    ],
  ])("rejects %s before Durable Object lookup", async (_name, headers) => {
    const fixture = harness();
    expect(
      (await fixture.request(`/v1/threads/${threadId}/terminal`, headers))
        .status,
    ).toBe(404);
    expect(fixture.idFromName).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
});
