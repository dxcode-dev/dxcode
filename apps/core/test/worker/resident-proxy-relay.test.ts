import { describe, expect, it } from "vitest";
import {
  MAX_ANONYMOUS_STREAMS,
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
