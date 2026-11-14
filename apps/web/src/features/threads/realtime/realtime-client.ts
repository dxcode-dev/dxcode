import { type BoardLivePayload, RealtimeServerEvent } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import {
  isSessionEndedClose,
  reportSessionEnded,
} from "../../../shared/auth/session-ended.js";
import { recordConnectionEvent } from "../../../shared/diagnostics/client-diagnostics.js";
import type { BoardLiveEvent } from "../../../shared/realtime/board-live.js";
import {
  type PresenceScope,
  type PresenceTopic,
  presenceScope,
  presenceTopic,
  scopeThread,
} from "../../../shared/realtime/presence-scope.js";
import {
  invalidateAllArtifacts,
  invalidateArtifactLibrary,
  invalidateArtifacts,
} from "../../artifacts/artifacts-queries.js";
import { invalidateSidebarLayout } from "../../navigation/sidebar-layout-queries.js";
import { invalidateNotifications } from "../../notifications/notifications-queries.js";
import {
  invalidateAllMessageComments,
  invalidateMessageComments,
} from "../../spaces/comments/message-comments-cache-queries.js";
import {
  invalidateSpaceArtifacts,
  invalidateSpaceForThread,
  invalidateSpacePosts,
  invalidateSpaceQueries,
} from "../../spaces/space-cache-queries.js";
import {
  invalidateAllThreadAutomations,
  invalidateThreadAutomations,
} from "../automations/automations-queries.js";
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
import { invalidateMessageReactions } from "../sharing/message-reactions-cache-queries.js";
import {
  invalidateAllThreadQueries,
  invalidatePluginPaneMessages,
  invalidatePluginUi,
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
/** `waking-slow`: still waking after `SLOW_WAKE_MS` (#1956). */
export type WorkspaceStatus = "waking" | "waking-slow" | undefined;

/**
 * A wake that takes longer than this says so. Most Orbs wake within
 * seconds; Cloudflare's slow restores take a minute or more, and Core waits
 * up to 5 minutes before the turn offers Retry.
 */
export const SLOW_WAKE_MS = 90_000;

const invalidateAllRealtimeState = (
  queryClient: QueryClient,
  userId: UserId,
) => {
  void invalidateAllThreadQueries(queryClient, userId);
  void invalidateAllChanges(queryClient);
  void invalidateAllOrbMemory(queryClient);
  void invalidateAllOrbDisk(queryClient);
  void invalidateAllThreadAutomations(queryClient);
  void invalidateAllArtifacts(queryClient);
  void invalidateNotifications(queryClient, userId);
  void invalidateSidebarLayout(queryClient, userId);
  void invalidateSpaceQueries(queryClient, userId);
  void invalidateAllMessageComments(queryClient, userId);
};

/** How long a typing indicator lasts unless the typer repeats it. */
export const TYPING_LAPSE_MS = 5_000;

/** Someone typing a comment on one of a Thread's messages (`scope`). */
export interface ThreadTyping {
  readonly userId: UserId;
  readonly scope: string;
}

const NO_TYPING: ReadonlyArray<ThreadTyping> = [];

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
  #topic?: PresenceTopic;
  /**
   * The Threads (or standalone artifacts) views hold, oldest first; the
   * newest is `#topic`.
   */
  readonly #observers: Array<{ readonly topic: PresenceTopic }> = [];
  /** The current topic's join was refused; retried once the Thread changes. */
  #deniedTopic?: PresenceTopic;
  readonly #workspaceStatuses = new Map<ThreadId, WorkspaceStatus>();
  /** Per waking Thread, the timer that marks the wake slow. */
  readonly #slowWakeTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  readonly #workspaceStatusListeners = new Map<ThreadId, Set<() => void>>();
  readonly #presentUsers = new Map<PresenceScope, ReadonlyArray<UserId>>();
  /** Live drawing listeners, by `<scope>\n<artifactId>`. */
  readonly #boardListeners = new Map<
    string,
    Set<(event: BoardLiveEvent) => void>
  >();
  readonly #presenceListeners = new Map<PresenceScope, Set<() => void>>();
  /** Who is typing a comment, per Thread, by client, until it lapses. */
  readonly #typing = new Map<
    ThreadId,
    Map<string, ThreadTyping & { readonly until: number }>
  >();
  readonly #typingSnapshots = new Map<ThreadId, ReadonlyArray<ThreadTyping>>();
  readonly #typingListeners = new Map<ThreadId, Set<() => void>>();
  readonly #typingTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
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
    for (const timer of this.#typingTimers.values()) clearTimeout(timer);
    this.#typingTimers.clear();
    this.#typing.clear();
    this.#typingSnapshots.clear();
  }

  /**
   * Joins the Thread's presence while the caller holds it. A page can show
   * two Threads, such as a Space's chat and a thread open beside it; the
   * hub holds one topic per socket, so the newest held Thread is joined and,
   * once it lets go, the one before it is joined again.
   */
  observeThread(threadId: PresenceScope) {
    const observer = { topic: presenceTopic(threadId) };
    this.#observers.push(observer);
    this.#joinNewestTopic();
    return () => {
      const index = this.#observers.indexOf(observer);
      if (index === -1) return;
      this.#observers.splice(index, 1);
      this.#joinNewestTopic();
    };
  }

  #joinNewestTopic() {
    const next = this.#observers.at(-1)?.topic;
    if (next === this.#topic) return;
    if (this.#topic !== undefined) this.#send("presence.leave", this.#topic);
    this.#topic = next;
    this.#deniedTopic = undefined;
    if (next !== undefined && visible()) this.#send("presence.join", next);
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

  observePresentUsers(threadId: PresenceScope, listener: () => void) {
    const listeners = this.#presenceListeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.#presenceListeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#presenceListeners.delete(threadId);
    };
  }

  /** People with this Thread open right now, one entry per user. */
  presentUsers(threadId: PresenceScope): ReadonlyArray<UserId> | undefined {
    return this.#presentUsers.get(threadId);
  }

  observeTyping(threadId: ThreadId, listener: () => void) {
    const listeners = this.#typingListeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.#typingListeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#typingListeners.delete(threadId);
    };
  }

  /** Who else is typing a comment in this Thread now, one entry per person and message. */
  typing(threadId: ThreadId): ReadonlyArray<ThreadTyping> {
    return this.#typingSnapshots.get(threadId) ?? NO_TYPING;
  }

  /**
   * Tells the others with this Thread open that the viewer is typing a
   * comment on one of its messages. Only for the Thread the viewer has open;
   * callers repeat it while typing goes on, well inside `TYPING_LAPSE_MS`.
   */
  sendTyping(threadId: ThreadId, scope: string) {
    const topic = `thread:${threadId}` as const;
    if (
      this.#topic !== topic ||
      this.#deniedTopic === topic ||
      this.#socket?.readyState !== WebSocket.OPEN
    )
      return;
    this.#socket.send(
      JSON.stringify({ type: "presence.typing", topic, scope }),
    );
  }

  /**
   * Tells the others with this Thread open where the viewer's pointer is on
   * a board and what they are drawing. Only for the Thread the viewer has
   * open; callers throttle it.
   */
  sendBoard(
    threadId: PresenceScope,
    artifactId: string,
    payload: BoardLivePayload,
  ) {
    const topic = presenceTopic(threadId);
    if (
      this.#topic !== topic ||
      this.#deniedTopic === topic ||
      this.#socket?.readyState !== WebSocket.OPEN
    )
      return false;
    this.#socket.send(
      JSON.stringify({
        type: "presence.board",
        topic,
        scope: artifactId,
        payload,
      }),
    );
    return true;
  }

  /** Others' live drawing on one board, as it arrives. */
  observeBoard(
    threadId: PresenceScope,
    artifactId: string,
    listener: (event: BoardLiveEvent) => void,
  ) {
    const key = `${threadId}\n${artifactId}`;
    const listeners = this.#boardListeners.get(key) ?? new Set();
    listeners.add(listener);
    this.#boardListeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#boardListeners.delete(key);
    };
  }

  #receiveTyping(
    threadId: ThreadId,
    typing: ThreadTyping & { readonly clientId: string },
  ) {
    if (typing.userId === this.#userId) return;
    const entries = this.#typing.get(threadId) ?? new Map();
    entries.set(typing.clientId, {
      userId: typing.userId,
      scope: typing.scope,
      until: Date.now() + TYPING_LAPSE_MS,
    });
    this.#typing.set(threadId, entries);
    this.#publishTyping(threadId);
  }

  /** Drops lapsed indicators, publishes the rest, and wakes for the next lapse. */
  readonly #publishTyping = (threadId: ThreadId) => {
    const entries = this.#typing.get(threadId);
    const now = Date.now();
    for (const [clientId, entry] of entries ?? [])
      if (entry.until <= now) entries?.delete(clientId);
    const seen = new Set<string>();
    const next = [...(entries?.values() ?? [])].flatMap(({ userId, scope }) => {
      const key = `${userId}\n${scope}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ userId, scope }];
    });
    const timer = this.#typingTimers.get(threadId);
    if (timer !== undefined) clearTimeout(timer);
    this.#typingTimers.delete(threadId);
    if (entries === undefined || entries.size === 0) {
      this.#typing.delete(threadId);
      this.#typingSnapshots.delete(threadId);
    } else {
      this.#typingSnapshots.set(threadId, next);
      const soonest = Math.min(
        ...[...entries.values()].map(({ until }) => until),
      );
      this.#typingTimers.set(
        threadId,
        setTimeout(() => this.#publishTyping(threadId), soonest - now + 10),
      );
    }
    this.#typingListeners.get(threadId)?.forEach((listener) => {
      listener();
    });
  };

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
      if (this.#socket !== socket) return;
      recordConnectionEvent("realtime.open");
      this.#attempt = 0;
    };
    socket.onerror = () => socket.close();
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      recordConnectionEvent(
        "realtime.closed",
        `${event.code}${event.reason ? ` ${event.reason}` : ""}`,
      );
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
      void invalidateThreadAutomations(this.#queryClient, event.threadId);
      void invalidateSpaceForThread(
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
      void invalidateThreadFileTrees(this.#queryClient, event.threadId);
      this.#rows.changesChanged(event.threadId, event.summaryChanged === true);
    } else if (event.type === "memory.invalidated") {
      void invalidateOrbMemory(this.#queryClient, event.threadId);
    } else if (event.type === "artifacts.invalidated") {
      void invalidateArtifacts(this.#queryClient, event.threadId);
      void invalidateSpaceArtifacts(
        this.#queryClient,
        this.#userId,
        event.threadId,
      );
    } else if (event.type === "artifact.invalidated") {
      // Sharing may have changed: try the refused artifact once more.
      const topic = `artifact:${event.artifactId}` as const;
      if (this.#deniedTopic === topic) {
        this.#deniedTopic = undefined;
        this.#send("presence.join", topic);
      }
      void invalidateArtifacts(this.#queryClient, topic);
      void invalidateArtifactLibrary(this.#queryClient);
    } else if (event.type === "plugin-ui.invalidated") {
      void invalidatePluginUi(this.#queryClient, event.threadId);
    } else if (event.type === "plugin-pane.invalidated") {
      void invalidatePluginPaneMessages(this.#queryClient, event.threadId);
    } else if (event.type === "space.posts.invalidated") {
      void invalidateSpacePosts(
        this.#queryClient,
        this.#userId,
        event.threadId,
      );
    } else if (event.type === "reactions.invalidated") {
      void invalidateMessageReactions(
        this.#queryClient,
        this.#userId,
        event.threadId,
      );
    } else if (event.type === "comments.invalidated") {
      void invalidateMessageComments(
        this.#queryClient,
        this.#userId,
        event.threadId,
      );
      // A comment landed: whoever wrote it stopped typing; anyone still
      // typing says so again within moments.
      if (this.#typing.delete(event.threadId))
        this.#publishTyping(event.threadId);
    } else if (event.type === "presence.typing") {
      const threadId = scopeThread(presenceScope(event.topic));
      if (threadId !== undefined)
        this.#receiveTyping(threadId, {
          userId: event.userId,
          clientId: event.clientId,
          scope: event.scope,
        });
    } else if (event.type === "presence.board") {
      if (event.userId === this.#userId && event.clientId === this.#clientId)
        return;
      const key = `${presenceScope(event.topic)}\n${event.scope}`;
      for (const listener of this.#boardListeners.get(key) ?? [])
        listener({
          userId: event.userId,
          clientId: event.clientId,
          payload: event.payload,
        });
    } else if (event.type === "disk.invalidated") {
      void invalidateOrbDisk(this.#queryClient, event.threadId);
    } else if (event.type === "notifications.invalidated") {
      void invalidateNotifications(this.#queryClient, this.#userId);
    } else if (event.type === "sidebar.invalidated") {
      void invalidateSidebarLayout(this.#queryClient, this.#userId);
      void invalidateSpaceQueries(this.#queryClient, this.#userId);
    } else if (event.type === "workspace.status") {
      const threadId = event.threadId;
      if (event.status !== "waking") this.#clearWorkspaceStatus(threadId);
      else if (!this.#workspaceStatuses.has(threadId)) {
        // A wake already under way keeps its start, so a repeated `waking`
        // does not restart the count.
        this.#workspaceStatuses.set(threadId, "waking");
        this.#slowWakeTimers.set(
          threadId,
          setTimeout(() => {
            this.#slowWakeTimers.delete(threadId);
            if (this.#workspaceStatuses.get(threadId) !== "waking") return;
            this.#workspaceStatuses.set(threadId, "waking-slow");
            this.#notifyWorkspaceStatus(threadId);
          }, SLOW_WAKE_MS),
        );
      }
      this.#notifyWorkspaceStatus(threadId);
    } else if (event.type === "presence.snapshot") {
      const threadId = presenceScope(event.topic);
      const previous = new Set(this.#presentUsers.get(threadId) ?? []);
      const present = [
        ...new Set(event.participants.map(({ userId }) => userId)),
      ];
      this.#presentUsers.set(threadId, present);
      // Someone new opened a shared Thread: refresh it for their name.
      const thread = scopeThread(threadId);
      if (
        thread !== undefined &&
        previous.size > 0 &&
        present.some(
          (userId) => userId !== this.#userId && !previous.has(userId),
        )
      )
        this.#rows.threadChanged(thread);
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
    topic: PresenceTopic,
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
    for (const threadId of threadIds) this.#clearWorkspaceStatus(threadId);
    for (const threadId of threadIds) this.#notifyWorkspaceStatus(threadId);
  }

  #clearWorkspaceStatus(threadId: ThreadId) {
    this.#workspaceStatuses.delete(threadId);
    const timer = this.#slowWakeTimers.get(threadId);
    if (timer !== undefined) clearTimeout(timer);
    this.#slowWakeTimers.delete(threadId);
  }

  #notifyWorkspaceStatus(threadId: ThreadId) {
    this.#workspaceStatusListeners.get(threadId)?.forEach((listener) => {
      listener();
    });
  }
}
