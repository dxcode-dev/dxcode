import type { ThreadId, UserId } from "@dx/domain";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spaceKeys } from "../spaces/space-cache-queries.js";
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

// Opening a thread a Space started, from the Space's Threads tab or at its
// own URL. Ways it could go wrong: the Space's list keeps its dot because
// only the sidebar's lists are cleared; the thread is never marked seen
// because the page already holds its detail (the Space showed it, or a
// hover preloaded it) and that is taken to mean it was seen; or one the
// Space lists as read is marked again.
describe("openThreadSeen for a thread a Space started", () => {
  const spaceThreadId = "thr_00000000-0000-4000-8000-0000000000a1" as ThreadId;
  const spaceRow = (unread: boolean) => ({
    id: threadId,
    title: "Fix the dot",
    parentThreadId: spaceThreadId,
    ...(unread ? { unread: true } : {}),
  });

  it("marks it seen and clears the Space's dot, though its detail is loaded", async () => {
    const writes = seenWrites();
    const client = new QueryClient();
    client.setQueryData(spaceKeys.threads(userId, spaceThreadId), [
      spaceRow(true),
    ]);
    client.setQueryData(threadKeys.detail(userId, threadId), { id: threadId });
    openThreadSeen(client, userId, threadId);
    await flush();
    expect(writes).toEqual([`POST /v1/threads/${threadId}/seen`]);
    expect(
      client.getQueryData<ReadonlyArray<{ unread?: boolean }>>(
        spaceKeys.threads(userId, spaceThreadId),
      )?.[0]?.unread,
    ).toBeUndefined();
  });

  it("does not mark one the Space lists as read", async () => {
    const writes = seenWrites();
    const client = new QueryClient();
    client.setQueryData(spaceKeys.threads(userId, spaceThreadId), [
      spaceRow(false),
    ]);
    openThreadSeen(client, userId, threadId);
    await flush();
    expect(writes).toEqual([]);
  });
});

describe("openThreadSeen for a Thread no list holds but the page loaded", () => {
  it("still marks it seen", async () => {
    const writes = seenWrites();
    const client = new QueryClient();
    client.setQueryData(threadKeys.detail(userId, threadId), { id: threadId });
    openThreadSeen(client, userId, threadId);
    await flush();
    expect(writes).toEqual([`POST /v1/threads/${threadId}/seen`]);
  });
});
