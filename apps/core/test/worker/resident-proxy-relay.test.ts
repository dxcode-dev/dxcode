import { describe, expect, it } from "vitest";
import {
  MAX_ANONYMOUS_STREAMS,
  type ProxyBrowserAttachment,
  type ProxyPublicLink,
  proxyFailureReason,
  ResidentProxyRelay,
} from "../../src/threads/resident-proxy-relay.js";

/**
 * #2397: a visitor of a public Portal holds a stream for as long as their
 * browser reads its response. Ways this could fail: anonymous streams fill
 * the Thread's whole budget, so the owner's Portals and Desktop get
 * `too-many-streams`; or the anonymous cap also limits signed-in callers.
 */
const relayWithSilentDaemon = () => {
  const opened: string[] = [];
  const socket = {
    send: (frame: string) => opened.push(frame),
  } as unknown as WebSocket;
  const relay = new ResidentProxyRelay({
    daemon: () => ({ socket, nonce: "daemon" }),
    acceptBrowser: () => undefined,
    browsers: () => [],
    activity: () => undefined,
  });
  // The guest never answers, so every stream stays open.
  const open = (anonymous: boolean) =>
    Promise.race([
      relay.http({
        port: 5173,
        target: "/slow",
        method: "GET",
        headers: [["Host", "localhost:5173"]],
        body: null,
        wake: false,
        anonymous,
      }),
      new Promise<"open">((resolve) => setTimeout(() => resolve("open"), 5)),
    ]);
  return { relay, opened, open };
};

describe("Resident proxy stream budget", () => {
  it("keeps headroom for signed-in callers when anonymous visitors hold their share", async () => {
    const { relay, opened, open } = relayWithSilentDaemon();
    for (let index = 0; index < MAX_ANONYMOUS_STREAMS; index++)
      expect(await open(true)).toBe("open");

    const refused = await open(true);
    expect(refused).not.toBe("open");
    expect(proxyFailureReason(refused as Response)).toBe("too-many-streams");
    expect(opened).toHaveLength(MAX_ANONYMOUS_STREAMS);

    // The owner's Portals and Desktop still open streams, up to the
    // Thread's whole budget.
    let signedIn = 0;
    for (;;) {
      const outcome = await open(false);
      if (outcome !== "open") {
        expect(proxyFailureReason(outcome)).toBe("too-many-streams");
        break;
      }
      signedIn++;
    }
    expect(signedIn).toBeGreaterThan(0);
    expect(relay.size).toBe(MAX_ANONYMOUS_STREAMS + signedIn);
    expect(relay.size).toBe(96);
    relay.daemonUnavailable();
  });
});

/**
 * #2634: dxd forwards a guest app's own close codes, and the web app signs
 * out on 4401 (the code Core uses when a browser session ends). A guest's
 * 4401 must reach the browser as another code; every other code passes.
 */
describe("Resident proxy close codes", () => {
  it("never passes a guest's session-ended code to the browser", () => {
    const closed: Array<readonly [number, string]> = [];
    const daemon = { send: () => undefined } as unknown as WebSocket;
    const browser = {
      close: (code: number, reason: string) => closed.push([code, reason]),
    } as unknown as WebSocket;
    const relay = new ResidentProxyRelay({
      daemon: () => ({ socket: daemon, nonce: "daemon" }),
      acceptBrowser: () => undefined,
      browsers: () => [browser],
      activity: () => undefined,
    });
    for (const [streamId, code] of [
      [1, 4401],
      [2, 4000],
      [3, 1000],
      [4, 1006],
    ] as const)
      relay.receiveDaemonMessage(daemon, {
        type: "proxy.closed",
        streamId,
        code,
        reason: "bye",
      });
    expect(closed).toEqual([
      [1011, "bye"],
      [4000, "bye"],
      [1000, "bye"],
      [1000, "bye"],
    ]);
  });
});

/**
 * #2670: an accepted proxied WebSocket is a tagged browser socket, no longer
 * a stream in memory, but dxd still holds it against its 128. Ways this
 * could fail: accepted sockets stop counting, so anonymous visitors fill
 * dxd and the owner's Portals get 503; a revoked or expired public link
 * leaves a visitor's socket, and its guest end, open.
 */
const relayWithAcceptingDaemon = () => {
  const sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  const browsers: Array<{
    readonly attachment: ProxyBrowserAttachment;
    readonly closed: Array<readonly [number, string]>;
    readonly socket: WebSocket;
  }> = [];
  let relay: ResidentProxyRelay;
  const daemon = {
    send: (frame: string | ArrayBuffer | ArrayBufferView) => {
      sent.push(frame);
      if (typeof frame !== "string") return;
      const message = JSON.parse(frame) as { type: string; streamId: number };
      // The guest accepts every WebSocket.
      if (message.type === "proxy.open")
        queueMicrotask(() =>
          relay.receiveDaemonMessage(daemon, {
            type: "proxy.accepted",
            streamId: message.streamId,
            protocol: null,
          }),
        );
    },
  } as unknown as WebSocket;
  relay = new ResidentProxyRelay({
    daemon: () => ({ socket: daemon, nonce: "daemon" }),
    acceptBrowser: (_server, attachment) => {
      const closed: Array<readonly [number, string]> = [];
      const entry = {
        attachment,
        closed,
        socket: {
          deserializeAttachment: () => attachment,
          close: (code: number, reason: string) => {
            closed.push([code, reason]);
            // A closed socket leaves the object's list.
            browsers.splice(browsers.indexOf(entry), 1);
          },
          send: () => undefined,
        } as unknown as WebSocket,
      };
      browsers.push(entry);
    },
    browsers: (streamId) =>
      browsers
        .filter(
          (entry) =>
            streamId === undefined || entry.attachment.streamId === streamId,
        )
        .map(({ socket }) => socket),
    activity: () => undefined,
  });
  const open = (anonymous: boolean, publicLink?: ProxyPublicLink) =>
    relay.websocket({
      port: publicLink?.port ?? 5173,
      target: "/hmr",
      headers: [["Host", "localhost:5173"]],
      protocols: [],
      wake: false,
      anonymous,
      ...(publicLink === undefined ? {} : { publicLink }),
    });
  const closes = () =>
    sent
      .filter((frame): frame is string => typeof frame === "string")
      .map((frame) => JSON.parse(frame) as { type: string; streamId: number })
      .filter(({ type }) => type === "proxy.close");
  return { relay, browsers, open, closes, sent };
};

const link = (port: number, expiresAt = Date.now() + 3_600_000) => ({
  port,
  id: `link-${port}`,
  expiresAt,
});

describe("Resident proxy accepted WebSockets (#2670)", () => {
  it("counts accepted WebSockets against the stream budget until they close", async () => {
    const { browsers, open } = relayWithAcceptingDaemon();
    // An anonymous visitor opens far more hot-reload sockets than its share.
    const anonymous = [];
    for (let index = 0; index < MAX_ANONYMOUS_STREAMS + 10; index++)
      anonymous.push(await open(true, link(3000)));
    expect(anonymous.filter(({ status }) => status === 101)).toHaveLength(
      MAX_ANONYMOUS_STREAMS,
    );
    expect(proxyFailureReason(anonymous.at(-1) as Response)).toBe(
      "too-many-streams",
    );

    // The owner still opens sockets, up to the Thread's whole budget, never
    // past what dxd holds.
    let signedIn = 0;
    for (;;) {
      const response = await open(false);
      if (response.status !== 101) {
        expect(proxyFailureReason(response)).toBe("too-many-streams");
        break;
      }
      signedIn++;
    }
    expect(browsers).toHaveLength(96);
    expect(signedIn).toBe(96 - MAX_ANONYMOUS_STREAMS);

    // A socket that closes frees its place.
    browsers[0]?.socket.close(1000, "");
    expect((await open(false)).status).toBe(101);
  });

  it("closes a visitor's sockets, and their guest ends, when the public link is revoked", async () => {
    const { relay, browsers, open, closes } = relayWithAcceptingDaemon();
    expect((await open(true, link(3000))).status).toBe(101);
    expect((await open(true, link(4000))).status).toBe(101);
    expect((await open(false)).status).toBe(101);
    const [revoked, other, member] = [...browsers];

    relay.closePublic(3000);

    expect(revoked?.closed).toEqual([[1008, "Public link revoked"]]);
    expect(other?.closed).toEqual([]);
    expect(member?.closed).toEqual([]);
    expect(closes().map(({ streamId }) => streamId)).toEqual([
      revoked?.attachment.streamId,
    ]);
  });

  it("closes a visitor's socket once its public link expires, without relaying past it", async () => {
    const { relay, browsers, open, closes, sent } = relayWithAcceptingDaemon();
    expect((await open(true, link(3000, Date.now() - 1))).status).toBe(101);
    const [expired] = [...browsers];
    if (expired === undefined) throw new Error("no socket");
    const before = sent.length;

    relay.receiveBrowser(expired.socket, expired.attachment, "still here");

    expect(expired.closed).toEqual([[1008, "Public link expired"]]);
    // Only the close reached the guest, never the visitor's message.
    expect(sent.slice(before).every((frame) => typeof frame === "string")).toBe(
      true,
    );
    expect(closes().map(({ streamId }) => streamId)).toEqual([
      expired.attachment.streamId,
    ]);
  });
});
