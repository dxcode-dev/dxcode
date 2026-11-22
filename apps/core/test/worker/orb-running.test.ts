import { env, runInDurableObject } from "cloudflare:test";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import { DXD_RELEASE } from "../../src/execution/dxd/protocol.js";
import type { Bindings } from "../../src/http/types.js";
import { forwardDaemonUpgrade } from "../../src/threads/daemon-ingress.js";

// The Orbs running now (migration 0213's orb_running), on the real D1 and
// Thread execution object. Ways it could fail, each covered below: a daemon
// registering leaves no row, so an admin can't see the Orb run; the socket
// closing or an archive drain leaves the row, so a stopped Orb looks
// running; a reconnect leaves the old start or two rows.

const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  THREAD_EXECUTION: env.THREAD_EXECUTION,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "orb-usage-route-secret-0000000000000000",
};
const projectId = "prj_00000000-0000-4000-8000-000000000c21";
const threadId = "thr_00000000-0000-4000-8000-000000000c21";
const DAEMON_KEY = "dxd_orb-running-test-key-0123456789abcd";

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
        name: "Orb Running Owner",
        email,
        password: "orb-running-password-123",
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

const running = () =>
  env.DB.prepare(
    "SELECT started_at AS startedAt FROM orb_running WHERE thread_id = ?",
  )
    .bind(threadId)
    .all<{ startedAt: number }>()
    .then(({ results }) => results);

describe("orb_running", () => {
  it("holds a Thread's Orb while its daemon is connected, and only then", async () => {
    const owner = await signup("orb-running-owner@example.com", "203.0.113.81");
    await seed(owner.userId);
    expect(await running()).toEqual([]);

    const before = Date.now();
    const socket = await startOrb();
    const [first] = await waitFor(running, (rows) => rows.length === 1);
    expect(first?.startedAt).toBeGreaterThanOrEqual(before);
    expect(first?.startedAt).toBeLessThanOrEqual(Date.now());
    await new Promise((settle) => setTimeout(settle, 120));

    // The socket closing pauses the Orb: the row goes.
    socket.close(1000, "Orb paused");
    await waitFor(running, (rows) => rows.length === 0);

    // A new run starts a new row, never beside the old one.
    const again = await startOrb();
    const [second] = await waitFor(running, (rows) => rows.length === 1);
    expect(second?.startedAt).toBeGreaterThan(first?.startedAt ?? 0);
    await new Promise((settle) => setTimeout(settle, 120));

    // Archiving drains the daemon: the Orb stops running.
    await archiveDrain();
    again.close(1000, "drained");
    await waitFor(running, (rows) => rows.length === 0);

    // Unarchived and started again: running once more.
    await reauthorizeDaemon(owner.userId);
    const back = await startOrb();
    await waitFor(running, (rows) => rows.length === 1);
    back.close(1000, "Orb paused");
    await waitFor(running, (rows) => rows.length === 0);
  });
});
