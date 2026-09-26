import { DurableObject } from "cloudflare:workers";
import { ThreadId, UserId } from "@dx/domain";
import { Option, Schema } from "effect";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../http/types.js";
import {
  AUDIENCE_HEADER,
  type AudienceKey,
  CLIENT_HEADER,
  homeAudienceForUser,
  PARTICIPANT_HEADER,
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
      (key) => !["type", "threadId", "ownerUserId", "status"].includes(key),
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
    (value.type !== "workspace.status" && value.status !== undefined)
  )
    return undefined;
  return {
    type: value.type as RealtimeThreadEventType,
    threadId: threadId.value,
    ownerUserId: ownerUserId.value,
    ...(value.type === "workspace.status"
      ? { status: value.status as WorkspaceStatus }
      : {}),
  };
};

export class RealtimeHub extends DurableObject<Bindings> {
  readonly #presence = new Map<WebSocket, PresenceEntry>();

  webSocketClose(socket: WebSocket): void {
    const topic = this.#presence.get(socket)?.topic;
    this.#presence.delete(socket);
    if (topic !== undefined) this.#broadcastPresence(topic);
  }

  webSocketError(socket: WebSocket): void {
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
    this.#prunePresence(now);
    if (input.type === "presence.join" && topic !== undefined) {
      if (!(await this.#authorizePresence(socket, topic))) return;
      const previous = this.#presence.get(socket)?.topic;
      this.#presence.set(socket, { topic, heartbeatAt: now });
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
        this.#presence.delete(socket);
        this.#broadcastPresence(topic);
        return;
      }
      this.#presence.set(socket, { topic, heartbeatAt: now });
      socket.send(JSON.stringify({ type: "presence.heartbeat", topic }));
      return;
    }
    if (
      input.type === "presence.leave" &&
      topic !== undefined &&
      current?.topic === topic
    ) {
      this.#presence.delete(socket);
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
    const revision = await this.ctx.storage.transaction(async (transaction) => {
      const key = revisionKey(threadEvent.ownerUserId);
      const next = ((await transaction.get<number>(key)) ?? 0) + 1;
      await transaction.put(key, next);
      return next;
    });
    const event = JSON.stringify({
      type: threadEvent.type,
      threadId: threadEvent.threadId,
      ...(threadEvent.status === undefined
        ? {}
        : { status: threadEvent.status }),
      revision,
    });
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as
        | SocketAttachment
        | undefined;
      if (
        attachment?.audience !== audience ||
        attachment.participant !== threadEvent.ownerUserId
      )
        continue;
      try {
        socket.send(event);
      } catch {
        // The hub is a hint channel. HTTP state remains authoritative.
      }
    }
    return Response.json({ revision });
  }

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
         FROM threads
         JOIN projects ON projects.id = threads.project_id
        WHERE threads.id = ?
          AND (
            threads.owner_user_id = ?
            OR (
              threads.visibility = 'workspace'
              AND projects.workspace_id = ?
              AND EXISTS (
                SELECT 1 FROM member
                 WHERE member.userId = ?
                   AND member.organizationId = projects.workspace_id
              )
            )
          )
        LIMIT 1`,
    )
      .bind(
        threadId,
        attachment.participant,
        workspaceId ?? null,
        attachment.participant,
      )
      .first();
    if (row !== null) return true;
    socket.send(JSON.stringify({ type: "presence.rejoin-required", topic }));
    return false;
  }

  #prunePresence(now: number) {
    const changed = new Set<PresenceTopic>();
    for (const [socket, entry] of this.#presence) {
      if (now - entry.heartbeatAt <= PRESENCE_HEARTBEAT_TIMEOUT_MS) continue;
      this.#presence.delete(socket);
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
