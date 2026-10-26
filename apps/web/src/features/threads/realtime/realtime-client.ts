import { RealtimeServerEvent } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import {
  isSessionEndedClose,
  reportSessionEnded,
} from "../../../shared/auth/session-ended.js";
import { invalidateSidebarLayout } from "../../navigation/sidebar-layout-queries.js";
import { invalidateNotifications } from "../../notifications/notifications-queries.js";
import {
  invalidateAllChanges,
  invalidateChangesRanges,
} from "../changes/changes-queries.js";
import { invalidateThreadFileTrees } from "../files/files-queries.js";
import {
  invalidateAllOrbDisk,
  invalidateOrbDisk,
} from "../orb-disk/orb-disk-queries.js";
import {
  invalidateAllOrbMemory,
  invalidateOrbMemory,
} from "../orb-memory/orb-memory-queries.js";
import {
  invalidateAllThreadQueries,
  invalidateReadinessQuery,
} from "../thread-queries.js";
import { ThreadListRows } from "../thread-row-queries.js";

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
  void invalidateAllOrbMemory(queryClient);
  void invalidateAllOrbDisk(queryClient);
  void invalidateNotifications(queryClient, userId);
  void invalidateSidebarLayout(queryClient, userId);
};

const visible = () =>
  typeof document === "undefined" || document.visibilityState !== "hidden";

export class RealtimeClient {
  readonly #clientId = crypto.randomUUID();
  readonly #queryClient: QueryClient;
  readonly #userId: UserId;
  readonly #socketFactory: SocketFactory;
  readonly #rows: ThreadListRows;
  #socket?: RealtimeSocket;
  #cursor?: number;
  #reconnect?: ReturnType<typeof setTimeout>;
  #heartbeat?: ReturnType<typeof setInterval>;
  #topic?: `thread:${ThreadId}`;
  /** The current topic's join was refused; retried once the Thread changes. */
  #deniedTopic?: `thread:${ThreadId}`;
  readonly #workspaceStatuses = new Map<ThreadId, WorkspaceStatus>();
  readonly #workspaceStatusListeners = new Map<ThreadId, Set<() => void>>();
  readonly #presentUsers = new Map<ThreadId, ReadonlyArray<UserId>>();
  readonly #presenceListeners = new Map<ThreadId, Set<() => void>>();
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
    this.#rows = new ThreadListRows(queryClient, userId);
  }

  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.#onVisibility);
      window.addEventListener("pagehide", this.#onPageHide);
      window.addEventListener("pageshow", this.#onVisibility);
    }
    this.#connect();
  }

  /**
   * Presence means the Thread is in front of someone: notifications hold back
   * for them. A hidden tab or a page being left is not watching, so it leaves
   * at once instead of lingering until its heartbeat times out.
   */
  readonly #onVisibility = () => {
    if (this.#topic === undefined || this.#topic === this.#deniedTopic) return;
    this.#send(visible() ? "presence.join" : "presence.leave", this.#topic);
  };

  readonly #onPageHide = () => {
    if (this.#topic !== undefined) this.#send("presence.leave", this.#topic);
  };

  stop() {
    this.#stopped = true;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.#onVisibility);
      window.removeEventListener("pagehide", this.#onPageHide);
      window.removeEventListener("pageshow", this.#onVisibility);
    }
    if (this.#reconnect !== undefined) clearTimeout(this.#reconnect);
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#reconnect = undefined;
    this.#heartbeat = undefined;
    this.#socket?.close(1000, "provider-unmounted");
    this.#socket = undefined;
    this.#rows.stop();
    this.#clearWorkspaceStatuses();
  }

  observeThread(threadId: ThreadId) {
    const next = `thread:${threadId}` as const;
    if (this.#topic === next) return () => undefined;
    if (this.#topic !== undefined) this.#send("presence.leave", this.#topic);
    this.#topic = next;
    this.#deniedTopic = undefined;
    if (visible()) this.#send("presence.join", next);
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

  observePresentUsers(threadId: ThreadId, listener: () => void) {
    const listeners = this.#presenceListeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.#presenceListeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#presenceListeners.delete(threadId);
    };
  }

  /** People with this Thread open right now, one entry per user. */
  presentUsers(threadId: ThreadId): ReadonlyArray<UserId> | undefined {
    return this.#presentUsers.get(threadId);
  }

  #connect() {
    const url = new URL("/v1/realtime", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("clientId", this.#clientId);
    if (this.#cursor !== undefined)
      url.searchParams.set("cursor", String(this.#cursor));
    const socket = this.#socketFactory(url.toString());
    this.#socket = socket;
    // stop() closes a socket, but its close and any frame already queued can
    // arrive after start() opened the next one. A replaced socket must not
    // reconnect, clear the live socket's heartbeat or statuses, or advance
    // the cursor into a false revision gap.
    socket.onmessage = (event) => {
      if (this.#socket === socket) this.#receive(event.data);
    };
    socket.onopen = () => {
      if (this.#socket === socket) this.#attempt = 0;
    };
    socket.onerror = () => socket.close();
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#clearWorkspaceStatuses();
      if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
      if (this.#stopped) return;
      if (isSessionEndedClose(event.code)) {
        this.stop();
        reportSessionEnded();
        return;
      }
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
      this.#deniedTopic = undefined;
      if (this.#topic !== undefined && visible())
        this.#send("presence.join", this.#topic);
      this.#heartbeat = setInterval(() => {
        if (
          this.#topic !== undefined &&
          this.#topic !== this.#deniedTopic &&
          visible()
        )
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
      // Sharing may have changed: try the refused Thread once more.
      if (this.#deniedTopic === `thread:${event.threadId}`) {
        this.#deniedTopic = undefined;
        this.#send("presence.join", `thread:${event.threadId}`);
      }
      this.#rows.threadChanged(event.threadId);
    } else if (event.type === "readiness.invalidated") {
      void invalidateReadinessQuery(
        this.#queryClient,
        this.#userId,
        event.threadId,
      );
    } else if (event.type === "changes.invalidated") {
      void invalidateChangesRanges(this.#queryClient, event.threadId);
      void invalidateThreadFileTrees(this.#queryClient, event.threadId);
      this.#rows.changesChanged(event.threadId, event.summaryChanged === true);
    } else if (event.type === "memory.invalidated") {
      void invalidateOrbMemory(this.#queryClient, event.threadId);
    } else if (event.type === "disk.invalidated") {
      void invalidateOrbDisk(this.#queryClient, event.threadId);
    } else if (event.type === "notifications.invalidated") {
      void invalidateNotifications(this.#queryClient, this.#userId);
    } else if (event.type === "sidebar.invalidated") {
      void invalidateSidebarLayout(this.#queryClient, this.#userId);
    } else if (event.type === "workspace.status") {
      if (event.status === "waking")
        this.#workspaceStatuses.set(event.threadId, "waking");
      else this.#workspaceStatuses.delete(event.threadId);
      this.#workspaceStatusListeners
        .get(event.threadId)
        ?.forEach((listener) => {
          listener();
        });
    } else if (event.type === "presence.snapshot") {
      const threadId = event.topic.slice("thread:".length) as ThreadId;
      const previous = new Set(this.#presentUsers.get(threadId) ?? []);
      const present = [
        ...new Set(event.participants.map(({ userId }) => userId)),
      ];
      this.#presentUsers.set(threadId, present);
      // Someone new opened a shared Thread: refresh it for their name.
      if (
        previous.size > 0 &&
        present.some(
          (userId) => userId !== this.#userId && !previous.has(userId),
        )
      )
        this.#rows.threadChanged(threadId);
      this.#presenceListeners.get(threadId)?.forEach((listener) => {
        listener();
      });
    } else if (event.type === "presence.denied") {
      if (event.topic === this.#topic) this.#deniedTopic = this.#topic;
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
    if (this.#presentUsers.size > 0) {
      const present = [...this.#presentUsers.keys()];
      this.#presentUsers.clear();
      for (const threadId of present)
        this.#presenceListeners.get(threadId)?.forEach((listener) => {
          listener();
        });
    }
    if (this.#workspaceStatuses.size === 0) return;
    const threadIds = [...this.#workspaceStatuses.keys()];
    this.#workspaceStatuses.clear();
    for (const threadId of threadIds)
      this.#workspaceStatusListeners.get(threadId)?.forEach((listener) => {
        listener();
      });
  }
}
