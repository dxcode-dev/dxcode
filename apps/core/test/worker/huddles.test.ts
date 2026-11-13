import { env } from "cloudflare:test";
import type { Principal } from "@dx/domain";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { threadHuddleRoutes } from "../../src/huddles/routes.js";
import { viewerMayRequest } from "../../src/thread-sharing/access.js";
import {
  bindings,
  createProjectViaApi,
  createThreadViaApi,
  otherPrincipal,
  principal,
} from "./product-route-fixture.js";

/**
 * Huddle's routes in workerd with real D1; RealtimeKit's REST API is a fake
 * that records what it was sent. The ways it could fail:
 *
 * 1. It refuses someone who can open the Thread but never changed a
 *    setting, or pretends to work on a deployment without RealtimeKit.
 * 2. Each join creates a new meeting, so people in one Thread never meet;
 *    or two Threads share a meeting.
 * 3. A person joins under someone else's id or without their dx name.
 * 4. View-only members are refused, or may make other writes.
 * 5. The summary trusts RealtimeKit's rows: lists someone who left, lists
 *    a rejoin twice, or shows people when the session ended.
 * 6. A RealtimeKit failure crashes the route instead of answering 502.
 * 7. Deployments sharing the account pick different "dx huddle" apps, or
 *    every request lists the apps again.
 */

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const withRealtimeKit: Bindings = {
  ...bindings,
  DX_REALTIMEKIT: JSON.stringify({ accountId: ACCOUNT, token: "rtk-token" }),
} as Bindings;

const appFor = (who: Principal, access: "owner" | "contribute" | "view") => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set("principal", principal);
    context.set("actor", who);
    context.set("threadAccess", access);
    context.set("threadOwnerUserId", principal.userId);
    await next();
  });
  app.route("/threads", threadHuddleRoutes);
  return app;
};

type Sent = { method: string; path: string; body?: Record<string, unknown> };

/** A RealtimeKit API: meetings, participants, and a live session. */
const fakeRealtimeKit = () => {
  const sent: Sent[] = [];
  let meetings = 0;
  let session:
    | {
        status: string;
        participants: Array<{
          custom_participant_id: string;
          left_at: string | null;
        }>;
      }
    | undefined;
  let failing = false;
  let appLists = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const kit = `/client/v4/accounts/${ACCOUNT}/realtime/kit`;
    expect(url.host).toBe("api.cloudflare.com");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer rtk-token",
    );
    const method = init?.method ?? "GET";
    const json = (data: unknown, status = 200) =>
      Response.json({ success: true, data }, { status });
    // Another deployment's app, an older "dx huddle", and a newer duplicate.
    if (method === "GET" && url.pathname === `${kit}/apps`) {
      appLists += 1;
      return json([
        { id: "other", name: "someone else", created_at: "2026-01-01" },
        { id: "app-2", name: "dx huddle", created_at: "2026-11-02" },
        { id: "app-1", name: "dx huddle", created_at: "2026-11-01" },
      ]);
    }
    const prefix = `${kit}/app-1`;
    expect(url.pathname.startsWith(prefix)).toBe(true);
    const path = url.pathname.slice(prefix.length);
    sent.push({
      method,
      path,
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) as Record<string, unknown> }
        : {}),
    });
    if (failing) return new Response("{}", { status: 500 });
    if (method === "POST" && path === "/meetings")
      return json({ id: `meeting-${++meetings}` }, 201);
    if (method === "POST" && /^\/meetings\/[^/]+\/participants$/.test(path))
      return json({ token: `join-${sent.length}` }, 201);
    if (method === "GET" && /\/active-session$/.test(path))
      return session === undefined
        ? new Response("{}", { status: 404 })
        : json({
            id: "session-1",
            status: session.status,
            started_at: "2026-11-12T10:00:00.000Z",
            live_participants: session.participants.filter(
              (p) => p.left_at === null,
            ).length,
          });
    if (method === "GET" && path === "/sessions/session-1/participants")
      return json({ participants: session?.participants ?? [] });
    return new Response("{}", { status: 404 });
  });
  return {
    sent,
    appLists: () => appLists,
    live: (next: typeof session) => {
      session = next;
    },
    fail: () => {
      failing = true;
    },
  };
};

const call = async (
  app: Hono<AppEnv>,
  threadId: string,
  on: Bindings,
  method: "GET" | "POST" = "GET",
) => {
  const response = await app.request(
    `/threads/${threadId}/huddle${method === "POST" ? "/join" : ""}`,
    { method },
    on,
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      data: {
        code?: string;
        authToken?: string;
        meetingId?: string;
        active?: boolean;
        participants?: Array<{ userId: string; name: string }>;
        startedAt?: string;
      };
    },
  };
};

let projects = 0;
/** A Thread shared with a workspace: private Threads have no huddle. */
const newThread = async () => {
  const project = await createProjectViaApi(`huddles-${++projects}`);
  const threadId = (await createThreadViaApi(project.data.id)).data.id;
  const workspaceId = `org_huddles_${projects}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Huddles', ?, 1)",
    ).bind(workspaceId, `huddles-${projects}`),
    env.DB.prepare(
      "UPDATE threads SET workspace_access = 'view', shared_workspace_id = ? WHERE id = ?",
    ).bind(workspaceId, threadId),
  ]);
  return threadId;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("huddle routes", () => {
  it("answers anyone who can open the Thread, and says so when RealtimeKit is missing", async () => {
    const thread = await newThread();
    const rtk = fakeRealtimeKit();
    // No setting: nobody has met yet.
    const idle = await call(
      appFor(principal, "owner"),
      thread,
      withRealtimeKit,
    );
    expect(idle.status).toBe(200);
    expect(idle.body.data).toMatchObject({ active: false, participants: [] });

    const missing = await call(appFor(principal, "owner"), thread, bindings);
    expect(missing.status).toBe(409);
    expect(missing.body.data.code).toBe("HUDDLE_UNAVAILABLE");
    const missingJoin = await call(
      appFor(principal, "owner"),
      thread,
      bindings,
      "POST",
    );
    expect(missingJoin.status).toBe(409);
    expect(missingJoin.body.data.code).toBe("HUDDLE_UNAVAILABLE");
    expect(rtk.sent).toEqual([]);
  });

  it("puts everyone in one Thread in one meeting, each under their own id and name", async () => {
    const thread = await newThread();
    const other = await newThread();
    const rtk = fakeRealtimeKit();

    const first = await call(
      appFor(principal, "owner"),
      thread,
      withRealtimeKit,
      "POST",
    );
    expect(first.status).toBe(200);
    expect(first.body.data.meetingId).toBe("meeting-1");
    expect(first.body.data.authToken).toMatch(/^join-/);
    // A view-only member joins the same meeting.
    const viewer = await call(
      appFor(otherPrincipal, "view"),
      thread,
      withRealtimeKit,
      "POST",
    );
    expect(viewer.status).toBe(200);
    expect(viewer.body.data.meetingId).toBe("meeting-1");
    // Another Thread gets its own meeting.
    const elsewhere = await call(
      appFor(principal, "owner"),
      other,
      withRealtimeKit,
      "POST",
    );
    expect(elsewhere.body.data.meetingId).toBe("meeting-2");
    // The oldest "dx huddle" app, looked up once per isolate.
    expect(rtk.appLists()).toBeLessThanOrEqual(1);

    expect(rtk.sent.filter(({ path }) => path === "/meetings")).toHaveLength(2);
    const added = rtk.sent.filter(({ path }) => path.endsWith("/participants"));
    expect(
      added.map(({ path, body }) => [path, body?.custom_participant_id]),
    ).toEqual([
      ["/meetings/meeting-1/participants", principal.userId],
      ["/meetings/meeting-1/participants", otherPrincipal.userId],
      ["/meetings/meeting-2/participants", principal.userId],
    ]);
    for (const { body } of added) {
      expect(body?.preset_name).toBe("group_call_participant");
      expect(typeof body?.name).toBe("string");
      expect(String(body?.name)).not.toBe("");
    }
    const row = await env.DB.prepare(
      "SELECT meeting_id FROM thread_huddles WHERE thread_id = ?",
    )
      .bind(thread)
      .first<{ meeting_id: string }>();
    expect(row?.meeting_id).toBe("meeting-1");
  });

  it("lets viewers join a huddle and nothing else they could not do before", () => {
    expect(viewerMayRequest("POST", "/v1/threads/t1/huddle/join")).toBe(true);
    expect(viewerMayRequest("GET", "/v1/threads/t1/huddle")).toBe(true);
    expect(viewerMayRequest("POST", "/v1/threads/t1/huddle")).toBe(false);
    expect(viewerMayRequest("POST", "/v1/threads/t1/messages")).toBe(false);
    expect(viewerMayRequest("POST", "/v1/threads/t1/huddle/join/x")).toBe(
      false,
    );
    // Copying the link invites only people who can open the Thread.
    expect(viewerMayRequest("POST", "/v1/threads/t1/huddle/link")).toBe(true);
  });

  it("lists only the people in the session now, once each", async () => {
    const thread = await newThread();
    const rtk = fakeRealtimeKit();
    const app = appFor(principal, "owner");

    // No meeting yet: nobody is in it, and RealtimeKit is not asked.
    const empty = await call(app, thread, withRealtimeKit);
    expect(empty.body.data).toEqual({ active: false, participants: [] });
    expect(rtk.sent).toEqual([]);

    await call(app, thread, withRealtimeKit, "POST");
    rtk.live({
      status: "LIVE",
      participants: [
        {
          custom_participant_id: principal.userId,
          left_at: "2026-11-12T10:01:00.000Z",
        },
        { custom_participant_id: otherPrincipal.userId, left_at: null },
        { custom_participant_id: principal.userId, left_at: null },
        {
          custom_participant_id: "someone-who-left",
          left_at: "2026-11-12T10:02:00.000Z",
        },
      ],
    });
    const live = await call(app, thread, withRealtimeKit);
    expect(live.status).toBe(200);
    expect(live.body.data.active).toBe(true);
    expect(live.body.data.startedAt).toBe("2026-11-12T10:00:00.000Z");
    expect(live.body.data.participants?.map(({ userId }) => userId)).toEqual([
      otherPrincipal.userId,
      principal.userId,
    ]);

    rtk.live({ status: "ENDED", participants: [] });
    const ended = await call(app, thread, withRealtimeKit);
    expect(ended.body.data).toEqual({ active: false, participants: [] });

    rtk.fail();
    const failed = await call(app, thread, withRealtimeKit);
    expect(failed.status).toBe(502);
    expect(failed.body.data.code).toBe("HUDDLE_PROVIDER_FAILED");
    const failedJoin = await call(app, thread, withRealtimeKit, "POST");
    expect(failedJoin.status).toBe(502);
  });
});
