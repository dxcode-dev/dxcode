import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../http/types.js";
import { refreshActiveThreadEnvironments } from "./refresh.js";

describe("active Thread environment refresh", () => {
  it.each([
    ["personal", "owner_user_id = ?"],
    ["project", "project_id = ?"],
    ["workspace", "member.organizationId = ?"],
  ] as const)("selects only active %s Threads", async (scope, clause) => {
    const fetch = vi.fn(
      async (_request: Request) => new Response(null, { status: 204 }),
    );
    const getByName = vi.fn((_id: string) => ({ fetch }));
    const all = vi.fn(async () => ({
      results: [{ id: "thread-one" }, { id: "thread-two" }],
    }));
    const bind = vi.fn((_id: string) => ({ all }));
    const prepare = vi.fn((_sql: string) => ({ bind }));
    const bindings = {
      THREAD_EXECUTION: { getByName } as unknown as DurableObjectNamespace,
    } satisfies Bindings;

    await refreshActiveThreadEnvironments(
      bindings,
      { prepare } as unknown as D1Database,
      { scope, id: "target-id" } as never,
    );

    expect(prepare.mock.calls[0]?.[0]).toContain(clause);
    expect(prepare.mock.calls[0]?.[0]).toContain("lifecycle_state = 'active'");
    expect(bind).toHaveBeenCalledWith("target-id", "", 100);
    expect(getByName.mock.calls.map(([id]) => id)).toEqual([
      "thread-one",
      "thread-two",
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [request] of fetch.mock.calls) {
      expect(request.method).toBe("POST");
      expect(request.headers.get("x-dx-environment-refresh")).toBe("1");
      expect(request.headers.get("x-dx-thread-id")).toMatch(/^thread-/);
    }
  });

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

  it("does nothing without the existing ThreadExecution namespace", async () => {
    const prepare = vi.fn();
    await refreshActiveThreadEnvironments(
      {},
      { prepare } as unknown as D1Database,
      { scope: "personal", id: "owner" } as never,
    );
    expect(prepare).not.toHaveBeenCalled();
  });
});
