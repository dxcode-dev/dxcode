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
//   sends the browser's cookies to the guest.

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
  readonly headers: Headers;
}

/** A Thread execution namespace that answers like the real object. */
const fakeExecution = (respond: (request: Request) => Response) => {
  const calls: Array<ExecutionCall> = [];
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (request: Request) => {
        calls.push({ url: request.url, headers: new Headers(request.headers) });
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
  channel = "control",
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
      await openSocket(bindings, threadId, owner.cookie, "control"),
      await openSocket(bindings, threadId, owner.cookie, "stream"),
    ];
    for (const response of responses) {
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        data: { code: "THREAD_ARCHIVED" },
      });
    }
    expect(execution.calls).toHaveLength(0);
  });
});
