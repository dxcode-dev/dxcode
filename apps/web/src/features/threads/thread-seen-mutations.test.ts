import type { ThreadId, UserId } from "@dx/domain";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { threadKeys } from "./thread-queries.js";
import { openThreadSeen } from "./thread-seen-mutations.js";

// Opening a Thread no list holds yet, such as a URL loaded fresh. Ways it
// could go wrong: it is marked seen before anything says it exists, so a
// hidden or unknown Thread gets a `seen` write; or a Thread that does load
// is never marked seen.

const userId = "usr_seen" as UserId;
const threadId = "thr_00000000-0000-4000-8000-0000000000b7" as ThreadId;

const seenWrites = () => {
  const writes: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    writes.push(`${init?.method ?? "GET"} ${String(input)}`);
    return Response.json({ status: "success", data: {} });
  });
  return writes;
};

afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("openThreadSeen for a Thread no list holds", () => {
  it("marks it seen once it loads", async () => {
    const writes = seenWrites();
    const client = new QueryClient();
    openThreadSeen(client, userId, threadId);
    await flush();
    expect(writes).toEqual([]);
    client.setQueryData(threadKeys.detail(userId, threadId), { id: threadId });
    await flush();
    expect(writes).toEqual([`POST /v1/threads/${threadId}/seen`]);
  });

  it("never marks one that does not load", async () => {
    const writes = seenWrites();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    openThreadSeen(client, userId, threadId);
    await client
      .prefetchQuery({
        queryKey: threadKeys.detail(userId, threadId),
        queryFn: () => Promise.reject(new Error("Thread not found.")),
      })
      .catch(() => undefined);
    // Loading it later, such as after Spaces is switched on, marks nothing.
    client.setQueryData(threadKeys.detail(userId, threadId), { id: threadId });
    await flush();
    expect(writes).toEqual([]);
  });
});
