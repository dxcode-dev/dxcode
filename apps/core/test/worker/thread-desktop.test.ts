import { env } from "cloudflare:test";
import {
  type ProjectId,
  ProjectRepository,
  ThreadRepository,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

// Ways the Desktop's Core routes can fail, each covered below:
// - an archived Thread still reaches the sandbox (wakes it, starts the
//   desktop, accepts input) through the status check or a socket;
// - a View-only member or an outsider reaches the sandbox;
// - the status check reports `ready` when the Thread execution object
//   refused, or `unavailable` when the workspace has no Desktop, so the
//   viewer retries a desktop that can never start or gives up on one that
//   can;
// - the status check does not start the desktop or wake the workspace, or
//   sends the browser's cookies to the guest;
// - the app row's window routes reach the sandbox for a View-only member,
//   an outsider, or an archived Thread, pass an action the guest never
//   validated, or read as the Desktop's socket channel.

const appOrigin = "http://dx.test";
const baseBindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_RUNTIME_MODE: "deployed",
  DX_AUTH_URL: appOrigin,
  DX_AUTH_TRUSTED_ORIGINS: appOrigin,
  BETTER_AUTH_SECRET: "desktop-integration-secret-00000000000000",
} satisfies Bindings;

interface ExecutionCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

/** A Thread execution namespace that answers like the real object. */
const fakeExecution = (respond: (request: Request) => Response) => {
  const calls: Array<ExecutionCall> = [];
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (request: Request) => {
        const body = await request.clone().text();
        calls.push({
          url: request.url,
          method: request.method,
          headers: new Headers(request.headers),
          body,
        });
        return respond(request);
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { namespace, calls };
};

const refused = (reason: string, status: number) => () =>
  new Response(null, {
    status,
    headers: { "x-dx-proxy-error": reason, "cache-control": "no-store" },
  });

let sequence = 0;
const signUp = async (label: string) => {
  sequence += 1;
  const email = `desktop-${label}-${crypto.randomUUID()}@example.com`;
  const response = await app.request(
    `${appOrigin}/api/auth/sign-up/email`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: appOrigin,
        "cf-connecting-ip": `198.51.100.${sequence % 250}`,
      },
      body: JSON.stringify({
        name: `Desktop ${label}`,
        email,
        password: "desktop-password-123",
      }),
    },
    baseBindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers
    .get("set-cookie")
    ?.match(/better-auth\.session_token=[^;,]+/)?.[0];
  if (cookie === undefined) throw new Error("Expected a session cookie.");
  const userId = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id");
  if (userId === null) throw new Error("Expected a user.");
  return { cookie, userId: Schema.decodeSync(UserId)(userId) };
};

const createThread = async (ownerUserId: UserId) => {
  sequence += 1;
  const suffix = `${Date.now().toString(16).slice(-8)}${String(sequence).padStart(4, "0")}`;
  const projectEntity = project(
    `prj_00000000-0000-4000-8000-${suffix}`,
    ownerUserId,
    `Desktop project ${suffix}`,
  );
  const threadEntity = thread(
    `thr_00000000-0000-4000-8000-${suffix}`,
    projectEntity.id as ProjectId,
    ownerUserId,
  );
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(projectEntity);
      yield* (yield* ThreadRepository).insert(threadEntity);
    }),
  );
  return threadEntity.id;
};

const checkDesktop = (bindings: Bindings, threadId: string, cookie: string) =>
  app.request(
    `${appOrigin}/v1/threads/${threadId}/desktop`,
    { headers: { cookie, accept: "application/json" } },
    bindings,
  );

const openSocket = (
  bindings: Bindings,
  threadId: string,
  cookie: string,
  channel = "ws",
) =>
  app.request(
    `${appOrigin}/v1/threads/${threadId}/desktop/${channel}`,
    {
      headers: {
        cookie,
        origin: appOrigin,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    },
    bindings,
  );

describe("Thread Desktop routes in workerd", () => {
  it("reports ready, unsupported, or unavailable from the Thread execution object", async () => {
    const owner = await signUp("status");
    const threadId = await createThread(owner.userId);
    const cases = [
      ["ready", () => new Response("ok")],
      ["unsupported", refused("desktop-unsupported", 501)],
      ["unavailable", refused("desktop-unavailable", 503)],
      ["unavailable", refused("workspace-unavailable", 503)],
      // A gateway that answers but is unhealthy is not ready.
      ["unavailable", () => new Response("starting", { status: 503 })],
    ] as const;
    for (const [expected, respond] of cases) {
      const execution = fakeExecution(respond);
      const response = await checkDesktop(
        { ...baseBindings, THREAD_EXECUTION: execution.namespace },
        threadId,
        owner.cookie,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        status: "success",
        data: { desktop: expected },
      });
      expect(execution.calls).toHaveLength(1);
      const [call] = execution.calls;
      expect(call?.url).toBe("https://thread-execution/proxy/http");
      expect(Object.fromEntries(call?.headers ?? [])).toEqual({
        "x-dx-thread-id": threadId,
        "x-dx-proxy-port": "5900",
        "x-dx-proxy-target": "/healthz",
        "x-dx-proxy-host": "127.0.0.1:5900",
        "x-dx-proxy-wake": "1",
        "x-dx-proxy-prepare": "desktop",
      });
    }

    const noExecution = await checkDesktop(
      baseBindings,
      threadId,
      owner.cookie,
    );
    await expect(noExecution.json()).resolves.toMatchObject({
      data: { desktop: "unsupported" },
    });
  });

  it("admits only the owner or a contributor of an active Thread", async () => {
    const owner = await signUp("owner");
    const member = await signUp("member");
    const outsider = await signUp("outsider");
    const threadId = await createThread(owner.userId);
    const execution = fakeExecution(refused("workspace-unavailable", 503));
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };

    expect(
      (await checkDesktop(bindings, threadId, outsider.cookie)).status,
    ).toBe(404);
    expect((await openSocket(bindings, threadId, outsider.cookie)).status).toBe(
      404,
    );

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Desktop team', ?, 1)",
      ).bind(`org-${threadId}`, `desktop-${threadId.slice(-12)}`),
      env.DB.prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
           (?1 || '-o', ?1, ?2, 'owner', 1), (?1 || '-m', ?1, ?3, 'member', 2)`,
      ).bind(`org-${threadId}`, owner.userId, member.userId),
      env.DB.prepare(
        "UPDATE threads SET shared_workspace_id = ?, workspace_access = 'view' WHERE id = ?",
      ).bind(`org-${threadId}`, threadId),
    ]);
    const viewerCheck = await checkDesktop(bindings, threadId, member.cookie);
    expect(viewerCheck.status).toBe(403);
    expect(await viewerCheck.text()).toContain("THREAD_READ_ONLY");
    expect((await openSocket(bindings, threadId, member.cookie)).status).toBe(
      403,
    );
    expect(execution.calls).toHaveLength(0);

    await env.DB.prepare(
      "UPDATE threads SET workspace_access = 'contribute', contribute_until = ? WHERE id = ?",
    )
      .bind(new Date(Date.now() + 3_600_000).toISOString(), threadId)
      .run();
    const contributor = await checkDesktop(bindings, threadId, member.cookie);
    await expect(contributor.json()).resolves.toMatchObject({
      data: { desktop: "unavailable" },
    });
    const socket = await openSocket(bindings, threadId, member.cookie);
    expect(socket.status).toBe(503);
    expect(execution.calls.map((call) => call.url)).toEqual([
      "https://thread-execution/proxy/http",
      "https://thread-execution/proxy/websocket",
    ]);
    // Only the handshake and dx's relay instructions reach the object.
    expect(execution.calls[1]?.headers.get("cookie")).toBeNull();
    expect(execution.calls[1]?.headers.get("origin")).toBeNull();
    expect(execution.calls[1]?.headers.get("x-dx-proxy-prepare")).toBe(
      "desktop",
    );
    expect(execution.calls[1]?.headers.get("x-dx-proxy-target")).toBe("/ws");
    // voxl serves one socket; Waymote's old channels reach nothing.
    for (const channel of ["stream", "control", "audio"])
      expect(
        (await openSocket(bindings, threadId, member.cookie, channel)).status,
      ).toBe(404);
    expect(execution.calls).toHaveLength(2);
  });

  it("refuses an archived Thread before reaching the sandbox", async () => {
    const owner = await signUp("archived");
    const threadId = await createThread(owner.userId);
    const execution = fakeExecution(() => new Response("ok"));
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(threadId)
      .run();

    const responses = [
      await checkDesktop(bindings, threadId, owner.cookie),
      await openSocket(bindings, threadId, owner.cookie),
    ];
    for (const response of responses) {
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        data: { code: "THREAD_ARCHIVED" },
      });
    }
    expect(execution.calls).toHaveLength(0);
  });

  it("relays the app row's window listing and actions through the Thread execution object", async () => {
    const owner = await signUp("windows");
    const member = await signUp("windows-viewer");
    const threadId = await createThread(owner.userId);
    const windows = [
      {
        id: 6291468,
        app: "terminal",
        title: "xterm",
        minimized: false,
        focused: true,
      },
      { id: 8388620, title: "Figure 1", minimized: true, focused: false },
    ];
    const execution = fakeExecution(() =>
      Response.json({ desktop: "ready", windows }),
    );
    const bindings = { ...baseBindings, THREAD_EXECUTION: execution.namespace };
    const windowsRequest = (cookie: string, body?: unknown) =>
      app.request(
        `${appOrigin}/v1/threads/${threadId}/desktop/windows`,
        body === undefined
          ? { headers: { cookie, accept: "application/json" } }
          : {
              method: "POST",
              headers: {
                cookie,
                origin: appOrigin,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            },
        bindings,
      );

    const listed = await windowsRequest(owner.cookie);
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    await expect(listed.json()).resolves.toEqual({
      status: "success",
      data: { desktop: "ready", windows },
    });
    for (const action of [
      { app: "terminal" },
      { app: "browser" },
      { window: 8388620 },
    ]) {
      const acted = await windowsRequest(owner.cookie, action);
      expect(acted.status).toBe(200);
      await expect(acted.json()).resolves.toMatchObject({
        data: { desktop: "ready" },
      });
    }
    expect(
      execution.calls.map(({ url, method, body }) => ({ url, method, body })),
    ).toEqual([
      {
        url: "https://thread-execution/desktop/windows",
        method: "GET",
        body: "",
      },
      {
        url: "https://thread-execution/desktop/windows",
        method: "POST",
        body: '{"app":"terminal"}',
      },
      {
        url: "https://thread-execution/desktop/windows",
        method: "POST",
        body: '{"app":"browser"}',
      },
      {
        url: "https://thread-execution/desktop/windows",
        method: "POST",
        body: '{"window":8388620}',
      },
    ]);
    // Only dx's own headers reach the object, never the browser's cookie.
    expect(execution.calls[0]?.headers.get("cookie")).toBeNull();
    expect(execution.calls[0]?.headers.get("x-dx-thread-id")).toBe(threadId);

    // An action the guest does not know never reaches it.
    for (const action of [
      { app: "gedit" },
      { window: 0 },
      { window: -1 },
      { app: "terminal", command: "rm -rf ~" },
      {},
    ]) {
      const refusedAction = await windowsRequest(owner.cookie, action);
      expect(refusedAction.status).toBe(400);
    }
    expect(execution.calls).toHaveLength(4);

    // An outsider and a View-only member are refused before the object.
    expect((await windowsRequest(member.cookie)).status).toBe(404);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Windows team', ?, 1)",
      ).bind(`org-${threadId}`, `windows-${threadId.slice(-12)}`),
      env.DB.prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
           (?1 || '-o', ?1, ?2, 'owner', 1), (?1 || '-m', ?1, ?3, 'member', 2)`,
      ).bind(`org-${threadId}`, owner.userId, member.userId),
      env.DB.prepare(
        "UPDATE threads SET shared_workspace_id = ?, workspace_access = 'view' WHERE id = ?",
      ).bind(`org-${threadId}`, threadId),
    ]);
    const viewer = await windowsRequest(member.cookie, { app: "terminal" });
    expect(viewer.status).toBe(403);
    expect(await viewer.text()).toContain("THREAD_READ_ONLY");
    expect((await windowsRequest(member.cookie)).status).toBe(403);
    expect(execution.calls).toHaveLength(4);

    // Archived: refused before the object.
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(threadId)
      .run();
    const archived = await windowsRequest(owner.cookie, { app: "terminal" });
    expect(archived.status).toBe(409);
    expect(execution.calls).toHaveLength(4);
  });

  it("answers unavailable when the object cannot reach the Desktop, and unsupported without one", async () => {
    const owner = await signUp("windows-down");
    const threadId = await createThread(owner.userId);
    const list = (bindings: Bindings) =>
      app.request(
        `${appOrigin}/v1/threads/${threadId}/desktop/windows`,
        { headers: { cookie: owner.cookie, accept: "application/json" } },
        bindings,
      );
    const down = fakeExecution(() => new Response(null, { status: 500 }));
    await expect(
      (
        await list({ ...baseBindings, THREAD_EXECUTION: down.namespace })
      ).json(),
    ).resolves.toEqual({
      status: "success",
      data: { desktop: "unavailable", windows: [] },
    });
    await expect((await list(baseBindings)).json()).resolves.toEqual({
      status: "success",
      data: { desktop: "unsupported", windows: [] },
    });
  });
});
