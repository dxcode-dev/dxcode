import { env, runInDurableObject } from "cloudflare:test";
import { createHash } from "node:crypto";
import { GetOrbUsageResponseSchema } from "@dx/api";
import { DateTime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import { DXD_RELEASE } from "../../src/execution/dxd/protocol.js";
import type { Bindings } from "../../src/http/types.js";
import { forwardDaemonUpgrade } from "../../src/threads/daemon-ingress.js";

// Settings → Usage → Orb on the real route, D1 and Thread execution object: a
// daemon registering makes the Orb run, its socket closing pauses it, and the
// page counts the time between from the object's own record.

const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  THREAD_EXECUTION: env.THREAD_EXECUTION,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "orb-usage-route-secret-0000000000000000",
};
const projectId = "prj_00000000-0000-4000-8000-000000000c01";
const threadId = "thr_00000000-0000-4000-8000-000000000c01";
const DAEMON_KEY = "dxd_orb-usage-test-key-0123456789abcdef";
const endpoint = "/v1/settings/personal/orb-usage";

const signup = async (email: string, ipAddress: string) => {
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": ipAddress,
      },
      body: JSON.stringify({
        name: "Orb Usage Owner",
        email,
        password: "orb-usage-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Expected session cookie.");
  const userId = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id");
  if (userId === null) throw new Error("Expected the user.");
  return { cookie, userId };
};

const orbUsage = async (cookie: string) => {
  const response = await app.request(
    endpoint,
    { headers: { origin, cookie } },
    bindings,
  );
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(GetOrbUsageResponseSchema)(
    await response.json(),
  ).data;
};

const seed = async (owner: string) => {
  const now = new Date().toISOString();
  const keyId = `key-${threadId}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(projectId, owner, "dx", now, now),
    env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(threadId, projectId, owner, "Orb usage Thread", now, now),
    // The Thread's Orb was created, as activation leaves it.
    env.DB.prepare(
      `UPDATE execution_workspace
       SET state = 'provisioning', initialization_attempt_id = 'attempt-1',
           runner_profile_id = 'a1.medium', updated_at = ?
       WHERE thread_id = ?`,
    ).bind(now, threadId),
    env.DB.prepare(
      `UPDATE execution_workspace
       SET state = 'initialized', initialization_attempt_id = NULL,
           provider_sandbox_id = 'sandbox-orb-usage', updated_at = ?
       WHERE thread_id = ?`,
    ).bind(now, threadId),
    env.DB.prepare(
      `INSERT OR REPLACE INTO apikey
         (id, configId, referenceId, key, enabled, createdAt, updatedAt)
       VALUES (?, 'daemon-keys', ?, 'hashed', 1, ?, ?)`,
    ).bind(keyId, owner, Date.now(), Date.now()),
  ]);
  await runInDurableObject(
    env.THREAD_EXECUTION.getByName(threadId),
    async (_instance, state) => {
      await state.storage.put("daemon-authority", {
        threadId,
        generation: 1,
        apiKeyId: keyId,
        apiKeyHash: createHash("sha256").update(DAEMON_KEY).digest("hex"),
        release: DXD_RELEASE,
        protocolMajor: 2,
        terminalVersion: 1,
        workloadIdentityVersion: 1,
        runtimeProvider: "e2b",
        runtimeAssurance: "dx_dxd_channel_v1",
      });
    },
  );
  // Restart the object, as eviction does, so it loads the stored authority.
  await runInDurableObject(
    env.THREAD_EXECUTION.getByName(threadId),
    async (_instance, state) => {
      state.abort("reload the daemon authority");
    },
  ).catch(() => undefined);
};

/**
 * Activation again after an unarchive: a fresh daemon key and authority,
 * as the drain on archive revoked the old ones.
 */
const reauthorizeDaemon = async (owner: string) => {
  const keyId = `key-${threadId}`;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO apikey
       (id, configId, referenceId, key, enabled, createdAt, updatedAt)
     VALUES (?, 'daemon-keys', ?, 'hashed', 1, ?, ?)`,
  )
    .bind(keyId, owner, Date.now(), Date.now())
    .run();
  await runInDurableObject(
    env.THREAD_EXECUTION.getByName(threadId),
    async (_instance, state) => {
      await state.storage.put("daemon-authority", {
        threadId,
        generation: 2,
        apiKeyId: keyId,
        apiKeyHash: createHash("sha256").update(DAEMON_KEY).digest("hex"),
        release: DXD_RELEASE,
        protocolMajor: 2,
        terminalVersion: 1,
        workloadIdentityVersion: 1,
        runtimeProvider: "e2b",
        runtimeAssurance: "dx_dxd_channel_v1",
      });
    },
  );
  await runInDurableObject(
    env.THREAD_EXECUTION.getByName(threadId),
    async (_instance, state) => {
      state.abort("reload the daemon authority");
    },
  ).catch(() => undefined);
};

/** Archiving the Thread drains its daemon, as the provider does. */
const archiveDrain = async () => {
  const response = await env.THREAD_EXECUTION.getByName(threadId).fetch(
    new Request("https://thread-execution/daemon/drain", {
      method: "POST",
      headers: {
        "x-dx-daemon-drain": "1",
        "x-dx-thread-id": threadId,
        "x-dx-daemon-drain-reason": "thread-archived",
      },
    }),
  );
  expect(response.ok).toBe(true);
};

/** The Orb's daemon connects through the ingress and registers. */
const startOrb = async () => {
  const response = await forwardDaemonUpgrade(
    new Request(`https://dxd.test/v1/dxd/${threadId}`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${DAEMON_KEY}` },
    }),
    env.THREAD_EXECUTION,
    threadId,
  );
  const socket = response.webSocket;
  if (socket === null) throw new Error(`No socket (${response.status}).`);
  socket.accept();
  let registered = false;
  socket.addEventListener("message", (event) => {
    if (
      typeof event.data === "string" &&
      JSON.parse(event.data).type === "registered"
    )
      registered = true;
  });
  socket.send(
    JSON.stringify({
      type: "register",
      protocolMajor: 2,
      release: DXD_RELEASE,
      capabilities: {
        terminal: { version: 1 },
        workloadIdentity: { version: 1 },
      },
    }),
  );
  for (let attempt = 0; attempt < 100 && !registered; attempt += 1)
    await new Promise((settle) => setTimeout(settle, 20));
  expect(registered).toBe(true);
  return socket;
};

const waitFor = async <A>(
  read: () => Promise<A>,
  done: (value: A) => boolean,
) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((settle) => setTimeout(settle, 30));
  }
  throw new Error("The Orb's state did not change.");
};

describe("Settings → Usage → Orb", () => {
  it("shows an Orb running while its daemon is connected, then paused with its time", async () => {
    const owner = await signup("orb-usage-owner@example.com", "203.0.113.71");
    const outsider = await signup(
      "orb-usage-outsider@example.com",
      "203.0.113.72",
    );
    expect(
      (await app.request(endpoint, { headers: { origin } }, bindings)).status,
    ).toBe(401);
    await seed(owner.userId);

    // Before any run is recorded the Orb is paused, with no time to show.
    const before = await orbUsage(owner.cookie);
    expect(before.running).toEqual([]);
    expect(before.paused).toEqual([
      {
        threadId,
        title: "Orb usage Thread",
        projectName: "dx",
        size: "a1.medium",
        pausedAt: null,
        last24hMs: null,
      },
    ]);

    const startedAt = Date.now();
    const socket = await startOrb();
    const running = await orbUsage(owner.cookie);
    expect(running.paused).toEqual([]);
    expect(running.running).toEqual([
      expect.objectContaining({ threadId, size: "a1.medium", pausedAt: null }),
    ]);
    await new Promise((settle) => setTimeout(settle, 250));

    socket.close(1000, "Orb paused");
    const pausedBy = Date.now();
    const after = await waitFor(
      () => orbUsage(owner.cookie),
      (data) => data.running.length === 0,
    );
    const paused = after.paused[0];
    expect(paused?.threadId).toBe(threadId);
    if (paused?.pausedAt === null || paused?.pausedAt === undefined)
      throw new Error("Expected the pause time.");
    const pausedAt = DateTime.toEpochMillis(paused.pausedAt);
    expect(pausedAt).toBeGreaterThanOrEqual(startedAt);
    expect(pausedAt).toBeLessThanOrEqual(Date.now());
    // It ran from registering to its last heartbeat, inside the test's window.
    expect(paused.last24hMs).toBeGreaterThanOrEqual(0);
    expect(paused.last24hMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      pausedBy - startedAt + 1_000,
    );

    // A second run adds to the first.
    const again = await startOrb();
    await new Promise((settle) => setTimeout(settle, 250));
    const second = await orbUsage(owner.cookie);
    expect(second.running[0]?.last24hMs ?? 0).toBeGreaterThan(
      paused.last24hMs ?? 0,
    );
    again.close(1000, "Orb paused");

    // Archiving drains the daemon: the run ends then, and the time the
    // Thread stays archived never counts, even after it is unarchived.
    const third = await startOrb();
    await new Promise((settle) => setTimeout(settle, 150));
    await archiveDrain();
    third.close(1000, "drained");
    const archived = await waitFor(
      () => orbUsage(owner.cookie),
      (data) => data.running.length === 0,
    );
    const archivedMs = archived.paused[0]?.last24hMs ?? 0;
    expect(archived.paused[0]?.pausedAt).not.toBeNull();
    const archivedFor = 800;
    await new Promise((settle) => setTimeout(settle, archivedFor));
    await reauthorizeDaemon(owner.userId);
    const unarchived = await startOrb();
    const back = await orbUsage(owner.cookie);
    expect(back.running.map((row) => row.threadId)).toEqual([threadId]);
    expect(back.running[0]?.last24hMs ?? 0).toBeLessThan(
      archivedMs + archivedFor / 2,
    );
    unarchived.close(1000, "Orb paused");

    // Someone else's page never lists it.
    const theirs = await orbUsage(outsider.cookie);
    expect(theirs).toMatchObject({ running: [], paused: [] });
  });
});
