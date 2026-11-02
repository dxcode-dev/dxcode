import { env } from "cloudflare:test";
import { ProjectRepository, ThreadRepository, UserId } from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

// Pointing at the Terminal wakes a billed Orb, so the warm-up must be
// authorized exactly like the Terminal attach: only people who may open the
// Terminal reach the Thread's execution object.

const origin = "http://dx.test";
const authBindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_RUNTIME_MODE: "deployed",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "terminal-warm-secret-0000000000000000000",
} satisfies Bindings;

const signUp = async (label: string) => {
  const email = `warm-${label}-${crypto.randomUUID()}@example.com`;
  const response = await app.request(
    `${origin}/api/auth/sign-up/email`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        name: label,
        email,
        password: "terminal-warm-password-123",
      }),
    },
    authBindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers
    .get("set-cookie")
    ?.match(/better-auth\.session_token=[^;,]+/)?.[0];
  if (cookie === undefined)
    throw new Error("Expected Better Auth session cookie.");
  const userId = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id");
  if (userId === null) throw new Error("Expected Better Auth user.");
  return { cookie, userId: Schema.decodeSync(UserId)(userId) };
};

describe("Terminal warm-up authorization in workerd", () => {
  it("reaches the execution object only for people who may open the Terminal", async () => {
    const owner = await signUp("owner");
    const member = await signUp("member");
    const outsider = await signUp("outsider");
    const workspaceId = `warm-workspace-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1)",
      ).bind(workspaceId, "Warm Team", workspaceId),
      env.DB.prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
           (?1, ?3, ?4, 'owner', 1), (?2, ?3, ?5, 'member', 2)`,
      ).bind(
        `${workspaceId}-owner`,
        `${workspaceId}-member`,
        workspaceId,
        owner.userId,
        member.userId,
      ),
    ]);
    const projectEntity = project(
      "prj_00000000-0000-4000-8000-000000001437",
      owner.userId,
      "Terminal warm-up",
    );
    const threadEntity = thread(
      "thr_00000000-0000-4000-8000-000000001437",
      projectEntity.id,
      owner.userId,
    );
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).insert(projectEntity);
        yield* (yield* ThreadRepository).insert(threadEntity);
      }),
    );

    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    const namespace = {
      get: vi.fn(() => ({ fetch })),
      idFromName: vi.fn(() => ({ id: "execution" })),
    } as unknown as DurableObjectNamespace;
    const bindings = { ...authBindings, THREAD_EXECUTION: namespace };
    const warmPath = `/v1/threads/${threadEntity.id}/terminal/warm`;
    const warm = (
      cookie: string | undefined,
      headers: HeadersInit = { origin },
      path = warmPath,
    ) =>
      app.request(
        `${origin}${path}`,
        {
          method: "POST",
          headers: {
            ...(cookie === undefined ? {} : { cookie }),
            ...headers,
          },
        },
        bindings,
      );
    const share = (body: unknown) =>
      app.request(
        `${origin}/v1/threads/${threadEntity.id}/sharing`,
        {
          method: "PUT",
          headers: {
            cookie: owner.cookie,
            origin,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
        bindings,
      );

    const rejected = [
      ["signed out", undefined, { origin }, warmPath, 401],
      ["outsider", outsider.cookie, { origin }, warmPath, 404],
      ["private Thread member", member.cookie, { origin }, warmPath, 404],
      // Cookie-authenticated writes without this origin stop at sign-in.
      ["missing Origin", owner.cookie, {}, warmPath, 401],
      [
        "wrong Origin",
        owner.cookie,
        { origin: "http://attacker.test" },
        warmPath,
        401,
      ],
      [
        "nonexistent Thread",
        owner.cookie,
        { origin },
        "/v1/threads/thr_00000000-0000-4000-8000-000000001438/terminal/warm",
        404,
      ],
    ] as const;
    for (const [name, cookie, headers, path, status] of rejected) {
      expect((await warm(cookie, headers, path)).status, name).toBe(status);
      expect(fetch, name).not.toHaveBeenCalled();
    }

    // The owner's warm-up starts a background activation marked as a warm-up.
    expect((await warm(owner.cookie)).status).toBe(202);
    expect(fetch).toHaveBeenCalledOnce();
    const forwarded = new Request(
      fetch.mock.calls[0]?.[0] as unknown as string,
      fetch.mock.calls[0]?.[1] as unknown as RequestInit,
    );
    expect(new URL(forwarded.url).pathname).toBe("/daemon/activate");
    expect(forwarded.headers.get("x-dx-daemon-activate-mode")).toBe(
      "background",
    );
    expect(forwarded.headers.get("x-dx-terminal-warm")).toBe("1");
    expect(forwarded.headers.get("x-dx-thread-id")).toBe(threadEntity.id);
    expect(forwarded.headers.get("cookie")).toBeNull();

    // A workspace member with View access cannot open the Terminal, so
    // cannot wake the Orb by pointing at it.
    expect((await share({ workspaceAccess: "view" })).status).toBe(200);
    expect((await warm(member.cookie)).status).toBe(403);
    expect(fetch).toHaveBeenCalledOnce();

    // A contributor may open the Terminal, and so may warm it.
    expect(
      (
        await share({
          workspaceAccess: "contribute",
          contributeFor: "1h",
          skipMultiplayerConfirmation: true,
        })
      ).status,
    ).toBe(200);
    expect((await warm(member.cookie)).status).toBe(202);
    expect(fetch).toHaveBeenCalledTimes(2);

    // An archived Thread's Orb stays asleep.
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(threadEntity.id)
      .run();
    expect((await warm(owner.cookie)).status).toBe(409);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
