import { env } from "cloudflare:test";
import { ThreadId, UserId } from "@dx/domain";
import { Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/app.js";
import { publishRealtimeInvalidation } from "../../src/realtime/publication.js";

const user = (sequence: number) =>
  Schema.decodeUnknownSync(UserId)(
    `usr_00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
  );
const thread = (sequence: number) =>
  Schema.decodeUnknownSync(ThreadId)(
    `thr_00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
  );
const client = (sequence: number) =>
  `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;

const nextMessage = (socket: WebSocket): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    socket.addEventListener(
      "message",
      (event) => resolve(JSON.parse(event.data as string)),
      { once: true },
    );
  });

const connect = async (
  audience: string,
  participant: UserId,
  clientId: string,
  cursor?: number,
) => {
  const response = await env.REALTIME_HUB.getByName(audience).fetch(
    `https://realtime.internal/subscribe${cursor === undefined ? "" : `?cursor=${cursor}`}`,
    {
      headers: {
        upgrade: "websocket",
        "x-dx-realtime-audience": audience,
        "x-dx-realtime-participant": participant,
        "x-dx-realtime-client": clientId,
      },
    },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("Expected realtime WebSocket.");
  const first = nextMessage(socket);
  socket.accept();
  return { socket, first };
};

const owner = Schema.decodeUnknownSync(UserId)(
  "usr_00000000000040008000000000000901",
);
const member = user(902);
const outsider = user(903);
const workspace = "realtime-workspace";
const project = "prj_00000000-0000-4000-8000-000000000901";
const threadId = thread(901);

beforeEach(async () => {
  await env.DB.batch([
    ...[owner, member, outsider].map((id, index) =>
      env.DB.prepare(
        'INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
      ).bind(id, `Realtime ${index}`, `realtime-${index}@example.test`, 1, 1),
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(workspace, "Realtime", "realtime", 1),
    env.DB.prepare(
      "INSERT OR IGNORE INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("realtime-owner", workspace, owner, "owner", 1),
    env.DB.prepare(
      "INSERT OR IGNORE INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("realtime-member", workspace, member, "member", 1),
    env.DB.prepare(
      "INSERT OR IGNORE INTO projects (id, owner_user_id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(project, owner, workspace, "Realtime", "2026-09-17", "2026-09-17"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO threads (id, project_id, owner_user_id, visibility, created_at, updated_at) VALUES (?, ?, ?, 'workspace', ?, ?)",
    ).bind(threadId, project, owner, "2026-09-17", "2026-09-17"),
  ]);
});

describe("RealtimeHub", () => {
  it("requires public authentication", async () => {
    const response = await app.request(
      `http://dx.test/v1/realtime?clientId=${client(0)}`,
      { headers: { upgrade: "websocket", origin: "http://dx.test" } },
      env,
    );
    expect(response.status).toBe(401);
  });

  it("fans content-free invalidations only to the owning user in a workspace shard", async () => {
    const audience = `workspace:${workspace}`;
    const ownerSocket = await connect(audience, owner, client(1));
    const memberSocket = await connect(audience, member, client(2));
    await Promise.all([ownerSocket.first, memberSocket.first]);
    const ownerEvent = nextMessage(ownerSocket.socket);
    const memberEvents: unknown[] = [];
    memberSocket.socket.addEventListener("message", (event) =>
      memberEvents.push(JSON.parse(event.data as string)),
    );

    await publishRealtimeInvalidation(
      { DB: env.DB, REALTIME_HUB: env.REALTIME_HUB },
      threadId,
      "changes.invalidated",
    );

    await expect(ownerEvent).resolves.toEqual({
      type: "changes.invalidated",
      threadId,
      revision: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(memberEvents).toEqual([]);
    ownerSocket.socket.close();
    memberSocket.socket.close();
  });

  it("recovers reconnect gaps through an HTTP-refetch signal", async () => {
    const audience = `workspace:${workspace}`;
    await publishRealtimeInvalidation(
      { DB: env.DB, REALTIME_HUB: env.REALTIME_HUB },
      threadId,
      "thread.invalidated",
    );
    const stale = await connect(audience, owner, client(3), 0);
    await expect(stale.first).resolves.toEqual({
      type: "revision-gap",
      cursor: 0,
      revision: expect.any(Number),
      recovery: "http-refetch",
    });
  });

  it("authorizes workspace presence and rejects an outsider", async () => {
    const audience = `workspace:${workspace}`;
    const ownerSocket = await connect(audience, owner, client(4));
    const memberSocket = await connect(audience, member, client(5));
    await Promise.all([ownerSocket.first, memberSocket.first]);
    const ownerJoined = nextMessage(ownerSocket.socket);
    ownerSocket.socket.send(
      JSON.stringify({ type: "presence.join", topic: `thread:${threadId}` }),
    );
    await ownerJoined;
    const ownerObservedMember = nextMessage(ownerSocket.socket);
    const memberJoined = nextMessage(memberSocket.socket);
    memberSocket.socket.send(
      JSON.stringify({ type: "presence.join", topic: `thread:${threadId}` }),
    );
    await expect(ownerObservedMember).resolves.toMatchObject({
      participants: [
        { userId: owner, clientId: client(4) },
        { userId: member, clientId: client(5) },
      ],
    });
    await expect(memberJoined).resolves.toMatchObject({
      type: "presence.snapshot",
    });

    const outsiderSocket = await connect(
      `user:${outsider}`,
      outsider,
      client(6),
    );
    await outsiderSocket.first;
    const denied = nextMessage(outsiderSocket.socket);
    outsiderSocket.socket.send(
      JSON.stringify({ type: "presence.join", topic: `thread:${threadId}` }),
    );
    await expect(denied).resolves.toEqual({
      type: "presence.rejoin-required",
      topic: `thread:${threadId}`,
    });
    ownerSocket.socket.close();
    memberSocket.socket.close();
    outsiderSocket.socket.close();
  });

  it("rejects payloads that could carry conversation or terminal content", async () => {
    const audience = `workspace:${workspace}`;
    const response = await env.REALTIME_HUB.getByName(audience).fetch(
      "https://realtime.internal/invalidate",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dx-realtime-audience": audience,
          "x-dx-realtime-participant": owner,
          "x-dx-realtime-client": client(7),
        },
        body: JSON.stringify({
          type: "thread.invalidated",
          threadId,
          ownerUserId: owner,
          content: "secret terminal bytes",
        }),
      },
    );
    expect(response.status).toBe(400);
  });

  it("does not expose authoritative commits to hub publication failure", async () => {
    await expect(
      publishRealtimeInvalidation(
        {
          DB: env.DB,
          REALTIME_HUB: {
            getByName: () => ({
              fetch: async () => {
                throw new Error("hub unavailable");
              },
            }),
          } as unknown as DurableObjectNamespace,
        },
        threadId,
        "thread.invalidated",
      ),
    ).resolves.toBeUndefined();
  });
});
