import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In a Worker, a promise belongs to the request that created it: once that
// request ends, the promise never settles, and awaiting it from another
// request throws (#2486). A read that never answers stands in for it here.
const never = () => new Promise<never>(() => {});

const database = (all: () => Promise<{ results: unknown[] }>) => {
  const reads = vi.fn(all);
  const db = {
    prepare: () => ({ all: reads, bind: () => ({ first: async () => null }) }),
  } as unknown as D1Database;
  return { db, reads };
};

const answered = () => Promise.resolve({ results: [] });

const settlesWithin = async (promise: Promise<unknown>, ms = 200) =>
  Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

let live: typeof import("./live-catalog.js");

beforeEach(async () => {
  vi.resetModules();
  live = await import("./live-catalog.js");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadLiveCatalog", () => {
  it("does not wait on another request's read that never settles", async () => {
    const stuck = database(never);
    void live.loadLiveCatalog(stuck.db, 1_000);

    const fresh = database(answered);
    expect(await settlesWithin(live.loadLiveCatalog(fresh.db, 1_001))).toBe(
      true,
    );
    expect(live.liveCatalogLoaded()).toBe(true);
  });

  it("reads once per minute on a loaded isolate, even while a refresh is in flight", async () => {
    const first = database(answered);
    await live.loadLiveCatalog(first.db, 0);

    const refresh = database(never);
    void live.loadLiveCatalog(refresh.db, 61_000);
    const other = database(answered);
    expect(await settlesWithin(live.loadLiveCatalog(other.db, 61_001))).toBe(
      true,
    );
    expect(other.reads).not.toHaveBeenCalled();
  });

  it("refreshes again after a refresh that never settled", async () => {
    const first = database(answered);
    await live.loadLiveCatalog(first.db, 0);
    void live.loadLiveCatalog(database(never).db, 61_000);

    const later = database(answered);
    await live.loadLiveCatalog(later.db, 61_000 + 5 * 60_000);
    expect(later.reads).toHaveBeenCalledTimes(1);
  });
});
