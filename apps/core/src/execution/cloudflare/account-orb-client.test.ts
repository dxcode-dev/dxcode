import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_ORB_MAX_REPLY_BYTES,
  accountOrbContainer,
  accountOrbHealth,
} from "./account-orb-client.js";
import { encodeRpcValue } from "./account-orb-protocol.js";

/**
 * A person's own Cloudflare account reaches its Orb container object
 * through its account Orb Worker. A fresh start there may take as long as on
 * dx's own account (a retried cold start, #1783), so the call must not give
 * up before Core's own open bound does.
 */
const answeringAfter = (delayMs: number) =>
  vi.fn(
    (_url: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        if (delayMs === Number.POSITIVE_INFINITY) {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
          return;
        }
        const timer = setTimeout(
          () =>
            resolve(
              Response.json({
                result: { kind: "ready", sandboxId: "a", residency: "created" },
              }),
            ),
          delayMs,
        );
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        });
      }),
  );

describe("account Orb client", () => {
  it("waits for an open as long as Core does, so a retried cold start answers", async () => {
    vi.useFakeTimers();
    try {
      const fetch = answeringAfter(155_000);
      const orb = accountOrbContainer({
        endpoint: "https://orb.example.workers.dev",
        secret: "s",
        threadId: "thr_1",
        fetch: fetch as unknown as typeof globalThis.fetch,
      });
      const opened = orb
        .open({ create: true, instance: "standard-2", idleMs: 300_000 })
        .catch((cause: unknown) => cause);
      await vi.advanceTimersByTimeAsync(155_000);
      await expect(opened).resolves.toMatchObject({ kind: "ready" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still gives up on a call that never answers", async () => {
    vi.useFakeTimers();
    try {
      const orb = accountOrbContainer({
        endpoint: "https://orb.example.workers.dev",
        secret: "s",
        threadId: "thr_1",
        fetch: answeringAfter(
          Number.POSITIVE_INFINITY,
        ) as unknown as typeof globalThis.fetch,
      });
      const statused = orb.status().catch((cause: unknown) => cause);
      const opened = orb
        .open({ create: true, instance: "standard-2", idleMs: 300_000 })
        .catch((cause: unknown) => cause);
      // Core's own open bound (`CLOUDFLARE_OPEN_TIMEOUT_MS`) is 330 s.
      await vi.advanceTimersByTimeAsync(331_000);
      expect(await statused).toBeInstanceOf(Error);
      expect(await opened).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  // #2390. The account Orb Worker runs in the person's own Cloudflare
  // account, so its replies are theirs to shape, and Core reads them in an
  // isolate other people's requests share. Ways this could fail: a reply
  // with no length streams in until the isolate runs out of memory; a
  // declared length over the cap is read anyway; the cap refuses the
  // largest reply the real object sends (a 16 MiB file as base64).
  const answering = (body: BodyInit, init?: ResponseInit) =>
    vi.fn(async () => new Response(body, init));
  const orbWith = (fetch: unknown) =>
    accountOrbContainer({
      endpoint: "https://orb.example.workers.dev",
      secret: "s",
      threadId: "thr_1",
      fetch: fetch as typeof globalThis.fetch,
    });

  it("stops reading a reply with no length once it passes the cap (#2390)", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const failure = await orbWith(answering(endless))
      .status()
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("larger than");
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThanOrEqual(
      ACCOUNT_ORB_MAX_REPLY_BYTES + 2 * chunk.byteLength,
    );
  });

  it("refuses a reply whose declared length is over the cap without reading it (#2390)", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      orbWith(
        answering(body, {
          headers: {
            "content-length": String(ACCOUNT_ORB_MAX_REPLY_BYTES + 1),
          },
        }),
      ).status(),
    ).rejects.toThrow("larger than");
    expect(pulled).toBe(false);
  });

  it("still reads the largest file the object returns, 16 MiB as base64 (#2390)", async () => {
    const file = new Uint8Array(16 * 1024 * 1024).fill(7);
    const orb = orbWith(
      answering(JSON.stringify({ result: encodeRpcValue(file) })),
    );
    const read = await orb.readFile("/home/user/big.bin");
    expect(read.byteLength).toBe(file.byteLength);
    expect(read[read.byteLength - 1]).toBe(7);
  });

  it("still surfaces the Worker's error message and health answer (#2390)", async () => {
    await expect(
      orbWith(
        answering(JSON.stringify({ error: "Orb is busy." }), { status: 503 }),
      ).status(),
    ).rejects.toThrow("Orb is busy.");
    const health = (body: BodyInit) =>
      accountOrbHealth({
        endpoint: "https://orb.example.workers.dev",
        secret: "s",
        recipe: "r1",
        fetch: answering(body) as unknown as typeof globalThis.fetch,
      });
    await expect(health(JSON.stringify({ recipe: "r1" }))).resolves.toBe(true);
    await expect(health(" ".repeat(128 * 1024))).resolves.toBe(false);
  });
});
