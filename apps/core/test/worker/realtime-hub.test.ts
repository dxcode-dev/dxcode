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
      "INSERT OR IGNORE INTO threads (id, project_id, owner_user_id, visibility, workspace_access, shared_workspace_id, created_at, updated_at) VALUES (?, ?, ?, 'workspace', 'view', ?, ?, ?)",
    ).bind(threadId, project, owner, workspace, "2026-09-17", "2026-09-17"),
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

  it("also delivers Thread events to members viewing a shared Thread, each on their own revision", async () => {
    const audience = `workspace:${workspace}`;
    const ownerSocket = await connect(audience, owner, client(11));
    const memberSocket = await connect(audience, member, client(12));
    const [ownerReady, memberReady] = (await Promise.all([
      ownerSocket.first,
      memberSocket.first,
    ])) as Array<{ revision: number }>;
    const joined = nextMessage(memberSocket.socket);
    memberSocket.socket.send(
      JSON.stringify({ type: "presence.join", topic: `thread:${threadId}` }),
    );
    await joined;
    const ownerEvent = nextMessage(ownerSocket.socket);
    const memberEvent = nextMessage(memberSocket.socket);

    await publishRealtimeInvalidation(
      { DB: env.DB, REALTIME_HUB: env.REALTIME_HUB },
      threadId,
      "thread.invalidated",
    );

    await expect(ownerEvent).resolves.toEqual({
      type: "thread.invalidated",
      threadId,
      revision: (ownerReady?.revision ?? 0) + 1,
    });
    await expect(memberEvent).resolves.toEqual({
      type: "thread.invalidated",
      threadId,
      revision: (memberReady?.revision ?? 0) + 1,
    });
    ownerSocket.socket.close();
    memberSocket.socket.close();
  });

  it("delivers sharing changes to every member of the workspace", async () => {
    const audience = `workspace:${workspace}`;
    const memberSocket = await connect(audience, member, client(13));
    const ready = (await memberSocket.first) as { revision: number };
    const event = nextMessage(memberSocket.socket);
    await publishRealtimeInvalidation(
      { DB: env.DB, REALTIME_HUB: env.REALTIME_HUB },
      threadId,
      "thread.invalidated",
      "audience",
    );
    await expect(event).resolves.toEqual({
      type: "thread.invalidated",
      threadId,
      revision: ready.revision + 1,
    });
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
    // Denied, not "rejoin": a rejoin answer made clients retry in a loop.
    await expect(denied).resolves.toEqual({
      type: "presence.denied",
      topic: `thread:${threadId}`,
    });
    ownerSocket.socket.close();
    memberSocket.socket.close();
    outsiderSocket.socket.close();
  });

  it("relays comment typing only to others present on the Thread, storing nothing", async () => {
    const audience = `workspace:${workspace}`;
    const ownerSocket = await connect(audience, owner, client(21));
    const memberSocket = await connect(audience, member, client(22));
    const absentSocket = await connect(audience, member, client(23));
    const [, memberReady] = (await Promise.all([
      ownerSocket.first,
      memberSocket.first,
      absentSocket.first,
    ])) as Array<{ revision: number }>;
    for (const socket of [ownerSocket.socket, memberSocket.socket]) {
      const joined = nextMessage(socket);
      socket.send(
        JSON.stringify({ type: "presence.join", topic: `thread:${threadId}` }),
      );
      await joined;
    }
    const ownerSeen: Array<Record<string, unknown>> = [];
    const absentSeen: unknown[] = [];
    ownerSocket.socket.addEventListener(
      "message",
      (event) => void ownerSeen.push(JSON.parse(event.data as string)),
    );
    absentSocket.socket.addEventListener(
      "message",
      (event) => void absentSeen.push(JSON.parse(event.data as string)),
    );
    const memberSeen: unknown[] = [];
    memberSocket.socket.addEventListener(
      "message",
      (event) => void memberSeen.push(JSON.parse(event.data as string)),
    );

    memberSocket.socket.send(
      JSON.stringify({
        type: "presence.typing",
        topic: `thread:${threadId}`,
        scope: "msg-1",
      }),
    );
    // A scope that is not a message id, and typing from a socket that never
    // joined the Thread, are dropped.
    memberSocket.socket.send(
      JSON.stringify({
        type: "presence.typing",
        topic: `thread:${threadId}`,
        scope: "<script>",
      }),
    );
    absentSocket.socket.send(
      JSON.stringify({
        type: "presence.typing",
        topic: `thread:${threadId}`,
        scope: "msg-2",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ownerSeen.filter(({ type }) => type === "presence.typing")).toEqual([
      {
        type: "presence.typing",
        topic: `thread:${threadId}`,
        userId: member,
        clientId: client(22),
        scope: "msg-1",
      },
    ]);
    expect(memberSeen).toEqual([]);
    expect(
      absentSeen.filter(
        (event) => (event as { type: string }).type === "presence.typing",
      ),
    ).toEqual([]);

    // Typing advances no one's revision: the next invalidation follows on.
    const memberEvent = nextMessage(memberSocket.socket);
    await publishRealtimeInvalidation(
      { DB: env.DB, REALTIME_HUB: env.REALTIME_HUB },
      threadId,
      "comments.invalidated",
    );
    await expect(memberEvent).resolves.toEqual({
      type: "comments.invalidated",
      threadId,
      revision: (memberReady?.revision ?? 0) + 1,
    });
    ownerSocket.socket.close();
    memberSocket.socket.close();
    absentSocket.socket.close();
  });

  it("tells members present on a Space when a thread it started changes its artifacts", async () => {
    const audience = `workspace:${workspace}`;
    const space = thread(911);
    const child = thread(912);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO threads (id, project_id, owner_user_id, kind, visibility, workspace_access, shared_workspace_id, created_at, updated_at) VALUES (?, ?, ?, 'space', 'workspace', 'contribute', ?, ?, ?)",
      ).bind(space, project, owner, workspace, "2026-11-10", "2026-11-10"),
      env.DB.prepare(
        "INSERT OR IGNORE INTO threads (id, project_id, owner_user_id, parent_thread_id, visibility, workspace_access, shared_workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'workspace', 'contribute', ?, ?, ?)",
      ).bind(
        child,
        project,
        owner,
        space,
        workspace,
        "2026-11-10",
        "2026-11-10",
      ),
    ]);
    const memberSocket = await connect(audience, member, client(31));
    await memberSocket.first;
    const joined = nextMessage(memberSocket.socket);
    memberSocket.socket.send(
      JSON.stringify({ type: "presence.join", topic: `thread:${space}` }),
    );
    await joined;
    const seen: Array<Record<string, unknown>> = [];
    memberSocket.socket.addEventListener(
      "message",
      (event) => void seen.push(JSON.parse(event.data as string)),
    );

    await publishRealtimeInvalidation(
      { DB: env.DB, REALTIME_HUB: env.REALTIME_HUB },
      child,
      "artifacts.invalidated",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Not present on the child, the member hears it through the Space.
    expect(
      seen
        .filter(({ type }) => type === "artifacts.invalidated")
        .map(({ threadId: id }) => id),
    ).toEqual([space]);
    memberSocket.socket.close();
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
