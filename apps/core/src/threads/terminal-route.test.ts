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

describe("Thread terminal sessions", () => {
  const attachHeaders = {
    upgrade: "websocket",
    origin: "http://dx.test",
    "sec-websocket-protocol": "dx-terminal.v1",
  };

  it("names the Terminal a browser attaches to, default when unnamed", async () => {
    const fixture = harness();
    await fixture.request(`/v1/threads/${threadId}/terminal`, attachHeaders);
    await fixture.request(
      `/v1/threads/${threadId}/terminal?terminal=3`,
      attachHeaders,
    );
    expect(
      fixture.fetch.mock.calls.map(([request]) =>
        request.headers.get("x-dx-terminal-id"),
      ),
    ).toEqual(["default", "3"]);
  });

  it.each(["0", "03", "1001", "main", "default2"])(
    "rejects Terminal %s before Durable Object lookup",
    async (terminal) => {
      const fixture = harness();
      const response = await fixture.request(
        `/v1/threads/${threadId}/terminal?terminal=${terminal}`,
        attachHeaders,
      );
      expect(response.status).toBe(404);
      expect(fixture.fetch).not.toHaveBeenCalled();
    },
  );

  const close = (
    fixture: ReturnType<typeof harness>,
    body: unknown,
    origin = "http://dx.test",
  ) =>
    new Hono<AppEnv>().route("/v1/threads", threadTerminalRoutes).request(
      `http://dx.test/v1/threads/${threadId}/terminal/close`,
      {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      {
        THREAD_EXECUTION: {
          idFromName: fixture.idFromName,
          get: fixture.get,
        } as unknown as DurableObjectNamespace,
        DX_RUNTIME_MODE: "deployed",
      } as Bindings,
    );

  it("asks the Thread's execution object to end a closed Terminal", async () => {
    const fixture = harness();
    fixture.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const response = await close(fixture, { terminal: "4" });
    expect(response.status).toBe(204);
    const [url, init] = (fixture.fetch.mock.calls.at(-1) ?? []) as unknown as [
      string,
      RequestInit,
    ];
    expect(new URL(url).pathname).toBe("/terminal/close");
    const headers = new Headers(init.headers);
    expect(headers.get("x-dx-terminal-id")).toBe("4");
    expect(headers.get("x-dx-thread-id")).toBe(threadId);
  });

  it.each([
    ["the first Terminal", { terminal: "default" }, 400],
    ["an invalid Terminal", { terminal: "0" }, 400],
    ["a missing Terminal", {}, 400],
  ])("refuses to close %s", async (_name, body, status) => {
    const fixture = harness();
    expect((await close(fixture, body)).status).toBe(status);
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("refuses a close from another origin", async () => {
    const fixture = harness();
    expect(
      (await close(fixture, { terminal: "2" }, "https://evil.test")).status,
    ).toBe(404);
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
});
