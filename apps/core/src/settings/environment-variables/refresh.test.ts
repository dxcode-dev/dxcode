import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../http/types.js";
import { refreshActiveThreadEnvironments } from "./refresh.js";

describe("active Thread environment refresh", () => {
  it("pages active Threads and settles refreshes in bounded batches", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `thread-${String(index).padStart(3, "0")}`,
    }));
    const all = vi
      .fn()
      .mockResolvedValueOnce({ results: firstPage })
      .mockResolvedValueOnce({ results: [{ id: "thread-100" }] });
    const bind = vi.fn(() => ({ all }));
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const bindings = {
      THREAD_EXECUTION: {
        getByName: vi.fn(() => ({ fetch })),
      } as unknown as DurableObjectNamespace,
    } satisfies Bindings;

    await refreshActiveThreadEnvironments(
      bindings,
      { prepare: vi.fn(() => ({ bind })) } as unknown as D1Database,
      { scope: "personal", id: "owner" } as never,
    );

    expect(bind).toHaveBeenNthCalledWith(1, "owner", "", 100);
    expect(bind).toHaveBeenNthCalledWith(2, "owner", "thread-099", 100);
    expect(fetch).toHaveBeenCalledTimes(101);
  });
});
