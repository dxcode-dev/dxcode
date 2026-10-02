import { ListThreadsResponseSchema } from "@dx/api";
import type { QueryClient } from "@tanstack/react-query";
import { DateTime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createQueryClient } from "./query-client.js";
import { shareEqualData } from "./structural-sharing.js";

const threadJson = (title: string, activityStatus = "idle") => ({
  id: "thr_00000000-0000-4000-8000-000000000147",
  title,
  projectId: "prj_00000000-0000-4000-8000-000000000147",
  visibility: "private",
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  lastActivityAt: "2026-10-01T10:00:00.000Z",
  activityStatus,
  lifecycleState: "active",
  agentUrl: "/v1/agents/dx/thr_00000000-0000-4000-8000-000000000147",
  mode: "medium",
});
const decodePage = (items: unknown[]) =>
  Schema.decodeUnknownSync(ListThreadsResponseSchema)({
    status: "success",
    data: { items },
  }).data;

describe("shareEqualData", () => {
  it("keeps every previous object when a decoded refetch is unchanged", () => {
    const previous = decodePage([threadJson("One"), threadJson("Two")]);
    const next = decodePage([threadJson("One"), threadJson("Two")]);
    expect(next.items[0]?.createdAt).not.toBe(previous.items[0]?.createdAt);
    expect(shareEqualData(previous, next)).toBe(previous);
  });

  it("replaces only the item that changed", () => {
    const previous = decodePage([threadJson("One"), threadJson("Two")]);
    const shared = shareEqualData(
      previous,
      decodePage([threadJson("One"), threadJson("Two", "working")]),
    );
    expect(shared).not.toBe(previous);
    expect(shared.items[0]).toBe(previous.items[0]);
    expect(shared.items[1]).not.toBe(previous.items[1]);
    expect(shared.items[1]?.activityStatus).toBe("working");
    // The unchanged timestamp inside the changed item is still reused.
    expect(shared.items[1]?.createdAt).toBe(previous.items[1]?.createdAt);
  });

  it("treats a different DateTime, length, or key set as a change", () => {
    const at = DateTime.makeUnsafe("2026-10-01T10:00:00.000Z");
    const later = DateTime.makeUnsafe("2026-10-01T10:00:01.000Z");
    expect(shareEqualData({ at }, { at: later }).at).toBe(later);
    const list = [1, 2];
    expect(shareEqualData(list, [1, 2, 3])).toEqual([1, 2, 3]);
    expect(shareEqualData({ a: 1 }, { b: 1 })).toEqual({ b: 1 });
    expect(shareEqualData({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 });
  });

  it("keeps an own __proto__ key from decoded JSON as data", () => {
    const previous = JSON.parse(
      '{"properties":{"__proto__":{"type":"string"},"a":1}}',
    );
    const next = JSON.parse(
      '{"properties":{"__proto__":{"type":"number"},"a":1}}',
    );
    const shared = shareEqualData(previous, next);
    expect(Object.hasOwn(shared.properties, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(shared.properties)).toBe(Object.prototype);
    expect(
      Object.getOwnPropertyDescriptor(shared.properties, "__proto__")?.value,
    ).toEqual({ type: "number" });
    expect(shared.properties.a).toBe(1);
  });

  it("is the default for application queries", async () => {
    const client: QueryClient = createQueryClient();
    const key = ["threads"];
    let response = decodePage([threadJson("One")]);
    const refetch = async () => {
      await client.fetchQuery({
        queryKey: key,
        queryFn: () => response,
        staleTime: 0,
      });
      return client.getQueryData(key);
    };
    const first = await refetch();
    response = decodePage([threadJson("One")]);
    expect(await refetch()).toBe(first);
  });
});
