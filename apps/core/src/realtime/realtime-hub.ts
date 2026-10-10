import { DurableObject } from "cloudflare:workers";
import { ThreadId, UserId } from "@dx/domain";
import { Option, Schema } from "effect";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../http/types.js";
import { sharedThreadVisibleSql } from "../thread-sharing/access.js";
import {
  AUDIENCE_HEADER,
  type AudienceKey,
  CLIENT_HEADER,
  homeAudienceForUser,
  PARTICIPANT_HEADER,
  type RealtimeRecipients,
  type RealtimeThreadEventType,
  type WorkspaceStatus,
} from "./publication.js";

const AUDIENCE_KEY = "audience";
export const PRESENCE_HEARTBEAT_TIMEOUT_MS = 30_000;

type PresenceTopic = `thread:${ThreadId}`;

interface SocketAttachment {
  readonly audience: AudienceKey;
  readonly participant: UserId;
  readonly clientId: string;
  /** The joined Thread; kept on the socket so presence survives hibernation. */
  readonly topic?: PresenceTopic;
}

interface PresenceEntry {
  readonly topic: PresenceTopic;
  readonly heartbeatAt: number;
}

interface ThreadEvent {
  readonly type: RealtimeThreadEventType;
  readonly threadId: ThreadId;
  readonly ownerUserId: UserId;
  readonly status?: WorkspaceStatus;
  readonly recipients: RealtimeRecipients;
}

const ClientId = Schema.String.check(
  Schema.isPattern(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
);
const revisionKey = (userId: UserId) => `revision:${userId}`;

const readCursor = (url: URL): number | undefined => {
  const value = url.searchParams.get("cursor");
  if (value === null) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value)) return Number.NaN;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : Number.NaN;
};

const copyWebSocketHeaders = (request: Request, headers: Headers) => {
  for (const name of [
    "connection",
    "sec-websocket-extensions",
    "sec-websocket-key",
    "sec-websocket-protocol",
    "sec-websocket-version",
  ]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
};

const decodeThreadEvent = (input: unknown): ThreadEvent | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        !["type", "threadId", "ownerUserId", "status", "recipients"].includes(
          key,
        ),
    )
  )
    return undefined;
  const threadId = Schema.decodeUnknownOption(ThreadId)(value.threadId);
  const ownerUserId = Schema.decodeUnknownOption(UserId)(value.ownerUserId);
  if (
    ![
      "thread.invalidated",
      "readiness.invalidated",
      "changes.invalidated",
      "workspace.status",
    ].includes(String(value.type)) ||
    Option.isNone(threadId) ||
    Option.isNone(ownerUserId) ||
    (value.type === "workspace.status" &&
      value.status !== "waking" &&
      value.status !== "ready") ||
    (value.type !== "workspace.status" && value.status !== undefined) ||
    (value.recipients !== undefined &&
      value.recipients !== "thread" &&
      value.recipients !== "audience")
  )
    return undefined;
  return {
    type: value.type as RealtimeThreadEventType,
    threadId: threadId.value,
    ownerUserId: ownerUserId.value,
    recipients: value.recipients === "audience" ? "audience" : "thread",
    ...(value.type === "workspace.status"
      ? { status: value.status as WorkspaceStatus }
      : {}),
  };
};

export class RealtimeHub extends DurableObject<Bindings> {
  readonly #presence = new Map<WebSocket, PresenceEntry>();
  #presenceRestored = false;

  /**
   * Hibernation drops in-memory presence while sockets stay open. Rebuild it
   * once per wake from the topic each socket carries.
   */
  #restorePresence() {
    if (this.#presenceRestored) return;
    this.#presenceRestored = true;
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const topic = (
        socket.deserializeAttachment() as SocketAttachment | undefined
      )?.topic;
      if (topic !== undefined && !this.#presence.has(socket))
        this.#presence.set(socket, { topic, heartbeatAt: now });
    }
  }

  #setPresence(socket: WebSocket, entry: PresenceEntry) {
    const attachment = socket.deserializeAttachment() as SocketAttachment;
    if (attachment.topic !== entry.topic)
      socket.serializeAttachment({ ...attachment, topic: entry.topic });
    this.#presence.set(socket, entry);
  }

  #clearPresence(socket: WebSocket) {
    this.#presence.delete(socket);
    const attachment = socket.deserializeAttachment() as
      | SocketAttachment
      | undefined;
    if (attachment?.topic === undefined) return;
    const { topic: _topic, ...rest } = attachment;
    try {
      socket.serializeAttachment(rest);
    } catch {
      // A closed socket has nothing left to restore.
    }
  }

  webSocketClose(socket: WebSocket): void {
    this.#restorePresence();
    const topic = this.#presence.get(socket)?.topic;
    this.#presence.delete(socket);
    if (topic !== undefined) this.#broadcastPresence(topic);
  }

  webSocketError(socket: WebSocket): void {
    this.#restorePresence();
    const topic = this.#presence.get(socket)?.topic;
    this.#presence.delete(socket);
    if (topic !== undefined) this.#broadcastPresence(topic);
    socket.close(1011, "websocket-error");
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") return;
    let input: unknown;
    try {
      input = JSON.parse(message);
    } catch {
      return;
    }
    if (typeof input !== "object" || input === null || !("type" in input))
      return;
    const rawTopic = "topic" in input ? input.topic : undefined;
    const decodedThreadId =
      typeof rawTopic === "string" && rawTopic.startsWith("thread:")
        ? Schema.decodeUnknownOption(ThreadId)(rawTopic.slice("thread:".length))
        : Option.none();
    const topic = Option.isSome(decodedThreadId)
      ? (`thread:${decodedThreadId.value}` as const)
      : undefined;
    const now = Date.now();
    this.#restorePresence();
    this.#prunePresence(now);
    if (input.type === "presence.join" && topic !== undefined) {
      if (!(await this.#authorizePresence(socket, topic))) {
        // Denied, not "rejoin": the client would retry immediately forever.
        const previous = this.#presence.get(socket)?.topic;
        this.#clearPresence(socket);
        if (previous !== undefined) this.#broadcastPresence(previous);
        socket.send(JSON.stringify({ type: "presence.denied", topic }));
        return;
      }
      const previous = this.#presence.get(socket)?.topic;
      this.#setPresence(socket, { topic, heartbeatAt: now });
      if (previous !== undefined && previous !== topic)
        this.#broadcastPresence(previous);
      this.#broadcastPresence(topic);
      return;
    }
    const current = this.#presence.get(socket);
    if (
      input.type === "presence.heartbeat" &&
      topic !== undefined &&
      current?.topic === topic
    ) {
      if (!(await this.#authorizePresence(socket, topic))) {
        this.#clearPresence(socket);
        this.#broadcastPresence(topic);
        socket.send(JSON.stringify({ type: "presence.denied", topic }));
        return;
      }
      this.#setPresence(socket, { topic, heartbeatAt: now });
      socket.send(JSON.stringify({ type: "presence.heartbeat", topic }));
      return;
    }
    if (
      input.type === "presence.leave" &&
      topic !== undefined &&
      current?.topic === topic
    ) {
      this.#clearPresence(socket);
      this.#broadcastPresence(topic);
      return;
    }
    if (
      (input.type === "presence.heartbeat" ||
        input.type === "presence.leave") &&
      topic !== undefined
    )
      socket.send(JSON.stringify({ type: "presence.rejoin-required", topic }));
  }

  async fetch(request: Request): Promise<Response> {
    const audience = request.headers.get(AUDIENCE_HEADER) as AudienceKey | null;
    const participant = Schema.decodeUnknownOption(UserId)(
      request.headers.get(PARTICIPANT_HEADER),
    );
    const clientId = request.headers.get(CLIENT_HEADER);
    if (
      audience === null ||
      !/^(user|workspace):[^:]+$/.test(audience) ||
      Option.isNone(participant) ||
      clientId === null ||
      Option.isNone(Schema.decodeUnknownOption(ClientId)(clientId))
    )
      return new Response(null, { status: 401 });

    const establishedAudience =
      await this.ctx.storage.get<AudienceKey>(AUDIENCE_KEY);
    if (establishedAudience !== undefined && establishedAudience !== audience)
      return new Response(null, { status: 403 });
    if (establishedAudience === undefined)
      await this.ctx.storage.put(AUDIENCE_KEY, audience);

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/subscribe")
      return this.#subscribe(request, url, {
        audience,
        participant: participant.value,
        clientId,
      });
    if (request.method === "POST" && url.pathname === "/invalidate")
      return this.#publishInvalidation(request, audience);
    return new Response(null, { status: 404 });
  }

  async #subscribe(
    request: Request,
    url: URL,
    attachment: SocketAttachment,
  ): Promise<Response> {
    const cursor = readCursor(url);
    if (
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      Number.isNaN(cursor)
    )
      return new Response(null, { status: 400 });
    const revision =
      (await this.ctx.storage.get<number>(
        revisionKey(attachment.participant),
      )) ?? 0;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    if (cursor !== undefined && cursor !== revision) {
      server.send(
        JSON.stringify({
          type: "revision-gap",
          cursor,
          revision,
          recovery: "http-refetch",
        }),
      );
      server.close(4009, "revision-gap");
    } else {
      server.send(JSON.stringify({ type: "ready", revision }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async #publishInvalidation(
    request: Request,
    audience: AudienceKey,
  ): Promise<Response> {
    const threadEvent = decodeThreadEvent(await request.json());
    if (threadEvent === undefined) return new Response(null, { status: 400 });
    this.#restorePresence();
    const topic = `thread:${threadEvent.threadId}` as const;
    const sockets = this.ctx.getWebSockets().flatMap((socket) => {
      const attachment = socket.deserializeAttachment() as
        | SocketAttachment
        | undefined;
      return attachment?.audience === audience ? [{ socket, attachment }] : [];
    });
    // The owner always receives Thread events. Members viewing a shared Thread
    // and, for sharing changes, every member in the workspace also receive
    // them, each on their own revision stream.
    const recipients = new Set<UserId>([threadEvent.ownerUserId]);
    for (const { socket, attachment } of sockets)
      if (
        threadEvent.recipients === "audience" ||
        this.#presence.get(socket)?.topic === topic
      )
        recipients.add(attachment.participant);
    const revisions = await this.ctx.storage.transaction(
      async (transaction) => {
        const next = new Map<UserId, number>();
        for (const participant of recipients) {
          const key = revisionKey(participant);
          const value = ((await transaction.get<number>(key)) ?? 0) + 1;
          await transaction.put(key, value);
          next.set(participant, value);
        }
        return next;
      },
    );
    for (const { socket, attachment } of sockets) {
      const revision = revisions.get(attachment.participant);
      if (revision === undefined) continue;
      try {
        socket.send(
          JSON.stringify({
            type: threadEvent.type,
            threadId: threadEvent.threadId,
            ...(threadEvent.status === undefined
              ? {}
              : { status: threadEvent.status }),
            revision,
          }),
        );
      } catch {
        // The hub is a hint channel. HTTP state remains authoritative.
      }
    }
    const revision = revisions.get(threadEvent.ownerUserId) ?? 0;
    return Response.json({ revision });
  }

  /**
   * A member joins a shared Thread from the hub of their home workspace, so
   * the Thread must be shared with that workspace. This holds because a
   * person belongs to at most one workspace (creating or joining another is
   * refused), so their home workspace, the owner's, and the Thread's
   * `shared_workspace_id` coincide whenever HTTP grants access.
   */
  async #authorizePresence(socket: WebSocket, topic: PresenceTopic) {
    if (this.env.DB === undefined) return false;
    const attachment = socket.deserializeAttachment() as
      | SocketAttachment
      | undefined;
    if (attachment === undefined) return false;
    const threadId = topic.slice("thread:".length);
    const workspaceId = attachment.audience.startsWith("workspace:")
      ? attachment.audience.slice("workspace:".length)
      : undefined;
    const row = await this.env.DB.prepare(
      `SELECT 1 AS authorized
         FROM threads AS thread
         JOIN projects AS project ON project.id = thread.project_id
        WHERE thread.id = ?1
          AND thread.lifecycle_state != 'deleted'
          AND (
            thread.owner_user_id = ?2
            OR (
              ?3 IS NOT NULL
              AND thread.shared_workspace_id = ?3
              AND ${sharedThreadVisibleSql("thread", "project", "?2")}
            )
          )
        LIMIT 1`,
    )
      .bind(threadId, attachment.participant, workspaceId ?? null)
      .first();
    return row !== null;
  }

  #prunePresence(now: number) {
    const changed = new Set<PresenceTopic>();
    for (const [socket, entry] of this.#presence) {
      if (now - entry.heartbeatAt <= PRESENCE_HEARTBEAT_TIMEOUT_MS) continue;
      this.#clearPresence(socket);
      changed.add(entry.topic);
    }
    for (const topic of changed) this.#broadcastPresence(topic);
  }

  #broadcastPresence(topic: PresenceTopic) {
    const participants = [...this.#presence]
      .filter(([, entry]) => entry.topic === topic)
      .map(([socket]) => socket.deserializeAttachment() as SocketAttachment)
      .map(({ participant, clientId }) => ({ userId: participant, clientId }))
      .sort((left, right) => left.clientId.localeCompare(right.clientId));
    const event = JSON.stringify({
      type: "presence.snapshot",
      topic,
      participants,
    });
    for (const [socket, entry] of this.#presence) {
      if (entry.topic !== topic) continue;
      try {
        socket.send(event);
      } catch {
        this.#presence.delete(socket);
      }
    }
  }
}

export const realtimeRoutes = new Hono<AppEnv>().get("/", async (context) => {
  const request = context.req.raw;
  const namespace = context.env.REALTIME_HUB;
  const db = context.env.DB;
  const clientId = context.req.query("clientId");
  if (
    namespace === undefined ||
    db === undefined ||
    request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
    request.headers.get("origin") !== new URL(request.url).origin ||
    clientId === undefined ||
    Option.isNone(Schema.decodeUnknownOption(ClientId)(clientId))
  )
    return context.notFound();
  const principal = context.get("principal");
  const audience = await homeAudienceForUser(db, principal.userId);
  const headers = new Headers({
    upgrade: "websocket",
    [AUDIENCE_HEADER]: audience,
    [PARTICIPANT_HEADER]: principal.userId,
    [CLIENT_HEADER]: clientId,
  });
  copyWebSocketHeaders(request, headers);
  const cursor = context.req.query("cursor");
  const search =
    cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return namespace
    .getByName(audience)
    .fetch(
      new Request(`https://realtime.internal/subscribe${search}`, { headers }),
    );
});
