import { describe, expect, it, vi } from "vitest";
import { accountOrbContainer } from "./account-orb-client.js";

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
      // Core's own open bound (`CLOUDFLARE_OPEN_TIMEOUT_MS`) is 180 s.
      await vi.advanceTimersByTimeAsync(181_000);
      expect(await statused).toBeInstanceOf(Error);
      expect(await opened).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });
});
