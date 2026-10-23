import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import {
  Principal,
  type ProjectId,
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import type { FlueEventContext, FlueObservation } from "@flue/runtime";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import worker from "../../src/cloudflare.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import {
  notificationPreferenceRoutes,
  notificationRoutes,
} from "../../src/notifications/routes.js";
import { SNOOZE_SWEEP_CRON } from "../../src/notifications/snooze-cron.js";
import { sweepSnoozeWakes } from "../../src/notifications/snooze-wake.js";
import { notifyTurnCompleted } from "../../src/notifications/turn-completed.js";
import { observeFlueEvent } from "../../src/observability/flue.js";
import {
  TEST_AUTH_SECRET,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";
import { attributeSubmission } from "../../src/thread-sharing/middleware.js";
import { threadSharingRoutes } from "../../src/thread-sharing/routes.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Push notifications end to end inside workerd, with real D1 and the real
 * WebCrypto the Worker uses in production. The test plays the device and its
 * push service: it generates a subscription key pair, captures what dx posts
 * to the push endpoint, and decrypts it back with nothing but RFC 8291 and
 * the device's private key. A payload that reads back correctly could only
 * have been encrypted for that device.
 */

const utf8 = new TextEncoder();

const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const joined = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

const base64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

const fromBase64Url = (value: string) => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

/** HKDF-SHA-256, written from RFC 5869 rather than shared with Core. */
const hkdf = async (
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
) => {
  const extract = await crypto.subtle.importKey(
    "raw",
    salt as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prk = new Uint8Array(
    await crypto.subtle.sign("HMAC", extract, ikm as BufferSource),
  );
  const expand = await crypto.subtle.importKey(
    "raw",
    prk as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      expand,
      concat(info, Uint8Array.of(1)) as BufferSource,
    ),
  ).slice(0, length);
};

interface Device {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly privateKey: CryptoKey;
  readonly publicKeyBytes: Uint8Array;
  readonly authSecret: Uint8Array;
}

/** A browser subscribing: a fresh P-256 pair and a 16-byte auth secret. */
const newDevice = async (endpoint: string): Promise<Device> => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const publicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    endpoint,
    p256dh: base64Url(publicKeyBytes),
    auth: base64Url(authSecret),
    privateKey: pair.privateKey,
    publicKeyBytes,
    authSecret,
  };
};

/** The browser's side of RFC 8291: unwrap one `aes128gcm` record. */
const decryptPush = async (device: Device, body: Uint8Array) => {
  const salt = body.slice(0, 16);
  const keyLength = body[20] ?? 0;
  const serverPublicKey = body.slice(21, 21 + keyLength);
  const ciphertext = body.slice(21 + keyLength);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "ECDH",
        public: await crypto.subtle.importKey(
          "raw",
          serverPublicKey as BufferSource,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          [],
        ),
      },
      device.privateKey,
      256,
    ),
  );
  const ikm = await hkdf(
    device.authSecret,
    shared,
    concat(
      utf8.encode("WebPush: info\0"),
      device.publicKeyBytes,
      serverPublicKey,
    ),
    32,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    (await hkdf(
      salt,
      ikm,
      utf8.encode("Content-Encoding: aes128gcm\0"),
      16,
    )) as BufferSource,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const nonce = await hkdf(
    salt,
    ikm,
    utf8.encode("Content-Encoding: nonce\0"),
    12,
  );
  const padded = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      key,
      ciphertext as BufferSource,
    ),
  );
  // The last record ends with a 0x02 delimiter.
  expect(padded.at(-1)).toBe(2);
  return JSON.parse(new TextDecoder().decode(padded.slice(0, -1))) as Record<
    string,
    string
  >;
};

/** Verifies the VAPID token the way a push service does (RFC 8292). */
const verifyVapid = async (authorization: string) => {
  const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(
    authorization,
  );
  expect(match).not.toBeNull();
  const [, token = "", publicKey = ""] = match ?? [];
  const [header = "", payload = "", signature = ""] = token.split(".");
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    await crypto.subtle.importKey(
      "raw",
      fromBase64Url(publicKey) as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    ),
    fromBase64Url(signature) as BufferSource,
    utf8.encode(`${header}.${payload}`) as BufferSource,
  );
  return {
    verified,
    publicKey,
    header: JSON.parse(new TextDecoder().decode(fromBase64Url(header))) as {
      alg: string;
      typ: string;
    },
    claims: JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as {
      aud: string;
      sub: string;
      exp: number;
    },
  };
};

const owner = "push-owner" as UserId;
const member = "push-member" as UserId;
const workspaceId = "push-workspace";
const ownerProject = project(
  "prj_00000000-0000-4000-8000-000000000f01",
  owner,
  "push-owner-personal",
);
const sharedThread = thread(
  "thr_00000000-0000-4000-8000-000000000f01",
  ownerProject.id as ProjectId,
  owner,
);
const childThread = thread(
  "thr_00000000-0000-4000-8000-000000000f02",
  ownerProject.id as ProjectId,
  owner,
);

/** A VAPID pair generated the way a deployment's is. */
const vapid = await (async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = base64Url(
    concat(
      Uint8Array.of(4),
      fromBase64Url(jwk.x ?? ""),
      fromBase64Url(jwk.y ?? ""),
    ),
  );
  return { publicKey, privateKey: jwk.d ?? "" };
})();

/** Who has a Thread open, as the Realtime Hub would report it. */
let watching: ReadonlyArray<UserId> = [];

const realtimeHub = {
  getByName: () => ({
    fetch: async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      return url.pathname === "/presence"
        ? Response.json({ participants: watching })
        : new Response(null, { status: 200 });
    },
  }),
} as unknown as DurableObjectNamespace;

const baseBindings: Bindings = {
  DB: env.DB,
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  DX_AUTH_URL: "https://dx.test",
  BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
  DX_SIGN_IN_PROVIDERS: "email-password",
  DX_PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
  DX_PUSH_VAPID_PRIVATE_KEY: vapid.privateKey,
  REALTIME_HUB: realtimeHub,
};

let bindings: Bindings = baseBindings;

interface CapturedPush {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

let pushes: Array<CapturedPush> = [];
let pushStatus = 201;

const createApp = (userId: UserId) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
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
  init: { method?: string; body?: unknown } = {},
) =>
  createApp(userId).request(
    path,
    {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    bindings,
  );

const message = async (
  userId: UserId,
  threadId: string,
  body: string,
  idempotencyKey: string,
) => {
  const response = await send(userId, `/v1/agents/${threadId}`, {
    method: "POST",
    body: { kind: "user", body, idempotencyKey },
  });
  expect(response.status).toBe(202);
};

const registerDevice = async (userId: UserId, device: Device) => {
  const response = await send(userId, "/v1/notifications/push/devices", {
    method: "POST",
    body: {
      endpoint: device.endpoint,
      keys: { p256dh: device.p256dh, auth: device.auth },
      label: "Chrome on macOS",
    },
  });
  expect(response.status).toBe(200);
  return response;
};

interface PushState {
  readonly available: boolean;
  readonly publicKey?: string;
  readonly devices: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly endpointHash: string;
    readonly lastDeliveredAt?: string;
  }>;
}

const pushState = async (userId: UserId) =>
  (
    await (
      await send(userId, "/v1/notifications/push")
    ).json<{
      data: PushState;
    }>()
  ).data;

const inbox = async (userId: UserId) =>
  (
    await (
      await send(userId, "/v1/notifications")
    ).json<{
      data: {
        unreadCount: number;
        items: ReadonlyArray<{ topic: string; excerpt: string }>;
      };
    }>()
  ).data;

const subscriptions = async (userId: UserId) =>
  (
    await (
      await send(userId, "/v1/settings/personal/notifications")
    ).json<{
      data: {
        subscriptions: ReadonlyArray<{
          topic: string;
          channel: string;
          enabled: boolean;
          available: boolean;
          title: string;
        }>;
      };
    }>()
  ).data.subscriptions;

const user = (id: string, name: string, handle: string) => [
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`),
  env.DB.prepare(
    "UPDATE personal_account SET username = ?2 WHERE user_id = ?1",
  ).bind(id, handle),
];

const sha256Hex = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

beforeEach(async () => {
  pushes = [];
  pushStatus = 201;
  watching = [];
  bindings = baseBindings;
  // The test is the push service: it answers every endpoint and keeps what
  // it was given, so nothing leaves the worker.
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input as RequestInfo, init);
      if (!request.url.startsWith("https://push.test/"))
        throw new Error(`Unexpected request: ${request.url}`);
      pushes.push({
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        body: new Uint8Array(await request.arrayBuffer()),
      });
      return new Response(null, { status: pushStatus });
    },
  );
  await env.DB.batch([
    ...user(owner, "Ada Owner", "ada"),
    ...user(member, "Ben Member", "ben"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Push Team', 'push-team', 1)",
    ).bind(workspaceId),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('p-owner', ?1, ?2, 'owner', 1),
         ('p-member', ?1, ?3, 'member', 2)`,
    ).bind(workspaceId, owner, member),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(ownerProject);
      yield* (yield* ThreadRepository).insert(sharedThread);
      yield* (yield* ThreadRepository).insert(childThread);
    }),
  );
  await env.DB.prepare("UPDATE threads SET parent_thread_id = ?2 WHERE id = ?1")
    .bind(childThread.id, sharedThread.id)
    .run();
  const shared = await send(owner, `/v1/threads/${sharedThread.id}/sharing`, {
    method: "PUT",
    body: { workspaceAccess: "contribute" },
  });
  expect(shared.status).toBe(200);
});

describe("Push notifications, in workerd with real D1 and WebCrypto", () => {
  it("registers a browser and never hands its endpoint back", async () => {
    const device = await newDevice("https://push.test/device-a");
    const registered = await registerDevice(member, device);
    const text = await registered.text();
    expect(text).not.toContain(device.endpoint);
    expect(text).not.toContain(device.auth);

    const state = await pushState(member);
    expect(state.available).toBe(true);
    expect(state.publicKey).toBe(vapid.publicKey);
    expect(state.devices).toEqual([
      expect.objectContaining({
        label: "Chrome on macOS",
        endpointHash: await sha256Hex(device.endpoint),
      }),
    ]);
    // Another person's devices are their own.
    expect((await pushState(owner)).devices).toEqual([]);
  });

  it("delivers a mention the device can decrypt, signed with the deployment's VAPID key", async () => {
    const device = await newDevice("https://push.test/device-a");
    await registerDevice(member, device);

    await message(owner, sharedThread.id, "@ben can you review this?", "m-1");

    expect(pushes).toHaveLength(1);
    const [push] = pushes as [CapturedPush];
    expect(push.url).toBe(device.endpoint);
    expect(push.headers["content-encoding"]).toBe("aes128gcm");
    expect(push.headers["content-type"]).toBe("application/octet-stream");
    expect(Number(push.headers.ttl)).toBeGreaterThan(0);
    // The push service sees a random salt and ciphertext, not the message.
    expect(new TextDecoder().decode(push.body)).not.toContain("review");

    const vapidToken = await verifyVapid(push.headers.authorization ?? "");
    expect(vapidToken.verified).toBe(true);
    expect(vapidToken.publicKey).toBe(vapid.publicKey);
    expect(vapidToken.header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(vapidToken.claims.aud).toBe("https://push.test");
    expect(vapidToken.claims.sub).toBe("https://dx.test");
    expect(vapidToken.claims.exp * 1_000).toBeGreaterThan(Date.now());

    expect(await decryptPush(device, push.body)).toEqual({
      title: "Ada Owner mentioned you in Test thread",
      body: "@ben can you review this?",
      url: expect.stringContaining(
        `https://dx.test/threads/${sharedThread.id}`,
      ),
      topic: "mention",
      tag: `mention:${sharedThread.id}`,
    });

    // The same mention is in the inbox, and the device records the delivery.
    expect((await inbox(member)).unreadCount).toBe(1);
    expect((await pushState(member)).devices[0]?.lastDeliveredAt).toEqual(
      expect.any(String),
    );
    const delivery = await env.DB.prepare(
      "SELECT channel, status FROM notification_delivery ORDER BY channel",
    ).all<{ channel: string; status: string }>();
    expect(delivery.results).toContainEqual({
      channel: "push",
      status: "sent",
    });
  });

  it("pushes a finished turn to the Thread's owner, and keeps it out of the Mentions inbox", async () => {
    const device = await newDevice("https://push.test/owner-device");
    await registerDevice(owner, device);

    await notifyTurnCompleted(bindings, {
      threadId: sharedThread.id as ThreadId,
      submissionId: "sub-finished",
      outcome: "completed",
    });

    expect(pushes).toHaveLength(1);
    expect(await decryptPush(device, (pushes[0] as CapturedPush).body)).toEqual(
      {
        title: "The agent finished in Test thread",
        body: "The agent finished its turn and is waiting for you.",
        url: `https://dx.test/threads/${sharedThread.id}`,
        topic: "turn_completed",
        tag: `turn_completed:${sharedThread.id}`,
      },
    );
    // The Mentions inbox stays about people, not about the agent.
    expect(await inbox(owner)).toEqual({ unreadCount: 0, items: [] });

    // Flue can report the same settlement again; the person is told once.
    await notifyTurnCompleted(bindings, {
      threadId: sharedThread.id as ThreadId,
      submissionId: "sub-finished",
      outcome: "completed",
    });
    expect(pushes).toHaveLength(1);
  });

  it("pushes the turn Flue reports settled, straight from the observation", async () => {
    const device = await newDevice("https://push.test/owner-device");
    await registerDevice(owner, device);

    // The observation the Flue runtime delivers when a turn settles.
    await observeFlueEvent(
      {
        v: 1,
        type: "submission_settled",
        instanceId: sharedThread.id,
        submissionId: "sub-observed",
        outcome: "completed",
        timestamp: new Date().toISOString(),
        eventIndex: 1,
      } as unknown as FlueObservation,
      { env: bindings } as unknown as FlueEventContext,
    );

    expect(pushes).toHaveLength(1);
    expect(await decryptPush(device, (pushes[0] as CapturedPush).body)).toEqual(
      expect.objectContaining({
        title: "The agent finished in Test thread",
        topic: "turn_completed",
      }),
    );
  });

  it("leaves a person alone when they already have the Thread open", async () => {
    const device = await newDevice("https://push.test/owner-device");
    await registerDevice(owner, device);
    watching = [owner];

    await notifyTurnCompleted(bindings, {
      threadId: sharedThread.id as ThreadId,
      submissionId: "sub-watched",
      outcome: "completed",
    });
    expect(pushes).toEqual([]);

    // The same turn reaching someone who looked away is pushed.
    watching = [];
    await notifyTurnCompleted(bindings, {
      threadId: sharedThread.id as ThreadId,
      submissionId: "sub-watched-later",
      outcome: "completed",
    });
    expect(pushes).toHaveLength(1);
  });

  it("pushes a snoozed Thread back to its owner when its wake time passes", async () => {
    const device = await newDevice("https://push.test/owner-device");
    await registerDevice(owner, device);
    const wakeAt = new Date(Date.now() - 60_000).toISOString();
    await env.DB.prepare(
      "UPDATE threads SET snoozed_until = ?2, snoozed_at = ?2 WHERE id = ?1",
    )
      .bind(sharedThread.id, wakeAt)
      .run();

    expect(await sweepSnoozeWakes(bindings)).toBe(1);
    expect(pushes).toHaveLength(1);
    expect(await decryptPush(device, (pushes[0] as CapturedPush).body)).toEqual(
      {
        title: "Test thread is back",
        body: "The Thread you snoozed is back in your sidebar.",
        url: `https://dx.test/threads/${sharedThread.id}`,
        topic: "snooze_woke",
        tag: `snooze_woke:${sharedThread.id}`,
      },
    );

    // The sweep runs every five minutes; the person hears about it once.
    await sweepSnoozeWakes(bindings);
    expect(pushes).toHaveLength(1);
    // Nothing about it belongs in the Mentions inbox.
    expect(await inbox(owner)).toEqual({ unreadCount: 0, items: [] });
  });

  it("sweeps snoozed Threads when the Worker's cron trigger fires", async () => {
    // Flue's generated entry serves fetch from app.ts and every other Worker
    // handler from cloudflare.ts's default export, so that is what a cron
    // trigger reaches in a deployment.
    const device = await newDevice("https://push.test/owner-device");
    await registerDevice(owner, device);
    await env.DB.prepare(
      "UPDATE threads SET snoozed_until = ?2, snoozed_at = ?2 WHERE id = ?1",
    )
      .bind(sharedThread.id, new Date(Date.now() - 60_000).toISOString())
      .run();

    const context = createExecutionContext();
    await worker.scheduled(
      createScheduledController({
        cron: SNOOZE_SWEEP_CRON,
        scheduledTime: Date.now(),
      }),
      bindings,
      context,
    );
    await waitOnExecutionContext(context);

    expect(pushes).toHaveLength(1);
    expect(
      await decryptPush(device, (pushes[0] as CapturedPush).body),
    ).toMatchObject({ title: "Test thread is back", topic: "snooze_woke" });
  });

  it("leaves a Thread still sleeping, and an ancient one, alone", async () => {
    const device = await newDevice("https://push.test/owner-device");
    await registerDevice(owner, device);
    await env.DB.prepare("UPDATE threads SET snoozed_until = ?2 WHERE id = ?1")
      .bind(sharedThread.id, new Date(Date.now() + 3_600_000).toISOString())
      .run();
    await env.DB.prepare("UPDATE threads SET snoozed_until = ?2 WHERE id = ?1")
      .bind(
        childThread.id,
        new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(),
      )
      .run();

    expect(await sweepSnoozeWakes(bindings)).toBe(0);
    expect(pushes).toEqual([]);
  });

  it("stays quiet for a cancelled turn and for a child Thread's own errand", async () => {
    const device = await newDevice("https://push.test/owner-device");
    await registerDevice(owner, device);

    await notifyTurnCompleted(bindings, {
      threadId: sharedThread.id as ThreadId,
      submissionId: "sub-aborted",
      outcome: "aborted",
    });
    await notifyTurnCompleted(bindings, {
      threadId: childThread.id as ThreadId,
      submissionId: "sub-child",
      outcome: "completed",
    });

    expect(pushes).toEqual([]);
  });

  it("sends nothing to a person who turned that topic's push off", async () => {
    const device = await newDevice("https://push.test/device-a");
    await registerDevice(member, device);
    const updated = await send(member, "/v1/settings/personal/notifications", {
      method: "PUT",
      body: { topic: "mention", channel: "push", enabled: false },
    });
    expect(updated.status).toBe(200);

    await message(owner, sharedThread.id, "@ben quiet please", "m-2");

    expect(pushes).toEqual([]);
    // The in-app notification is untouched by a channel choice.
    expect((await inbox(member)).unreadCount).toBe(1);
  });

  it("offers email for a mention only, and push for every topic", async () => {
    expect(
      (await subscriptions(member)).map(
        ({ topic, channel, title, enabled }) => ({
          topic,
          channel,
          title,
          enabled,
        }),
      ),
    ).toEqual([
      {
        topic: "mention",
        channel: "email",
        title: "Mention emails",
        enabled: true,
      },
      {
        topic: "mention",
        channel: "push",
        title: "Mention push",
        enabled: true,
      },
      {
        topic: "turn_completed",
        channel: "push",
        title: "Agent update push",
        enabled: true,
      },
      {
        topic: "snooze_woke",
        channel: "push",
        title: "Snoozed Thread push",
        enabled: true,
      },
    ]);

    // A choice nobody is offered cannot be stored either.
    const refused = await send(member, "/v1/settings/personal/notifications", {
      method: "PUT",
      body: { topic: "turn_completed", channel: "email", enabled: true },
    });
    expect(refused.status).toBe(400);
  });

  it("drops a device whose push service reports it gone", async () => {
    const device = await newDevice("https://push.test/device-a");
    await registerDevice(member, device);
    pushStatus = 410;

    await message(owner, sharedThread.id, "@ben are you there", "m-3");

    expect(pushes).toHaveLength(1);
    expect((await pushState(member)).devices).toEqual([]);
    // An expired device is not a failed delivery: there was nobody to tell.
    const deliveries = await env.DB.prepare(
      "SELECT channel FROM notification_delivery",
    ).all<{ channel: string }>();
    expect(deliveries.results.map(({ channel }) => channel)).not.toContain(
      "push",
    );
    expect((await inbox(member)).unreadCount).toBe(1);
  });

  it("records a refused push as a failed delivery and keeps the inbox", async () => {
    const device = await newDevice("https://push.test/device-a");
    await registerDevice(member, device);
    pushStatus = 500;

    await message(owner, sharedThread.id, "@ben still here", "m-4");

    expect((await inbox(member)).unreadCount).toBe(1);
    const delivery = await env.DB.prepare(
      "SELECT channel, status, error FROM notification_delivery WHERE channel = 'push'",
    ).first<{ channel: string; status: string; error: string }>();
    expect(delivery).toEqual({
      channel: "push",
      status: "failed",
      error: "push_send_failed",
    });
    // The device stays: a server error is not a gone subscription.
    expect((await pushState(member)).devices).toHaveLength(1);
  });

  it("moves a shared browser to whoever registered it last", async () => {
    const device = await newDevice("https://push.test/shared-browser");
    await registerDevice(member, device);
    await registerDevice(owner, device);

    expect((await pushState(member)).devices).toEqual([]);
    expect((await pushState(owner)).devices).toHaveLength(1);

    await message(owner, sharedThread.id, "@ben hello again", "m-5");
    // The browser now belongs to Ada, so Ben's mention reaches no device.
    expect(pushes).toEqual([]);
  });

  it("turns this browser off without touching the person's other devices", async () => {
    const phone = await newDevice("https://push.test/phone");
    const laptop = await newDevice("https://push.test/laptop");
    await registerDevice(member, phone);
    await registerDevice(member, laptop);

    const removed = await send(member, "/v1/notifications/push/devices", {
      method: "DELETE",
      body: { endpoint: laptop.endpoint },
    });
    expect(removed.status).toBe(200);

    await message(owner, sharedThread.id, "@ben one device", "m-6");
    expect(pushes.map(({ url }) => url)).toEqual([phone.endpoint]);
  });

  it("sends a test push through the delivery path the real ones take", async () => {
    const device = await newDevice("https://push.test/device-a");
    await registerDevice(member, device);

    const response = await send(member, "/v1/notifications/push/test", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "success",
      data: { delivered: 1, failed: 0 },
    });
    expect(await decryptPush(device, (pushes[0] as CapturedPush).body)).toEqual(
      expect.objectContaining({ topic: "test" }),
    );
  });

  it("reports push unavailable, and sends none, without VAPID keys", async () => {
    const device = await newDevice("https://push.test/device-a");
    await registerDevice(member, device);
    bindings = {
      ...baseBindings,
      DX_PUSH_VAPID_PUBLIC_KEY: undefined,
      DX_PUSH_VAPID_PRIVATE_KEY: undefined,
    };

    const unavailable = await pushState(member);
    expect(unavailable.available).toBe(false);
    expect(unavailable.publicKey).toBeUndefined();
    expect(await subscriptions(member)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "push", available: false }),
      ]),
    );
    const refused = await send(member, "/v1/notifications/push/devices", {
      method: "POST",
      body: {
        endpoint: device.endpoint,
        keys: { p256dh: device.p256dh, auth: device.auth },
      },
    });
    expect(refused.status).toBe(503);

    await message(owner, sharedThread.id, "@ben no push here", "m-7");
    expect(pushes).toEqual([]);
    expect((await inbox(member)).unreadCount).toBe(1);
  });

  it("refuses a subscription that is not a push endpoint, loopback included", async () => {
    const device = await newDevice("https://push.test/device-a");
    for (const body of [
      {
        endpoint: "http://push.test/insecure",
        keys: { p256dh: device.p256dh, auth: device.auth },
      },
      // Only a local runtime stands in for a push service on loopback.
      {
        endpoint: "http://127.0.0.1:9999/push/local",
        keys: { p256dh: device.p256dh, auth: device.auth },
      },
      {
        endpoint: device.endpoint,
        keys: { p256dh: "not base64url!", auth: device.auth },
      },
      { endpoint: device.endpoint },
    ]) {
      const response = await send(member, "/v1/notifications/push/devices", {
        method: "POST",
        body,
      });
      expect(response.status).toBe(400);
    }
    expect((await pushState(member)).devices).toEqual([]);
  });
});
