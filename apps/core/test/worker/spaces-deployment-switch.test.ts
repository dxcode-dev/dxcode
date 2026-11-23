import { env } from "cloudflare:test";
import {
  type ProjectId,
  ProjectRepository,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import { createAutomationTools } from "../../src/automations/agent-tools.js";
import { sweepAutomations } from "../../src/automations/sweep.js";
import type { Bindings } from "../../src/http/types.js";
import {
  createTestBindings,
  TEST_CONFIG_ENCRYPTION_KEYS,
} from "../../src/testing/bindings.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";
import { seedSpaceUsers } from "./space-users.js";

/**
 * Spaces as a deploy-time choice (`DX_SPACES_ENABLED`), through the real
 * Worker app in workerd with real D1. The same Space, its thread, and an
 * ordinary Thread are read with Spaces on and off.
 *
 * Ways it could go wrong with Spaces off: a Space route still answers; the
 * Space's own Thread opens, or its agent takes a message from a person or a
 * schedule; the settings context still tells the app to show Spaces; the
 * thread a Space started disappears from the sidebar, since it listed only
 * inside the Space; the Space lists among Threads or in search; the Space's
 * coordinator setting still answers. And with Spaces on (or the binding
 * unset), any of that changes from today.
 */

const delivered = vi.hoisted(() => ({
  messages: [] as Array<{ threadId: string; body: string }>,
}));

// The real agent admission in front of a recorder standing in for Flue.
vi.mock("../../src/agents/routes.js", async () => {
  const { Hono } = await import("hono");
  const { useAgentAdmission } = await import("../../src/agents/admission.js");
  const routes = useAgentAdmission(new Hono());
  routes.post("/:threadId", async (context) => {
    const body = (await context.req.json()) as { body: string };
    delivered.messages.push({
      threadId: context.req.param("threadId"),
      body: body.body,
    });
    return context.json({ submissionId: `sub_${crypto.randomUUID()}` }, 202);
  });
  return { dxAgentRoutes: routes };
});

const origin = "http://dx.test";
const baseBindings: Bindings = createTestBindings({
  DB: env.DB,
  REALTIME_HUB: env.REALTIME_HUB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  BETTER_AUTH_SECRET: "spaces-switch-secret-00000000000000",
  DX_SIGN_IN_PROVIDERS: "email-password",
});

const SPACE = "thr_00000000-0000-4000-8000-00000000c501";
const STARTED = "thr_00000000-0000-4000-8000-00000000c502";
const PLAIN = "thr_00000000-0000-4000-8000-00000000c503";

let owner: UserId;
let cookie = "";
let signups = 0;

beforeEach(async () => {
  delivered.messages = [];
  signups += 1;
  const email = `spaces-switch-${signups}@example.test`;
  const signedUp = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `203.0.113.${100 + signups}`,
      },
      body: JSON.stringify({
        name: "Space Owner",
        email,
        password: "spaces-switch-password-123",
      }),
    },
    baseBindings,
  );
  expect(signedUp.status).toBe(200);
  cookie = signedUp.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  owner = (await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id")) as UserId;
  await seedSpaceUsers([owner]);
  const ownerProject = project(
    `prj_00000000-0000-4000-8000-0000000c${String(signups).padStart(4, "0")}`,
    owner,
    "Launch",
  );
  await env.DB.batch([
    env.DB.prepare("DELETE FROM thread_schedule"),
    env.DB.prepare("DELETE FROM threads WHERE id IN (?1, ?2, ?3)").bind(
      SPACE,
      STARTED,
      PLAIN,
    ),
    env.DB.prepare(
      "INSERT OR REPLACE INTO user_time_zone (user_id, time_zone, updated_at) VALUES (?, 'UTC', ?)",
    ).bind(owner, new Date().toISOString()),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(ownerProject);
      const threads = yield* ThreadRepository;
      for (const id of [SPACE, STARTED, PLAIN])
        yield* threads.insert(thread(id, ownerProject.id as ProjectId, owner));
    }),
  );
  // A Space with the thread its agent started, as POST /v1/spaces and its
  // create_thread leave them.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE threads SET kind = 'space', title = 'Launch readiness' WHERE id = ?",
    ).bind(SPACE),
    env.DB.prepare(
      "INSERT INTO space (thread_id, goal, created_at) VALUES (?, 'Ship it', 1)",
    ).bind(SPACE),
    env.DB.prepare(
      "INSERT INTO space_member (space_thread_id, user_id, joined_at) VALUES (?, ?, 1)",
    ).bind(SPACE, owner),
    env.DB.prepare(
      "UPDATE threads SET parent_thread_id = ?1, started_by_thread_id = ?1, title = 'Polish checkout' WHERE id = ?2",
    ).bind(SPACE, STARTED),
  ]);
});

const modes = [
  { name: "off", value: "false", on: false },
  { name: "on", value: "true", on: true },
  { name: "unset (today's default)", value: undefined, on: true },
] as const;

describe.each(modes)("Spaces $name", ({ value, on }) => {
  const bindings: Bindings =
    value === undefined
      ? baseBindings
      : { ...baseBindings, DX_SPACES_ENABLED: value };

  const get = async (path: string) => {
    const response = await app.request(
      path,
      { headers: { cookie, origin } },
      bindings,
    );
    return {
      status: response.status,
      // biome-ignore lint/suspicious/noExplicitAny: test reads loose JSON.
      body: (await response.json().catch(() => undefined)) as any,
    };
  };

  it("answers the Space routes and the Space setting only when on", async () => {
    const spaces = await get("/v1/spaces");
    const setting = await get("/v1/settings/personal/space-agent-model");
    if (on) {
      expect(spaces.status).toBe(200);
      expect(
        spaces.body.data.items.map(
          (item: { threadId: string }) => item.threadId,
        ),
      ).toEqual([SPACE]);
      expect(setting.status).toBe(200);
    } else {
      for (const refused of [spaces, setting]) {
        expect(refused.status).toBe(404);
        expect(refused.body.data.code).toBe("SPACES_UNAVAILABLE");
      }
      expect((await get(`/v1/spaces/${SPACE}`)).status).toBe(404);
      expect((await get("/v1/spaces/discover")).status).toBe(404);
    }
  });

  it("opens the Space's own Thread and its agent only when on", async () => {
    const detail = await get(`/v1/threads/${SPACE}`);
    const message = await app.request(
      `/v1/agents/dx/${SPACE}`,
      {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({
          kind: "user",
          body: "Status?",
          idempotencyKey: crypto.randomUUID(),
        }),
      },
      bindings,
    );
    const comments = await get(`/v1/threads/${SPACE}/message-comments`);
    if (on) {
      expect(detail.status).toBe(200);
      expect(detail.body.data.kind).toBe("space");
      expect(message.status).toBe(202);
      expect(delivered.messages.map(({ threadId }) => threadId)).toEqual([
        SPACE,
      ]);
      expect(comments.status).toBe(200);
    } else {
      expect(detail.status).toBe(404);
      expect(detail.body.data.code).toBe("THREAD_NOT_FOUND");
      expect(message.status).toBe(404);
      expect(comments.status).toBe(404);
      expect(delivered.messages).toEqual([]);
    }
    // The thread a Space started is an ordinary Thread either way.
    expect((await get(`/v1/threads/${STARTED}`)).status).toBe(200);
  });

  it("tells the app whether to show Spaces", async () => {
    const context = await get("/v1/settings/personal");
    expect(context.status).toBe(200);
    expect(context.body.data.spaces).toBe(on ? true : undefined);
  });

  it("lists the thread a Space started in the sidebar when Spaces are off", async () => {
    const roots = await get(
      "/v1/threads?limit=100&lifecycleState=active&roots=true",
    );
    expect(roots.status).toBe(200);
    const ids = roots.body.data.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(PLAIN);
    expect(ids).not.toContain(SPACE);
    // On, it lists inside its Space; off, there is no Space to list it in.
    expect(ids.includes(STARTED)).toBe(!on);

    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived', archived_at = 1 WHERE id = ?",
    )
      .bind(SPACE)
      .run();
    const archived = await get(
      "/v1/threads?limit=100&lifecycleState=archived&roots=true",
    );
    expect(
      archived.body.data.items.map((item: { id: string }) => item.id),
    ).toEqual(on ? [SPACE] : []);
  });

  it("finds the Space in search only when on", async () => {
    const found = await get("/v1/thread-search?q=project%3ALaunch");
    expect(found.status).toBe(200);
    const ids = found.body.data.items.map(
      (item: { threadId?: string; id?: string }) => item.threadId ?? item.id,
    );
    expect(ids).toContain(STARTED);
    expect(ids.includes(SPACE)).toBe(on);
  });

  it("wakes the Space on its schedule only when on", async () => {
    const [setSchedule, getSchedule] = (
      ["set_schedule", "get_schedule"] as const
    ).map(
      (name) =>
        createAutomationTools(
          SPACE,
          () => ({ db: env.DB, bindings }),
          "sub_turn",
        ).find((tool) => tool.name === name) as {
          run: (input: never) => Promise<{ output: unknown }>;
        },
    );
    await setSchedule?.run({
      data: {
        title: "Daily check-in",
        prompt: "Ask each thread for status.",
        schedule: "DTSTART:20990101T000000Z\nRRULE:FREQ=DAILY;COUNT=1",
        schedule_label: "Once, 1 January 2099",
      },
      toolCallId: crypto.randomUUID(),
      signal: undefined,
    } as never);
    await sweepAutomations(bindings, new Date("2099-01-01T00:00:00Z"));
    const schedule = (
      await getSchedule?.run({
        data: {},
        toolCallId: crypto.randomUUID(),
        signal: undefined,
      } as never)
    )?.output as { lastRun?: { status: string; detail?: string } };
    if (on) {
      expect(delivered.messages.map(({ threadId }) => threadId)).toEqual([
        SPACE,
      ]);
    } else {
      expect(delivered.messages).toEqual([]);
      expect(schedule.lastRun).toMatchObject({
        status: "skipped",
        detail: "Spaces are off on this deployment.",
      });
    }
  });
});
