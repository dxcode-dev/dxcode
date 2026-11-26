import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv, Bindings } from "../http/types.js";
import daemonIngressWorker, {
  MAX_PLUGIN_DRAFT_BODY_BYTES,
} from "./daemon-ingress.js";
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

  // #2399. Any key of the right shape and any well-formed Thread ID reach
  // the plugin draft forwarder, so it must not read the body: only the
  // Thread execution object knows whether the key is this Thread's. Ways
  // this could fail: the ingress buffers the body before the key is
  // checked; a body that declares more than the cap still wakes the object;
  // the forwarded body arrives altered for a key that checks out.
  describe("plugin draft", () => {
    const key = "Bearer dxd_not-this-threads-key-0123456789";
    const post = (
      namespace: DurableObjectNamespace,
      body: ReadableStream<Uint8Array>,
      headers: Record<string, string> = {},
    ) =>
      new Hono<AppEnv>().route("/v1", threadDaemonRoutes).request(
        `https://dx.test/v1/dxd/${threadId}/plugin-draft`,
        {
          method: "POST",
          headers: { authorization: key, ...headers },
          body,
          duplex: "half",
        } as RequestInit,
        { THREAD_EXECUTION: namespace } as Bindings,
      );
    /** A body that counts the bytes the server pulls, sent in 64 KiB chunks. */
    const counted = (totalBytes: number, fill = 0x20) => {
      const chunk = new Uint8Array(64 * 1024).fill(fill);
      const read = { bytes: 0 };
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (read.bytes >= totalBytes) return controller.close();
            read.bytes += chunk.byteLength;
            controller.enqueue(chunk);
          },
        },
        { highWaterMark: 0 },
      );
      return { stream, read };
    };

    it("leaves the body unread until the Thread execution object checks the key (#2399)", async () => {
      // The object refuses the key, as it does for any other Thread's.
      const fetch = vi.fn(
        async (_request: Request) => new Response(null, { status: 401 }),
      );
      const namespace = {
        idFromName: vi.fn(() => ({})),
        get: vi.fn(() => ({ fetch })),
      } as unknown as DurableObjectNamespace;
      const body = counted(MAX_PLUGIN_DRAFT_BODY_BYTES);
      const response = await post(namespace, body.stream);
      expect(response.status).toBe(401);
      expect(fetch).toHaveBeenCalledOnce();
      expect(body.read.bytes).toBe(0);
    });

    it("refuses a declared length over the cap without waking the object (#2399)", async () => {
      const fixture = harness();
      const body = counted(1024);
      const response = await post(
        { idFromName: fixture.idFromName, get: fixture.get } as never,
        body.stream,
        { "content-length": String(MAX_PLUGIN_DRAFT_BODY_BYTES + 1) },
      );
      expect(response.status).toBe(413);
      expect(fixture.idFromName).not.toHaveBeenCalled();
      expect(body.read.bytes).toBe(0);
    });

    it("forwards the body whole to the object (#2399)", async () => {
      const fetch = vi.fn(
        async (request: Request) =>
          new Response(String((await request.arrayBuffer()).byteLength)),
      );
      const namespace = {
        idFromName: vi.fn(() => ({})),
        get: vi.fn(() => ({ fetch })),
      } as unknown as DurableObjectNamespace;
      const body = counted(512 * 1024, 0x41);
      const response = await post(namespace, body.stream);
      expect(await response.text()).toBe(String(512 * 1024));
      const forwarded = fetch.mock.calls[0]?.[0];
      expect(new URL(forwarded?.url ?? "").pathname).toBe(
        "/daemon/plugin-draft",
      );
      expect(forwarded?.headers.get("x-dx-daemon-ingress")).toBe("1");
      expect(forwarded?.headers.get("x-dx-thread-id")).toBe(threadId);
    });
  });
});
