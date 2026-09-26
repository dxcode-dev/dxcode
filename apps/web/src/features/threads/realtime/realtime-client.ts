import { RealtimeServerEvent } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import {
  invalidateAllChanges,
  invalidateChangesRanges,
} from "../changes/changes-queries.js";
import {
  invalidateAllThreadQueries,
  invalidateReadinessQuery,
  invalidateThreadLists,
  invalidateThreadQueries,
} from "../thread-queries.js";

interface RealtimeSocket {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type SocketFactory = (url: string) => RealtimeSocket;
export type WorkspaceStatus = "waking" | undefined;

const invalidateAllRealtimeState = (
  queryClient: QueryClient,
  userId: UserId,
) => {
  void invalidateAllThreadQueries(queryClient, userId);
  void invalidateAllChanges(queryClient);
};

export class RealtimeClient {
  readonly #clientId = crypto.randomUUID();
  readonly #queryClient: QueryClient;
  readonly #userId: UserId;
  readonly #socketFactory: SocketFactory;
  #socket?: RealtimeSocket;
  #cursor?: number;
  #reconnect?: ReturnType<typeof setTimeout>;
  #heartbeat?: ReturnType<typeof setInterval>;
  #topic?: `thread:${ThreadId}`;
  readonly #workspaceStatuses = new Map<ThreadId, WorkspaceStatus>();
  readonly #workspaceStatusListeners = new Map<ThreadId, Set<() => void>>();
  #stopped = true;
  #attempt = 0;

  constructor(
    queryClient: QueryClient,
    userId: UserId,
    socketFactory: SocketFactory = (url) => new WebSocket(url),
  ) {
    this.#queryClient = queryClient;
    this.#userId = userId;
    this.#socketFactory = socketFactory;
  }

  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    if (this.#reconnect !== undefined) clearTimeout(this.#reconnect);
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#reconnect = undefined;
    this.#heartbeat = undefined;
    this.#socket?.close(1000, "provider-unmounted");
    this.#socket = undefined;
    this.#clearWorkspaceStatuses();
  }

  observeThread(threadId: ThreadId) {
    const next = `thread:${threadId}` as const;
    if (this.#topic === next) return () => undefined;
    if (this.#topic !== undefined) this.#send("presence.leave", this.#topic);
    this.#topic = next;
    this.#send("presence.join", next);
    return () => {
      if (this.#topic !== next) return;
      this.#send("presence.leave", next);
      this.#topic = undefined;
    };
  }

  observeWorkspaceStatus(threadId: ThreadId, listener: () => void) {
    const listeners = this.#workspaceStatusListeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.#workspaceStatusListeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#workspaceStatusListeners.delete(threadId);
    };
  }

  workspaceStatus(threadId: ThreadId): WorkspaceStatus {
    return this.#workspaceStatuses.get(threadId);
  }

  #connect() {
    const url = new URL("/v1/realtime", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("clientId", this.#clientId);
    if (this.#cursor !== undefined)
      url.searchParams.set("cursor", String(this.#cursor));
    const socket = this.#socketFactory(url.toString());
    this.#socket = socket;
    socket.onmessage = (event) => this.#receive(event.data);
    socket.onopen = () => {
      this.#attempt = 0;
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.#socket === socket) this.#socket = undefined;
      this.#clearWorkspaceStatuses();
      if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
      if (this.#stopped) return;
      const delay = Math.min(1_000 * 2 ** this.#attempt, 15_000);
      this.#attempt += 1;
      this.#reconnect = setTimeout(() => this.#connect(), delay);
    };
  }

  #receive(raw: unknown) {
    if (typeof raw !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const decoded = Schema.decodeUnknownOption(RealtimeServerEvent)(parsed, {
      onExcessProperty: "error",
    });
    if (Option.isNone(decoded)) return;
    const event = decoded.value;
    if (event.type === "ready") {
      this.#cursor = event.revision;
      if (this.#topic !== undefined) this.#send("presence.join", this.#topic);
      this.#heartbeat = setInterval(() => {
        if (this.#topic !== undefined)
          this.#send("presence.heartbeat", this.#topic);
      }, 10_000);
      return;
    }
    if (event.type === "revision-gap") {
      this.#cursor = event.revision;
      this.#clearWorkspaceStatuses();
      invalidateAllRealtimeState(this.#queryClient, this.#userId);
      return;
    }
    if ("revision" in event) {
      if (this.#cursor === undefined || event.revision !== this.#cursor + 1) {
        this.#cursor = event.revision;
        invalidateAllRealtimeState(this.#queryClient, this.#userId);
        this.#socket?.close(4009, "revision-gap");
        return;
      }
      this.#cursor = event.revision;
    }
    if (event.type === "thread.invalidated") {
      void invalidateThreadQueries(
        this.#queryClient,
        this.#userId,
        event.threadId,
      );
    } else if (event.type === "readiness.invalidated") {
      void invalidateReadinessQuery(
        this.#queryClient,
        this.#userId,
        event.threadId,
      );
    } else if (event.type === "changes.invalidated") {
      void invalidateChangesRanges(this.#queryClient, event.threadId);
      void invalidateThreadLists(this.#queryClient, this.#userId);
    } else if (event.type === "workspace.status") {
      if (event.status === "waking")
        this.#workspaceStatuses.set(event.threadId, "waking");
      else this.#workspaceStatuses.delete(event.threadId);
      this.#workspaceStatusListeners
        .get(event.threadId)
        ?.forEach((listener) => {
          listener();
        });
    } else if (event.type === "presence.rejoin-required") {
      if (event.topic === this.#topic && this.#topic !== undefined)
        this.#send("presence.join", this.#topic);
    }
  }

  #send(
    type: "presence.join" | "presence.leave" | "presence.heartbeat",
    topic: `thread:${ThreadId}`,
  ) {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify({ type, topic }));
  }

  #clearWorkspaceStatuses() {
    if (this.#workspaceStatuses.size === 0) return;
    const threadIds = [...this.#workspaceStatuses.keys()];
    this.#workspaceStatuses.clear();
    for (const threadId of threadIds)
      this.#workspaceStatusListeners.get(threadId)?.forEach((listener) => {
        listener();
      });
  }
}
