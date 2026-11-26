import {
  type BoardLivePayload,
  RealtimeServerEvent,
  SESSION_ENDED_CLOSE_CODE,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { Option, Schema } from "effect";
import {
  type PresenceScope,
  type PresenceTopic,
  presenceScope,
  presenceTopic,
  scopeThread,
} from "./presence-scope.js";

/**
 * The client side of Core's Realtime Hub (`/v1/realtime`): one WebSocket per
 * signed-in viewer that carries invalidation hints, presence, typing, live
 * drawing, and Orb wake status. It owns the protocol: the revision cursor and
 * gap recovery, reconnect backoff, presence joins and heartbeats, and the
 * state a UI reads. What a hint refreshes is the UI's business: it gets each
 * one through `RealtimeHints`.
 */

/** The parts of a WebSocket the connection uses. */
export interface RealtimeSocket {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** `WebSocket.OPEN`. */
const SOCKET_OPEN = 1;

/** Timers and time, so a UI, a test, or a native port supplies its own. */
export interface RealtimeClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly setInterval: (callback: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

/** A hint that something the UI shows changed; the UI refetches it. */
export type RealtimeHint = Extract<
  RealtimeServerEvent,
  {
    readonly type:
      | "thread.invalidated"
      | "readiness.invalidated"
      | "changes.invalidated"
      | "memory.invalidated"
      | "artifacts.invalidated"
      | "artifact.invalidated"
      | "comments.invalidated"
      | "space.posts.invalidated"
      | "reactions.invalidated"
      | "plugin-ui.invalidated"
      | "disk.invalidated"
      | "notifications.invalidated"
      | "mailbox.invalidated"
      | "sidebar.invalidated";
  }
>;

export interface RealtimeHints {
  /** One change, in revision order. */
  readonly hint: (hint: RealtimeHint) => void;
  /** Hints were missed: refetch everything realtime keeps fresh. */
  readonly resync: () => void;
  /** Someone new opened this shared Thread: refresh it for their name. */
  readonly joined: (threadId: ThreadId) => void;
}

export interface RealtimeConnectionOptions {
  readonly userId: UserId;
  /** This connection's ID, a UUID; the hub tells its frames apart by it. */
  readonly clientId: string;
  /** The dx origin, such as `https://dx.example`. */
  readonly origin: string;
  readonly createSocket: (url: string) => RealtimeSocket;
  readonly clock: RealtimeClock;
  readonly hints: RealtimeHints;
  /**
   * Whether the viewer can see the UI. Presence means a Thread is in front of
   * someone, so a hidden UI does not join or heartbeat. Defaults to visible.
   */
  readonly isVisible?: () => boolean;
  /** Core closed the socket because the session that opened it ended. */
  readonly onSessionEnded?: () => void;
  /** Opens and closes, for the UI's diagnostics. */
  readonly onConnectionEvent?: (
    name: "realtime.open" | "realtime.closed",
    detail?: string,
  ) => void;
}

/** `waking-slow`: still waking after `SLOW_WAKE_MS` (#1956). */
export type WorkspaceStatus = "waking" | "waking-slow" | undefined;

/**
 * A wake that takes longer than this says so. Most Orbs wake within
 * seconds; Cloudflare's slow restores take a minute or more, and Core waits
 * up to 5 minutes before the turn offers Retry.
 */
export const SLOW_WAKE_MS = 90_000;

/** How long a typing indicator lasts unless the typer repeats it. */
export const TYPING_LAPSE_MS = 5_000;

/** Someone typing a comment on one of a Thread's messages (`scope`). */
export interface ThreadTyping {
  readonly userId: UserId;
  readonly scope: string;
}

/** A plugin view message on the socket, before its module decodes it. */
export interface ViewSocketMessage {
  readonly type: string;
  readonly [field: string]: unknown;
}

/** Someone drawing on a board, as the hub relays it. */
export interface BoardLiveEvent {
  readonly userId: UserId;
  readonly clientId: string;
  readonly payload: BoardLivePayload;
}

const NO_TYPING: ReadonlyArray<ThreadTyping> = [];

/** The hub's WebSocket URL, resuming after `cursor` when given. */
export const realtimeUrl = (
  origin: string,
  clientId: string,
  cursor: number | undefined,
) => {
  const url = new URL("/v1/realtime", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("clientId", clientId);
  if (cursor !== undefined) url.searchParams.set("cursor", String(cursor));
  return url.toString();
};

export class RealtimeConnection {
  readonly #clientId: string;
  readonly #origin: string;
  readonly #userId: UserId;
  readonly #createSocket: (url: string) => RealtimeSocket;
  readonly #clock: RealtimeClock;
  readonly #hints: RealtimeHints;
  readonly #visible: () => boolean;
  readonly #onSessionEnded: () => void;
  readonly #onConnectionEvent: NonNullable<
    RealtimeConnectionOptions["onConnectionEvent"]
  >;
  #socket?: RealtimeSocket;
  #cursor?: number;
  #reconnect?: unknown;
  #heartbeat?: unknown;
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
  readonly #slowWakeTimers = new Map<ThreadId, unknown>();
  readonly #workspaceStatusListeners = new Map<ThreadId, Set<() => void>>();
  readonly #presentUsers = new Map<PresenceScope, ReadonlyArray<UserId>>();
  /** Each scope's open connections (client IDs), from the same snapshots. */
  readonly #presentClients = new Map<PresenceScope, ReadonlySet<string>>();
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
  readonly #typingTimers = new Map<ThreadId, unknown>();
  /** Listeners for plugin view messages, which their own module decodes. */
  readonly #viewListeners = new Set<(message: ViewSocketMessage) => void>();
  #stopped = true;
  #attempt = 0;

  constructor(options: RealtimeConnectionOptions) {
    this.#clientId = options.clientId;
    this.#origin = options.origin;
    this.#userId = options.userId;
    this.#createSocket = options.createSocket;
    this.#clock = options.clock;
    this.#hints = options.hints;
    this.#visible = options.isVisible ?? (() => true);
    this.#onSessionEnded = options.onSessionEnded ?? (() => undefined);
    this.#onConnectionEvent = options.onConnectionEvent ?? (() => undefined);
  }

  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    if (this.#reconnect !== undefined)
      this.#clock.clearTimeout(this.#reconnect);
    if (this.#heartbeat !== undefined)
      this.#clock.clearInterval(this.#heartbeat);
    this.#reconnect = undefined;
    this.#heartbeat = undefined;
    this.#socket?.close(1000, "provider-unmounted");
    this.#socket = undefined;
    this.#clearWorkspaceStatuses();
    for (const timer of this.#typingTimers.values())
      this.#clock.clearTimeout(timer);
    this.#typingTimers.clear();
    this.#typing.clear();
    this.#typingSnapshots.clear();
  }

  /**
   * The UI became visible or hidden. A hidden UI is not watching, so it
   * leaves at once instead of lingering until its heartbeat times out.
   */
  visibilityChanged() {
    if (this.#topic === undefined || this.#topic === this.#deniedTopic) return;
    this.#send(
      this.#visible() ? "presence.join" : "presence.leave",
      this.#topic,
    );
  }

  /** The viewer is leaving the page or closing the UI. */
  leaving() {
    if (this.#topic !== undefined) this.#send("presence.leave", this.#topic);
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
    if (next !== undefined && this.#visible())
      this.#send("presence.join", next);
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

  /** The connections (client IDs) with this Thread open right now. */
  presentClients(threadId: PresenceScope): ReadonlySet<string> | undefined {
    return this.#presentClients.get(threadId);
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
      this.#socket?.readyState !== SOCKET_OPEN
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
      this.#socket?.readyState !== SOCKET_OPEN
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
      until: this.#clock.now() + TYPING_LAPSE_MS,
    });
    this.#typing.set(threadId, entries);
    this.#publishTyping(threadId);
  }

  /** Drops lapsed indicators, publishes the rest, and wakes for the next lapse. */
  readonly #publishTyping = (threadId: ThreadId) => {
    const entries = this.#typing.get(threadId);
    const now = this.#clock.now();
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
    if (timer !== undefined) this.#clock.clearTimeout(timer);
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
        this.#clock.setTimeout(
          () => this.#publishTyping(threadId),
          soonest - now + 10,
        ),
      );
    }
    this.#typingListeners.get(threadId)?.forEach((listener) => {
      listener();
    });
  };

  #connect() {
    const socket = this.#createSocket(
      realtimeUrl(this.#origin, this.#clientId, this.#cursor),
    );
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
      this.#onConnectionEvent("realtime.open");
      this.#attempt = 0;
    };
    socket.onerror = () => socket.close();
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#onConnectionEvent(
        "realtime.closed",
        `${event.code}${event.reason ? ` ${event.reason}` : ""}`,
      );
      this.#socket = undefined;
      this.#clearWorkspaceStatuses();
      if (this.#heartbeat !== undefined)
        this.#clock.clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
      if (this.#stopped) return;
      if (event.code === SESSION_ENDED_CLOSE_CODE) {
        this.stop();
        this.#onSessionEnded();
        return;
      }
      const delay = Math.min(1_000 * 2 ** this.#attempt, 15_000);
      this.#attempt += 1;
      this.#reconnect = this.#clock.setTimeout(() => this.#connect(), delay);
    };
  }

  /**
   * Plugin views' messages, passed through undecoded: `plugin-view.*` and
   * `view.*` from the hub, and `ready` after each (re)connect.
   */
  observeViewMessages(listener: (message: ViewSocketMessage) => void) {
    this.#viewListeners.add(listener);
    return () => {
      this.#viewListeners.delete(listener);
    };
  }

  /** Sends a plugin view's message on the socket, when it is open. */
  sendViewMessage(message: { readonly type: string }) {
    if (this.#socket?.readyState === SOCKET_OPEN)
      this.#socket.send(JSON.stringify(message));
  }

  #receive(raw: unknown) {
    if (typeof raw !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    // `plugin-view.*` and `view.*`: no other event's type holds "view.".
    if (String((parsed as { type?: unknown } | null)?.type).includes("view.")) {
      for (const listener of this.#viewListeners)
        listener(parsed as ViewSocketMessage);
      return;
    }
    const decoded = Schema.decodeUnknownOption(RealtimeServerEvent)(parsed, {
      onExcessProperty: "error",
    });
    if (Option.isNone(decoded)) return;
    const event = decoded.value;
    if (event.type === "ready") {
      this.#cursor = event.revision;
      for (const listener of this.#viewListeners) listener({ type: "ready" });
      this.#deniedTopic = undefined;
      if (this.#topic !== undefined && this.#visible())
        this.#send("presence.join", this.#topic);
      this.#heartbeat = this.#clock.setInterval(() => {
        if (
          this.#topic !== undefined &&
          this.#topic !== this.#deniedTopic &&
          this.#visible()
        )
          this.#send("presence.heartbeat", this.#topic);
      }, 10_000);
      return;
    }
    if (event.type === "revision-gap") {
      this.#cursor = event.revision;
      this.#clearWorkspaceStatuses();
      this.#hints.resync();
      return;
    }
    if ("revision" in event) {
      if (this.#cursor === undefined || event.revision !== this.#cursor + 1) {
        this.#cursor = event.revision;
        this.#hints.resync();
        this.#socket?.close(4009, "revision-gap");
        return;
      }
      this.#cursor = event.revision;
    }
    switch (event.type) {
      case "thread.invalidated":
        // Sharing may have changed: try the refused Thread once more.
        this.#retryDenied(`thread:${event.threadId}`);
        this.#hints.hint(event);
        return;
      case "artifact.invalidated":
        // Sharing may have changed: try the refused artifact once more.
        this.#retryDenied(`artifact:${event.artifactId}`);
        this.#hints.hint(event);
        return;
      case "comments.invalidated":
        this.#hints.hint(event);
        // A comment landed: whoever wrote it stopped typing; anyone still
        // typing says so again within moments.
        if (this.#typing.delete(event.threadId))
          this.#publishTyping(event.threadId);
        return;
      case "presence.typing": {
        const threadId = scopeThread(presenceScope(event.topic));
        if (threadId !== undefined)
          this.#receiveTyping(threadId, {
            userId: event.userId,
            clientId: event.clientId,
            scope: event.scope,
          });
        return;
      }
      case "presence.board": {
        if (event.userId === this.#userId && event.clientId === this.#clientId)
          return;
        const key = `${presenceScope(event.topic)}\n${event.scope}`;
        for (const listener of this.#boardListeners.get(key) ?? [])
          listener({
            userId: event.userId,
            clientId: event.clientId,
            payload: event.payload,
          });
        return;
      }
      case "workspace.status":
        this.#receiveWorkspaceStatus(event.threadId, event.status);
        return;
      case "presence.snapshot":
        this.#receivePresence(presenceScope(event.topic), event.participants);
        return;
      case "presence.denied":
        if (event.topic === this.#topic) this.#deniedTopic = this.#topic;
        return;
      case "presence.rejoin-required":
        if (event.topic === this.#topic && this.#topic !== undefined)
          this.#send("presence.join", this.#topic);
        return;
      case "presence.heartbeat":
        return;
      default:
        this.#hints.hint(event);
    }
  }

  #retryDenied(topic: PresenceTopic) {
    if (this.#deniedTopic !== topic) return;
    this.#deniedTopic = undefined;
    this.#send("presence.join", topic);
  }

  #receiveWorkspaceStatus(threadId: ThreadId, status: "waking" | "ready") {
    if (status !== "waking") this.#clearWorkspaceStatus(threadId);
    else if (!this.#workspaceStatuses.has(threadId)) {
      // A wake already under way keeps its start, so a repeated `waking`
      // does not restart the count.
      this.#workspaceStatuses.set(threadId, "waking");
      this.#slowWakeTimers.set(
        threadId,
        this.#clock.setTimeout(() => {
          this.#slowWakeTimers.delete(threadId);
          if (this.#workspaceStatuses.get(threadId) !== "waking") return;
          this.#workspaceStatuses.set(threadId, "waking-slow");
          this.#notifyWorkspaceStatus(threadId);
        }, SLOW_WAKE_MS),
      );
    }
    this.#notifyWorkspaceStatus(threadId);
  }

  #receivePresence(
    scope: PresenceScope,
    participants: ReadonlyArray<{
      readonly userId: UserId;
      readonly clientId: string;
    }>,
  ) {
    const previous = new Set(this.#presentUsers.get(scope) ?? []);
    const present = [...new Set(participants.map(({ userId }) => userId))];
    this.#presentUsers.set(scope, present);
    this.#presentClients.set(
      scope,
      new Set(participants.map(({ clientId }) => clientId)),
    );
    // Someone new opened a shared Thread: refresh it for their name.
    const thread = scopeThread(scope);
    if (
      thread !== undefined &&
      previous.size > 0 &&
      present.some((userId) => userId !== this.#userId && !previous.has(userId))
    )
      this.#hints.joined(thread);
    this.#presenceListeners.get(scope)?.forEach((listener) => {
      listener();
    });
  }

  #send(
    type: "presence.join" | "presence.leave" | "presence.heartbeat",
    topic: PresenceTopic,
  ) {
    if (this.#socket?.readyState !== SOCKET_OPEN) return;
    this.#socket.send(JSON.stringify({ type, topic }));
  }

  #clearWorkspaceStatuses() {
    if (this.#presentUsers.size > 0) {
      const present = [...this.#presentUsers.keys()];
      this.#presentUsers.clear();
      this.#presentClients.clear();
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
    if (timer !== undefined) this.#clock.clearTimeout(timer);
    this.#slowWakeTimers.delete(threadId);
  }

  #notifyWorkspaceStatus(threadId: ThreadId) {
    this.#workspaceStatusListeners.get(threadId)?.forEach((listener) => {
      listener();
    });
  }
}
