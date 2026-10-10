// @vitest-environment happy-dom

import { ThreadId, UserId } from "@dx/domain";
import { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changesKeys } from "../changes/changes-queries.js";
import { threadFilesKeys } from "../files/files-queries.js";
import { threadKeys } from "../thread-queries.js";
import { RealtimeClient } from "./realtime-client.js";

class FakeSocket {
  readonly readyState = WebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: string[] = [];
  readonly close = vi.fn(() => undefined);

  send(data: string) {
    this.sent.push(data);
  }

  receive(value: unknown) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }
}

const userId = Schema.decodeUnknownSync(UserId)(
  "usr_00000000-0000-4000-8000-000000000001",
);
const threadId = Schema.decodeUnknownSync(ThreadId)(
  "thr_00000000-0000-4000-8000-000000000001",
);

afterEach(() => vi.useRealTimers());

describe("RealtimeClient", () => {
  it("uses one socket and invalidates existing Thread, readiness, and Changes queries", () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const sockets: FakeSocket[] = [];
    const client = new RealtimeClient(queryClient, userId, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });

    client.start();
    client.start();
    expect(sockets).toHaveLength(1);
    sockets[0]?.receive({ type: "ready", revision: 0 });
    sockets[0]?.receive({
      type: "thread.invalidated",
      threadId,
      revision: 1,
    });
    sockets[0]?.receive({
      type: "readiness.invalidated",
      threadId,
      revision: 2,
    });
    sockets[0]?.receive({
      type: "changes.invalidated",
      threadId,
      revision: 3,
    });

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: threadKeys.lists(userId),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: threadKeys.detail(userId, threadId),
    });
    expect(invalidate).toHaveBeenCalledWith(
      { queryKey: changesKeys.ranges(threadId) },
      { cancelRefetch: false },
    );
    expect(invalidate).toHaveBeenCalledWith(
      { queryKey: [...threadFilesKeys.all(threadId), "tree"] },
      { cancelRefetch: false },
    );
    client.stop();
  });

  it("invalidates all realtime-backed queries and reconnects after a local gap", () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const sockets: FakeSocket[] = [];
    const client = new RealtimeClient(queryClient, userId, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    client.start();
    sockets[0]?.receive({ type: "ready", revision: 4 });
    sockets[0]?.receive({
      type: "thread.invalidated",
      threadId,
      revision: 6,
    });

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: threadKeys.all(userId),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["thread-changes"] });
    expect(sockets[0]?.close).toHaveBeenCalledWith(4009, "revision-gap");
    sockets[0]?.onclose?.(new CloseEvent("close"));
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]).toBeDefined();
    client.stop();
  });

  it("refreshes sidebar summaries when Changes are invalidated", () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const socket = new FakeSocket();
    const client = new RealtimeClient(queryClient, userId, () => socket);
    client.start();
    socket.receive({ type: "ready", revision: 0 });
    socket.receive({
      type: "changes.invalidated",
      threadId,
      revision: 1,
    });

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: threadKeys.lists(userId),
    });
    expect(invalidate).toHaveBeenCalledWith(
      { queryKey: changesKeys.ranges(threadId) },
      { cancelRefetch: false },
    );
    client.stop();
  });

  it("exposes cold workspace wake status until the workspace is ready", () => {
    const socket = new FakeSocket();
    const client = new RealtimeClient(new QueryClient(), userId, () => socket);
    const listener = vi.fn();
    const unsubscribe = client.observeWorkspaceStatus(threadId, listener);
    client.start();
    socket.receive({ type: "ready", revision: 0 });

    socket.receive({
      type: "workspace.status",
      threadId,
      status: "waking",
      revision: 1,
    });
    expect(client.workspaceStatus(threadId)).toBe("waking");

    socket.receive({
      type: "workspace.status",
      threadId,
      status: "ready",
      revision: 2,
    });
    expect(client.workspaceStatus(threadId)).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    client.stop();
  });
});

describe("RealtimeClient presence", () => {
  it("stops joining a refused Thread until that Thread changes", () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const socket = new FakeSocket();
    const client = new RealtimeClient(queryClient, userId, () => socket);
    client.start();
    socket.receive({ type: "ready", revision: 0 });
    client.observeThread(threadId);
    const topic = `thread:${threadId}`;
    const joins = () =>
      socket.sent.filter(
        (message) => JSON.parse(message).type === "presence.join",
      ).length;
    expect(joins()).toBe(1);

    socket.receive({ type: "presence.denied", topic });
    vi.advanceTimersByTime(60_000);
    // No join retry and no heartbeat for a refused Thread.
    expect(joins()).toBe(1);
    expect(
      socket.sent.some(
        (message) => JSON.parse(message).type === "presence.heartbeat",
      ),
    ).toBe(false);

    // Sharing changed: one more try.
    socket.receive({ type: "thread.invalidated", threadId, revision: 1 });
    expect(joins()).toBe(2);
    client.stop();
  });

  it("reports who has a Thread open, once per user", () => {
    const socket = new FakeSocket();
    const client = new RealtimeClient(new QueryClient(), userId, () => socket);
    client.start();
    socket.receive({ type: "ready", revision: 0 });
    const other = Schema.decodeUnknownSync(UserId)(
      "usr_00000000-0000-4000-8000-000000000002",
    );
    socket.receive({
      type: "presence.snapshot",
      topic: `thread:${threadId}`,
      participants: [
        { userId, clientId: "00000000-0000-4000-8000-000000000001" },
        { userId: other, clientId: "00000000-0000-4000-8000-000000000002" },
        { userId: other, clientId: "00000000-0000-4000-8000-000000000003" },
      ],
    });
    expect(client.presentUsers(threadId)).toEqual([userId, other]);
    client.stop();
  });
});
