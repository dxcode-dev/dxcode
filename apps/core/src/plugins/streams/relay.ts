import { DurableObject } from "cloudflare:workers";
import { getLogger } from "@logtape/logtape";
import {
  type BrowserSessionBinding,
  closeForEndedSession,
  enforceBrowserSessions,
  readBrowserSessionHeaders,
} from "../../auth/session-sockets.js";
import type { Bindings } from "../../http/types.js";
import type { StreamCheck } from "./revalidate.js";
import type { TurnKey } from "./turn.js";

/**
 * One plugin pane's stream: a relay between the plugin's producers and
 * the pane's viewers, named `threadId:pluginId:paneId`.
 *
 * - **Producers** are the plugin's own host (a Worker or Durable Object
 *   call holding `ctx.ui.stream`) or a process holding the stream's signed
 *   `url`. Each signed URL connects once: its nonce is spent here.
 * - **Viewers** are the web app's pages showing the pane; they relay each
 *   message into the sealed frame, so the frame itself never connects.
 * - The first binary message after a producer connects is the stream's
 *   **header** (an fMP4 init segment, a decoder config): a viewer that
 *   joins later gets it first.
 * - Bandwidth, not message count, is limited: a token bucket at the tier's
 *   `streamBytesPerSecond`. A message past it is dropped and viewers hear
 *   `throttled`, so a producer that sends too much loses frames, not the
 *   stream.
 *
 * Messages from dx itself to viewers are text frames starting with NUL
 * (`\u0000{json}`); a producer's text frame starting with NUL is dropped.
 * While any socket is open an alarm checks, every minute, that the plugin
 * still offers the pane at a trusted tier in a live Thread and that each
 * viewer's browser session is still signed in, and revokes the stream when
 * not.
 */

const logger = getLogger(["dx", "plugins", "streams"]);

/** One message is at most this many bytes, a Workers WebSocket's limit. */
export const STREAM_MESSAGE_BYTES = 1_048_576;
/** A viewer's own messages: smaller, and at most this many a second. */
const VIEWER_MESSAGE_BYTES = 65_536;
const VIEWER_MESSAGES_PER_SECOND = 60;
const CHECK_MS = 60_000;
/** Opens a minute a stream admits per viewer, and for its producers. */
export const STREAM_OPENS_PER_MINUTE = 30;
/** How long one person's TURN credentials are handed out again. */
const TURN_CACHE_MS = 5 * 60_000;
/**
 * A stream whose checks keep failing (D1 errors, say) ends after this long:
 * dx cannot tell the plugin is still installed and trusted, so it does not
 * keep relaying on trust.
 */
export const CHECK_FAILURE_LIMIT_MS = 5 * 60_000;

export const STREAM_INTERNAL_ORIGIN = "https://plugin-stream.internal";
/** Headers the routes set on the request to the relay; callers' are dropped. */
export const STREAM_META_HEADER = "x-dx-stream-meta";

/** What every request to the relay carries, set by dx's routes. */
export interface StreamMeta {
  readonly threadId: string;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly paneId: string;
  readonly tier: string;
  readonly bytesPerSecond: number;
  readonly requestId: string;
  /** A producer by URL: the URL's nonce, issue time, and expiry. */
  readonly nonce?: string;
  readonly issuedAt?: number;
  readonly expiresAt?: number;
  /** A producer: which host holds it. */
  readonly host?: "worker" | "durable" | "orb" | "container" | "url";
  /** A viewer who may only watch. */
  readonly readOnly?: boolean;
  /** The viewer's user, and whether they own the Thread. */
  readonly viewerUserId?: string;
  readonly viewerIsOwner?: boolean;
}

type Attachment =
  | {
      readonly role: "viewer";
      readonly readOnly: boolean;
      /** Who views: the Thread's owner, or a member whose share is re-read. */
      readonly userId?: string;
      readonly owner?: boolean;
      readonly session?: BrowserSessionBinding;
      readonly requestId: string;
      readonly since: number;
    }
  | {
      readonly role: "producer";
      readonly host: string;
      readonly requestId: string;
      readonly since: number;
      /** Whether this producer already sent its header. */
      readonly headed: boolean;
    };

interface Stored {
  meta?: Omit<StreamMeta, "requestId" | "nonce" | "issuedAt" | "expiresAt">;
  /** URLs issued before this are refused; their producers were closed. */
  revokedBefore?: number;
  /** When checks started failing, if the last one failed. */
  checkFailingSince?: number;
  /** Checks that failed in a row. */
  checkFailures?: number;
}

const control = (message: Record<string, unknown>) =>
  `\u0000${JSON.stringify(message)}`;

const byteLength = (data: string | ArrayBuffer) =>
  typeof data === "string" ? data.length * 3 : data.byteLength;

export class PluginStreamRelay extends DurableObject<Bindings> {
  #stored: Stored | undefined;
  #header: ArrayBuffer | undefined;
  #tokens = 0;
  #refilledAt = 0;
  #dropped = 0;
  #droppedLoggedAt = 0;
  #throttledToldAt = 0;
  #sent = 0;
  readonly #viewerBudget = new Map<WebSocket, { at: number; count: number }>();

  async #state(): Promise<Stored> {
    if (this.#stored !== undefined) return this.#stored;
    this.#stored = (await this.ctx.storage.get<Stored>("stream")) ?? {};
    this.#header ??= await this.ctx.storage.get<ArrayBuffer>("header");
    return this.#stored;
  }

  async #save(next: Stored) {
    this.#stored = next;
    await this.ctx.storage.put("stream", next);
  }

  #log(
    level: "info" | "warn",
    message: string,
    fields: Record<string, unknown>,
  ) {
    const meta = this.#stored?.meta;
    const line = {
      event: "plugin_stream",
      streamId:
        meta === undefined ? undefined : `${meta.pluginName}/${meta.paneId}`,
      threadId: meta?.threadId,
      installId: meta?.pluginId,
      tier: meta?.tier,
      ...fields,
    };
    if (level === "warn") logger.warn(message, line);
    else logger.info(message, line);
  }

  #producers() {
    return this.ctx.getWebSockets("producer");
  }

  #viewers() {
    return this.ctx.getWebSockets("viewer");
  }

  #broadcastState() {
    const message = control({
      t: "state",
      producers: this.#producers().length,
    });
    for (const viewer of this.#viewers()) safeSend(viewer, message);
  }

  async #ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const raw = request.headers.get(STREAM_META_HEADER);
    if (raw === null || request.headers.get("upgrade") !== "websocket")
      return new Response("Not found.", { status: 404 });
    const meta = JSON.parse(raw) as StreamMeta;
    const started = Date.now();
    const state = await this.#state();
    const { requestId, nonce, issuedAt, expiresAt, ...kept } = meta;
    if (
      state.meta === undefined ||
      state.meta.bytesPerSecond !== kept.bytesPerSecond ||
      state.meta.tier !== kept.tier
    )
      await this.#save({ ...state, meta: kept });

    // Opens are bounded: a page or process reconnecting in a loop is
    // refused before it costs a socket.
    const opener =
      url.pathname === "/producer"
        ? "producer"
        : (meta.viewerUserId ?? "viewer");
    if (!this.#admitOpen(opener)) {
      this.#log("warn", "A plugin stream open was rate limited.", {
        requestId,
        host: url.pathname === "/producer" ? (meta.host ?? "url") : "viewer",
        outcome: "rate-limited",
      });
      return new Response("Too many stream opens; try again in a minute.", {
        status: 429,
      });
    }
    if (url.pathname === "/producer") {
      if (nonce !== undefined) {
        const refused = await this.#spendUrl(nonce, issuedAt, expiresAt);
        if (refused !== undefined) {
          this.#log("warn", "A plugin stream URL was refused.", {
            requestId,
            host: "url",
            outcome: refused,
            ms: Date.now() - started,
          });
          return new Response(refused, { status: 403 });
        }
      }
      const pair = new WebSocketPair();
      const attachment: Attachment = {
        role: "producer",
        host: meta.host ?? "url",
        requestId,
        since: Date.now(),
        headed: false,
      };
      this.ctx.acceptWebSocket(pair[1], ["producer"]);
      pair[1].serializeAttachment(attachment);
      await this.#ensureAlarm();
      this.#broadcastState();
      this.#log("info", "A plugin stream producer connected.", {
        requestId,
        host: attachment.host,
        outcome: "connected",
        ms: Date.now() - started,
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/viewer") {
      const pair = new WebSocketPair();
      const session = readBrowserSessionHeaders(request.headers);
      const attachment: Attachment = {
        role: "viewer",
        readOnly: meta.readOnly === true,
        ...(meta.viewerUserId === undefined
          ? {}
          : { userId: meta.viewerUserId, owner: meta.viewerIsOwner === true }),
        requestId,
        since: Date.now(),
        ...(session === undefined ? {} : { session }),
      };
      this.ctx.acceptWebSocket(pair[1], ["viewer"]);
      pair[1].serializeAttachment(attachment);
      safeSend(
        pair[1],
        control({
          t: "hello",
          producers: this.#producers().length,
          bytesPerSecond: kept.bytesPerSecond,
        }),
      );
      if (this.#header !== undefined) safeSend(pair[1], this.#header);
      await this.#ensureAlarm();
      this.#log("info", "A plugin stream viewer connected.", {
        requestId,
        host: "viewer",
        outcome: "connected",
        ms: Date.now() - started,
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("Not found.", { status: 404 });
  }

  /**
   * Spends a signed URL's nonce. Refuses one spent before, past its expiry,
   * or issued before the stream was last revoked.
   */
  async #spendUrl(
    nonce: string,
    issuedAt: number | undefined,
    expiresAt: number | undefined,
  ): Promise<"reused" | "expired" | "revoked" | undefined> {
    const now = Date.now();
    if (expiresAt === undefined || expiresAt <= now) return "expired";
    const state = await this.#state();
    if (
      issuedAt === undefined ||
      (state.revokedBefore !== undefined && issuedAt < state.revokedBefore)
    )
      return "revoked";
    const key = `nonce:${nonce}`;
    if ((await this.ctx.storage.get(key)) !== undefined) return "reused";
    await this.ctx.storage.put(key, expiresAt);
    return undefined;
  }

  /** Opens a minute, per viewer and for producers, in this instance. */
  readonly #opens = new Map<string, { at: number; count: number }>();

  #admitOpen(key: string) {
    const now = Date.now();
    const seen = this.#opens.get(key);
    if (seen === undefined || now - seen.at >= 60_000) {
      if (this.#opens.size > 256) this.#opens.clear();
      this.#opens.set(key, { at: now, count: 1 });
      return true;
    }
    return ++seen.count <= STREAM_OPENS_PER_MINUTE;
  }

  /**
   * Each member viewer's share, read again: removed from the Thread, they
   * are cut off; downgraded to view, they can no longer send.
   */
  async #recheckMembers(threadId: string) {
    const db = this.env.DB;
    if (db === undefined) return;
    const members = new Map<string, WebSocket[]>();
    for (const socket of this.#viewers()) {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (attachment.role !== "viewer" || attachment.owner !== false) continue;
      if (attachment.userId === undefined) continue;
      members.set(attachment.userId, [
        ...(members.get(attachment.userId) ?? []),
        socket,
      ]);
    }
    if (members.size === 0) return;
    const { findSharedThreadGrant } = await import(
      "../../thread-sharing/access.js"
    );
    for (const [userId, sockets] of members) {
      const grant = await findSharedThreadGrant(db, threadId, userId);
      for (const socket of sockets) {
        const attachment = socket.deserializeAttachment() as Attachment & {
          readonly role: "viewer";
        };
        if (grant === undefined) {
          safeClose(socket, 4403, "access-removed");
          this.#log(
            "warn",
            "A plugin stream viewer lost access to the Thread.",
            {
              requestId: attachment.requestId,
              host: "viewer",
              outcome: "access-removed",
            },
          );
        } else if (grant.access === "view" && !attachment.readOnly) {
          socket.serializeAttachment({ ...attachment, readOnly: true });
          this.#log("info", "A plugin stream viewer can now only watch.", {
            requestId: attachment.requestId,
            host: "viewer",
            outcome: "downgraded-to-view",
          });
        }
      }
    }
  }

  /** Closes every producer and refuses URLs issued before now. */
  async revoke(reason: string, requestId?: string) {
    const state = await this.#state();
    await this.#save({ ...state, revokedBefore: Date.now() });
    const producers = this.#producers();
    for (const producer of producers) safeClose(producer, 4403, reason);
    this.#header = undefined;
    await this.ctx.storage.delete("header");
    for (const viewer of this.#viewers())
      safeSend(viewer, control({ t: "state", producers: 0, revoked: reason }));
    this.#log("warn", "A plugin stream was revoked.", {
      requestId,
      outcome: "revoked",
      reason,
      producers: producers.length,
    });
  }

  /**
   * Ends every viewer and producer: the plugin is gone or below the tier
   * streams need. URLs issued before now are refused too.
   */
  async end(reason: string, requestId?: string) {
    await this.revoke(reason, requestId);
    for (const viewer of this.#viewers()) safeClose(viewer, 4403, reason);
  }

  /**
   * On the namespace's `turn` object only: the deployment's TURN key,
   * created once and kept here, and fresh credentials for one viewer.
   */
  async iceServers(userId: string) {
    const now = Date.now();
    // One set per person for five minutes: they stay valid ten.
    const cached = this.#turnCache.get(userId);
    if (cached !== undefined && now - cached.at < TURN_CACHE_MS)
      return cached.servers;
    if (!this.#admitOpen(`turn:${userId}`))
      throw new Error("Too many ICE server requests; try again in a minute.");
    const { createTurnKey, generateIceServers } = await import("./turn.js");
    // One key for the deployment, made once even when calls race.
    this.#turnKey ??= (async () => {
      let key = await this.ctx.storage.get<TurnKey>("turn-key");
      if (key === undefined) {
        key = await createTurnKey(this.env);
        await this.ctx.storage.put("turn-key", key);
      }
      return key;
    })();
    let key: TurnKey;
    try {
      key = await this.#turnKey;
    } catch (error) {
      this.#turnKey = undefined;
      throw error;
    }
    const servers = await generateIceServers(key);
    if (this.#turnCache.size > 1024) this.#turnCache.clear();
    this.#turnCache.set(userId, { at: now, servers });
    return servers;
  }

  #turnKey: Promise<TurnKey> | undefined;
  readonly #turnCache = new Map<
    string,
    {
      at: number;
      servers: Awaited<
        ReturnType<typeof import("./turn.js").generateIceServers>
      >;
    }
  >();

  /** Bandwidth: refills at `bytesPerSecond`, holding at most a second's. */
  #take(bytes: number) {
    const rate = this.#stored?.meta?.bytesPerSecond ?? 0;
    if (rate <= 0) return false;
    const now = Date.now();
    const capacity = Math.max(rate, STREAM_MESSAGE_BYTES);
    this.#tokens = Math.min(
      capacity,
      this.#tokens + ((now - this.#refilledAt) / 1_000) * rate,
    );
    this.#refilledAt = now;
    if (this.#tokens < bytes) return false;
    this.#tokens -= bytes;
    return true;
  }

  override async webSocketMessage(
    socket: WebSocket,
    data: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = socket.deserializeAttachment() as Attachment;
    await this.#state();
    if (attachment.role === "producer") {
      if (byteLength(data) > STREAM_MESSAGE_BYTES) {
        safeClose(socket, 1009, "A stream message is at most 1 MiB.");
        return;
      }
      if (typeof data === "string" && data.startsWith("\u0000")) return;
      // A producer's first binary message is the stream's header; it is
      // never dropped, since without it nothing after decodes.
      // The header is charged to the bucket like any message (it may run
      // it below zero, delaying what follows), so reconnecting producers
      // cannot send past the limit as headers.
      const header = typeof data !== "string" && !attachment.headed;
      if (header) {
        this.#take(0);
        this.#tokens -= byteLength(data);
        socket.serializeAttachment({ ...attachment, headed: true });
        this.#header = data;
        await this.ctx.storage.put("header", data);
      } else if (!this.#take(byteLength(data))) {
        this.#throttled();
        return;
      }
      this.#sent += byteLength(data);
      for (const viewer of this.#viewers()) safeSend(viewer, data);
      return;
    }
    // A viewer's message goes to every producer, as `onMessage`.
    if (attachment.readOnly) return;
    if (byteLength(data) > VIEWER_MESSAGE_BYTES) {
      safeClose(socket, 1009, "A viewer message is at most 64 KB.");
      return;
    }
    const now = Date.now();
    const budget = this.#viewerBudget.get(socket);
    if (budget === undefined || now - budget.at >= 1_000)
      this.#viewerBudget.set(socket, { at: now, count: 1 });
    else if (++budget.count > VIEWER_MESSAGES_PER_SECOND) return;
    for (const producer of this.#producers()) safeSend(producer, data);
  }

  #throttled() {
    this.#dropped += 1;
    const now = Date.now();
    if (now - this.#throttledToldAt >= 1_000) {
      this.#throttledToldAt = now;
      for (const viewer of this.#viewers())
        safeSend(viewer, control({ t: "throttled" }));
    }
    if (now - this.#droppedLoggedAt >= 10_000) {
      this.#droppedLoggedAt = now;
      this.#log("warn", "A plugin stream went past its bandwidth.", {
        outcome: "throttled",
        dropped: this.#dropped,
        bytesPerSecond: this.#stored?.meta?.bytesPerSecond,
      });
      this.#dropped = 0;
    }
  }

  override async webSocketClose(socket: WebSocket, code: number) {
    const attachment = socket.deserializeAttachment() as Attachment;
    this.#viewerBudget.delete(socket);
    safeClose(socket, 1000, "closed");
    await this.#state();
    this.#log("info", `A plugin stream ${attachment.role} disconnected.`, {
      requestId: attachment.requestId,
      host: attachment.role === "producer" ? attachment.host : "viewer",
      outcome: "closed",
      code,
      ms: Date.now() - attachment.since,
      ...(attachment.role === "producer" ? { bytes: this.#sent } : {}),
    });
    if (attachment.role === "producer") this.#broadcastState();
  }

  override async webSocketError(socket: WebSocket) {
    await this.webSocketClose(socket, 1011);
  }

  /** Every minute while sockets are open: is the stream still allowed? */
  override async alarm() {
    const sockets = this.ctx.getWebSockets();
    const state = await this.#state();
    // Spent nonces are kept until their URL expires.
    const nonces = await this.ctx.storage.list<number>({ prefix: "nonce:" });
    const now = Date.now();
    const stale = [...nonces].flatMap(([key, expires]) =>
      expires <= now ? [key] : [],
    );
    if (stale.length > 0) await this.ctx.storage.delete(stale);
    if (sockets.length === 0 || state.meta === undefined) {
      if (nonces.size > stale.length)
        await this.ctx.storage.setAlarm(now + CHECK_MS);
      return;
    }
    const meta = state.meta;
    let check: StreamCheck;
    let checked = false;
    try {
      // Loaded here: resolution pulls in the plugin host, which the
      // Worker's entry does not need to load.
      const { revalidateStream } = await import("./revalidate.js");
      check = await revalidateStream(this.env, meta);
      checked = true;
    } catch (error) {
      // From storage, not memory: the window must outlive the instance.
      const saved = (await this.ctx.storage.get<Stored>("stream")) ?? state;
      const since = saved.checkFailingSince ?? now;
      const failures = (saved.checkFailures ?? 0) + 1;
      await this.#save({
        ...saved,
        checkFailingSince: since,
        checkFailures: failures,
      });
      const ended = now - since >= CHECK_FAILURE_LIMIT_MS;
      this.#log(
        "warn",
        ended
          ? "A plugin stream could not be checked for five minutes; it ends."
          : "A plugin stream check failed; checking again.",
        {
          outcome: ended ? "check-failed-ended" : "check-failed",
          failures,
          failingMs: now - since,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      check = ended ? { ok: false, reason: "check-failed" } : { ok: true };
    }
    // A check that ran clears the failure window.
    if (checked && state.checkFailures !== undefined) {
      const {
        checkFailingSince: _since,
        checkFailures: _count,
        ...rest
      } = await this.#state();
      await this.#save(rest);
    }
    if (!check.ok) await this.end(check.reason);
    else await this.#recheckMembers(meta.threadId).catch(() => undefined);
    if (check.ok && this.env.DB !== undefined)
      await enforceBrowserSessions(this.env.DB, this.#viewers(), {
        binding: (socket) =>
          (
            socket.deserializeAttachment() as Attachment & {
              session?: BrowserSessionBinding;
            }
          ).session,
        renew: (socket, expiresAt) => {
          const attachment = socket.deserializeAttachment() as Attachment & {
            session?: BrowserSessionBinding;
          };
          if (attachment.role !== "viewer" || attachment.session === undefined)
            return;
          socket.serializeAttachment({
            ...attachment,
            session: { ...attachment.session, expiresAt },
          });
        },
        end: closeForEndedSession,
      }).catch(() => true);
    if (this.ctx.getWebSockets().length > 0)
      await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
  }
}

const safeSend = (socket: WebSocket, data: string | ArrayBuffer) => {
  try {
    socket.send(data);
  } catch {
    // Closing; its close handler cleans up.
  }
};

const safeClose = (socket: WebSocket, code: number, reason: string) => {
  try {
    socket.close(code, reason.slice(0, 120));
  } catch {
    // Already closed.
  }
};
