import { describe, expect, it, vi } from "vitest";

/**
 * The Orb usage batch under interleaving. Ways it could fail:
 * - a write that fails puts its buckets back over calls recorded while it
 *   was in flight, losing them;
 * - a record that read the batch before a flush swapped it out writes the
 *   old batch back, so its calls are written twice;
 * - a failed bucket is lost, or counted twice once the retry succeeds.
 */

const writes: Array<{ requests: number; unitsMs: number }> = [];
let failNext = 0;
let release: (() => void) | undefined;
vi.mock("../usage.js", () => ({
  recordPluginHostUsage: async (
    _db: unknown,
    usage: { requests: number; unitsMs: number },
  ) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    if (failNext > 0) {
      failNext -= 1;
      throw new Error("D1 is down");
    }
    writes.push({ requests: usage.requests, unitsMs: usage.unitsMs });
  },
}));

const { OrbUsageBatch } = await import("./usage-batch.js");

const billing = {
  pluginId: "plg_1",
  pluginName: "p",
  scope: "personal" as const,
  ownerUserId: "u",
};

const setup = () => {
  const stored = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => structuredClone(stored.get(key)),
    put: async (key: string, value: unknown) => {
      stored.set(key, structuredClone(value));
    },
  } as unknown as DurableObjectStorage;
  const pending: Array<Promise<unknown>> = [];
  const batch = new OrbUsageBatch({
    storage,
    db: () => ({}) as D1Database,
    waitUntil: (promise) => pending.push(promise),
  });
  const settle = async () => {
    for (let round = 0; round < 50; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      release?.();
      release = undefined;
    }
    await Promise.all(pending);
  };
  return { batch, settle, stored };
};

describe("OrbUsageBatch", () => {
  it("keeps calls recorded while a failing write is in flight", async () => {
    writes.length = 0;
    failNext = 1;
    const { batch, settle } = setup();
    batch.record(billing, "success", 0, 100);
    batch.record(billing, "success", 100, 300);
    const flushing = batch.flush("minute");
    // Recorded while the write is pending; that write then fails.
    batch.record(billing, "success", 300, 350);
    await settle();
    await flushing;
    expect(writes).toEqual([]);
    const retried = batch.flush("stopped");
    await settle();
    await retried;
    // Every call is written exactly once: 3 calls, 350 ms.
    expect(writes).toEqual([{ requests: 3, unitsMs: 350 }]);
  });

  it("never writes a call twice when a record and a flush interleave", async () => {
    writes.length = 0;
    failNext = 0;
    const { batch, settle } = setup();
    batch.record(billing, "success", 0, 10);
    const first = batch.flush("minute");
    batch.record(billing, "success", 10, 30);
    await settle();
    await first;
    const second = batch.flush("stopped");
    await settle();
    await second;
    expect(writes).toEqual([
      { requests: 1, unitsMs: 10 },
      { requests: 1, unitsMs: 20 },
    ]);
  });
});
