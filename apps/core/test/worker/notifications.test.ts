import { env } from "cloudflare:test";
import { parseMessageAuthor } from "@dx/api";
import {
  Principal,
  type ProjectId,
  ProjectRepository,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import {
  notificationPreferenceRoutes,
  notificationRoutes,
  notificationUnsubscribeRoutes,
} from "../../src/notifications/routes.js";
import {
  TEST_AUTH_SECRET,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";
import { attributeSubmission } from "../../src/thread-sharing/middleware.js";
import { threadSharingRoutes } from "../../src/thread-sharing/routes.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

const owner = "ntf-owner" as UserId;
const member = "ntf-member" as UserId;
const bystander = "ntf-bystander" as UserId;
const workspaceId = "ntf-workspace";
const ownerProject = project(
  "prj_00000000-0000-4000-8000-000000000e01",
  owner,
  "ntf-owner-personal",
);
const sharedThread = thread(
  "thr_00000000-0000-4000-8000-000000000e01",
  ownerProject.id as ProjectId,
  owner,
);

interface SentEmail {
  readonly from: { readonly email: string; readonly name: string };
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly headers?: Record<string, string>;
}

let sent: Array<SentEmail> = [];
let emailFails = false;

const emailBinding = {
  send: async (message: SentEmail) => {
    if (emailFails) throw new Error("Email Sending is unavailable.");
    sent.push(message);
    return { messageId: `m-${sent.length}` };
  },
} as unknown as SendEmail;

/** Magic link is off: the sender still serves notification email. */
const withSender: Bindings = {
  DB: env.DB,
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  DX_AUTH_URL: "https://dx.test",
  BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
  DX_SIGN_IN_PROVIDERS: "email-password",
  DX_AUTH_EMAIL_FROM: "notify@dx.test",
  EMAIL: emailBinding,
};
const withoutSender: Bindings = {
  ...withSender,
  DX_AUTH_EMAIL_FROM: undefined,
  EMAIL: undefined,
};
let bindings = withSender;

const createApp = (userId: UserId) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.route("/api/notifications/unsubscribe", notificationUnsubscribeRoutes);
  app.use("/v1/*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  app.route("/v1/notifications", notificationRoutes);
  app.route(
    "/v1/settings/personal/notifications",
    notificationPreferenceRoutes,
  );
  app.route("/v1/threads", threadSharingRoutes);
  app.use("/v1/agents/:threadId", authorizeThread);
  app.use("/v1/agents/:threadId", attributeSubmission);
  // Stands in for Flue's router: echoes the delivery it would admit.
  app.route(
    "/v1/agents",
    new Hono<AppEnv>().post("/:id", async (context) =>
      context.json(
        { submissionId: "sub-1", delivered: await context.req.json() },
        202,
      ),
    ),
  );
  app.onError(errorHandler);
  return app;
};

const send = (
  userId: UserId,
  path: string,
  init: { method?: string; body?: unknown; form?: string } = {},
) =>
  createApp(userId).request(
    path,
    {
      method: init.method ?? "GET",
      headers: {
        "content-type":
          init.form === undefined
            ? "application/json"
            : "application/x-www-form-urlencoded",
      },
      ...(init.form !== undefined
        ? { body: init.form }
        : init.body === undefined
          ? {}
          : { body: JSON.stringify(init.body) }),
    },
    bindings,
  );

const message = async (
  userId: UserId,
  body: string,
  idempotencyKey: string,
) => {
  const response = await send(userId, `/v1/agents/${sharedThread.id}`, {
    method: "POST",
    body: { kind: "user", body, idempotencyKey },
  });
  expect(response.status).toBe(202);
  const { delivered } = await response.json<{
    delivered: { body: string };
  }>();
  return parseMessageAuthor(delivered.body);
};

interface Inbox {
  readonly unreadCount: number;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly topic: string;
    readonly threadId: string;
    readonly threadTitle: string;
    readonly messageId?: string;
    readonly excerpt: string;
    readonly actor?: { readonly userId: string; readonly name: string };
    readonly readAt?: string;
  }>;
}

const inbox = async (userId: UserId) => {
  const response = await send(userId, "/v1/notifications");
  expect(response.status).toBe(200);
  return (await response.json<{ data: Inbox }>()).data;
};

interface Subscriptions {
  readonly subscriptions: ReadonlyArray<{
    readonly topic: string;
    readonly channel: string;
    readonly enabled: boolean;
    readonly available: boolean;
  }>;
}

const preferences = async (userId: UserId) =>
  (
    await (
      await send(userId, "/v1/settings/personal/notifications")
    ).json<{ data: Subscriptions }>()
  ).data.subscriptions;

const user = (id: string, name: string, handle: string) => [
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`),
  env.DB.prepare(
    "UPDATE personal_account SET username = ?2 WHERE user_id = ?1",
  ).bind(id, handle),
];

const unsubscribeUrl = (email: SentEmail) => {
  const match =
    /href="(https:\/\/dx\.test\/api\/notifications\/unsubscribe\?token=[^"]+)"/.exec(
      email.html,
    );
  expect(match).not.toBeNull();
  return new URL((match?.[1] ?? "").replaceAll("&amp;", "&"));
};

beforeEach(async () => {
  sent = [];
  emailFails = false;
  bindings = withSender;
  await env.DB.batch([
    ...user(owner, "Ada Owner", "ada"),
    ...user(member, "Ben Member", "ben"),
    ...user(bystander, "Cat Bystander", "cat"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Notify Team', 'notify-team', 1)",
    ).bind(workspaceId),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('n-owner', ?1, ?2, 'owner', 1),
         ('n-member', ?1, ?3, 'member', 2),
         ('n-bystander', ?1, ?4, 'member', 3)`,
    ).bind(workspaceId, owner, member, bystander),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(ownerProject);
      yield* (yield* ThreadRepository).insert(sharedThread);
    }),
  );
  const shared = await send(owner, `/v1/threads/${sharedThread.id}/sharing`, {
    method: "PUT",
    body: { workspaceAccess: "contribute" },
  });
  expect(shared.status).toBe(200);
});

describe("Mention notifications, in workerd with real D1", () => {
  it("puts a mention in the tagged member's inbox, linked to the exact message", async () => {
    const sentMessage = await message(
      owner,
      "@ben can you review the deploy?",
      "key-1",
    );
    expect(sentMessage.messageId).toMatch(/^msg_[0-9a-f]{24}$/);

    const ben = await inbox(member);
    expect(ben).toEqual({
      unreadCount: 1,
      items: [
        expect.objectContaining({
          topic: "mention",
          threadId: sharedThread.id,
          threadTitle: "Test thread",
          messageId: sentMessage.messageId,
          excerpt: "@ben can you review the deploy?",
          actor: expect.objectContaining({ userId: owner, name: "Ada Owner" }),
        }),
      ],
    });
    expect(ben.items[0]?.readAt).toBeUndefined();
    // Neither the sender nor untagged members are notified.
    expect(await inbox(owner)).toEqual({ unreadCount: 0, items: [] });
    expect(await inbox(bystander)).toEqual({ unreadCount: 0, items: [] });
  });

  it("emails the mention through the deployment sender even without magic link", async () => {
    const sentMessage = await message(owner, "@ben ship it", "key-2");
    expect(sent).toHaveLength(1);
    const email = sent[0] as SentEmail;
    expect(email.to).toBe(`${member}@example.com`);
    expect(email.from).toEqual({ email: "notify@dx.test", name: "dx" });
    expect(email.subject).toBe("Ada Owner mentioned you in Test thread");
    const open = `https://dx.test/threads/${sharedThread.id}?message=${sentMessage.messageId}`;
    expect(email.text).toContain(open);
    expect(email.text).toContain("@ben ship it");
    expect(email.html).toContain(open.replaceAll("&", "&amp;"));
    expect(email.html).toContain("Unsubscribe from mention emails");
    const unsubscribe = unsubscribeUrl(email);
    expect(email.headers?.["List-Unsubscribe"]).toBe(`<${unsubscribe.href}>`);
    expect(email.headers?.["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
  });

  it("notifies once when a client retries the same message", async () => {
    const first = await message(owner, "@ben once", "retry-key");
    const second = await message(owner, "@ben once", "retry-key");
    // A retry must stay byte-identical for Flue to deduplicate it.
    expect(second.messageId).toBe(first.messageId);
    expect((await inbox(member)).items).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("keeps the in-app notification and skips email when the member turns mention emails off", async () => {
    expect(await preferences(member)).toEqual([
      expect.objectContaining({
        topic: "mention",
        channel: "email",
        enabled: true,
        available: true,
      }),
    ]);
    const updated = await send(member, "/v1/settings/personal/notifications", {
      method: "PUT",
      body: { topic: "mention", channel: "email", enabled: false },
    });
    expect(updated.status).toBe(200);
    expect(await preferences(member)).toEqual([
      expect.objectContaining({ enabled: false }),
    ]);

    await message(owner, "@ben quiet please", "key-3");
    expect((await inbox(member)).unreadCount).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("unsubscribes with the email's one-click link, and only with a genuine token", async () => {
    await message(owner, "@ben first", "key-4");
    const link = unsubscribeUrl(sent[0] as SentEmail);

    // Opening the link only asks; mail scanners must not unsubscribe anyone.
    const page = await send(member, `${link.pathname}${link.search}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Unsubscribe");
    expect(await preferences(member)).toEqual([
      expect.objectContaining({ enabled: true }),
    ]);

    const forged = new URL(link);
    forged.searchParams.set(
      "token",
      `${link.searchParams.get("token")?.slice(0, -2)}xx`,
    );
    const refused = await send(member, `${forged.pathname}${forged.search}`, {
      method: "POST",
      form: "List-Unsubscribe=One-Click",
    });
    expect(refused.status).toBe(400);
    expect(await preferences(member)).toEqual([
      expect.objectContaining({ enabled: true }),
    ]);

    const done = await send(member, `${link.pathname}${link.search}`, {
      method: "POST",
      form: "List-Unsubscribe=One-Click",
    });
    expect(done.status).toBe(200);
    expect(await preferences(member)).toEqual([
      expect.objectContaining({ enabled: false }),
    ]);
    await message(owner, "@ben second", "key-5");
    expect(sent).toHaveLength(1);
    expect((await inbox(member)).unreadCount).toBe(2);
  });

  it("still notifies in the app when the deployment has no email sender", async () => {
    bindings = withoutSender;
    expect(await preferences(member)).toEqual([
      expect.objectContaining({ channel: "email", available: false }),
    ]);
    await message(owner, "@ben no mail here", "key-6");
    expect((await inbox(member)).unreadCount).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("keeps the in-app notification when email delivery fails", async () => {
    emailFails = true;
    await message(owner, "@ben are you there", "key-7");
    expect((await inbox(member)).unreadCount).toBe(1);
    const delivery = await env.DB.prepare(
      "SELECT channel, status FROM notification_delivery",
    ).first<{ channel: string; status: string }>();
    expect(delivery).toEqual({ channel: "email", status: "failed" });
  });

  it("marks one or all notifications read, and only the reader's own", async () => {
    await message(owner, "@ben one", "key-8");
    await message(owner, "@ben two", "key-9");
    await message(member, "@ada for you", "key-10");
    const ben = await inbox(member);
    expect(ben.unreadCount).toBe(2);
    const [newest] = ben.items;
    expect(newest?.excerpt).toBe("@ben two");

    // Ada cannot mark Ben's notification read.
    await send(owner, "/v1/notifications/read", {
      method: "POST",
      body: { ids: [newest?.id] },
    });
    expect((await inbox(member)).unreadCount).toBe(2);

    const read = await send(member, "/v1/notifications/read", {
      method: "POST",
      body: { ids: [newest?.id] },
    });
    expect(await read.json()).toMatchObject({ data: { unreadCount: 1 } });
    const after = await inbox(member);
    expect(after.items.find(({ id }) => id === newest?.id)?.readAt).toEqual(
      expect.any(String),
    );

    const all = await send(member, "/v1/notifications/read-all", {
      method: "POST",
    });
    expect(await all.json()).toMatchObject({ data: { unreadCount: 0 } });
    expect((await inbox(owner)).unreadCount).toBe(1);
  });

  it("hides notifications for a Thread the member can no longer open", async () => {
    await message(owner, "@ben look", "key-11");
    expect((await inbox(member)).items).toHaveLength(1);
    await send(owner, `/v1/threads/${sharedThread.id}/sharing`, {
      method: "PUT",
      body: { workspaceAccess: "none" },
    });
    expect(await inbox(member)).toEqual({ unreadCount: 0, items: [] });
  });

  it("reports email unavailable, and sends none, when links cannot be built", async () => {
    bindings = { ...withSender, DX_AUTH_URL: undefined };
    expect(await preferences(member)).toEqual([
      expect.objectContaining({ channel: "email", available: false }),
    ]);
    await message(owner, "@ben no links here", "key-12");
    expect((await inbox(member)).unreadCount).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("counts unread only among the notifications the inbox lists", async () => {
    const created = Date.parse("2026-10-01T00:00:00.000Z");
    await env.DB.batch(
      Array.from({ length: 55 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO notification
             (id, recipient_user_id, topic, source_key, thread_id, excerpt,
              actor_user_id, created_at)
           VALUES (?1, ?2, 'mention', ?3, ?4, ?5, ?6, ?7)`,
        ).bind(
          `ntf_${index.toString(16).padStart(32, "0")}`,
          member,
          `seed:${index}`,
          sharedThread.id,
          `@ben seeded ${index}`,
          owner,
          new Date(created + index * 1_000).toISOString(),
        ),
      ),
    );
    const listed = await inbox(member);
    expect(listed.items).toHaveLength(50);
    expect(listed.unreadCount).toBe(50);
    // Reading every listed notification clears the badge, even though
    // five older unread ones remain stored.
    const read = await send(member, "/v1/notifications/read", {
      method: "POST",
      body: { ids: listed.items.slice(0, 50).map(({ id }) => id) },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ data: { unreadCount: 0 } });
  });
});
