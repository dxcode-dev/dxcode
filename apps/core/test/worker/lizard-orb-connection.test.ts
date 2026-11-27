import { env } from "cloudflare:test";
import { Principal, type UserId } from "@dx/domain";
import { Effect, Redacted, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { sweepIdleDeadlines } from "../../src/execution/idle-deadlines.js";
import { makeLizardConnector } from "../../src/execution/lizard/connector.js";
import {
  makeLizardExecutionProvider,
  pauseIdleLizardSandbox,
} from "../../src/execution/lizard/provider.js";
import { resolveExecutionTarget } from "../../src/execution/runner-profiles/execution.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import type { OrbProviderConnectors } from "../../src/plugins/execution/connector.js";
import { makePersonalOrbProviderRoutes } from "../../src/plugins/execution/orb-provider-routes.js";
import { resolveThreadExecutionPin } from "../../src/plugins/execution/orb-providers.js";
import { advanceConnection } from "../../src/plugins/execution/preparation.js";
import {
  type ExecutionContext,
  resolveExecutionProviders,
} from "../../src/plugins/execution/provider.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { fakeLizard, type LizardWorld, lizardWorld } from "./fake-lizard.js";

/**
 * Lizard in a person's own Lizard project (BYOK; owner, 2026-11-17: no
 * deployment runs Lizard on its own account), over real D1 with Lizard
 * faked at the HTTP boundary.
 *
 * Ways it could fail, each covered below: a deployment installs Lizard on
 * its own account from an old LIZARD_API_KEY binding; a bad key or a
 * project the key cannot reach is saved; preparation builds one snapshot
 * for every size although each size restores only at its own; a size the
 * account cannot start (Large on the trial) fails the whole preparation
 * instead of being unavailable with Lizard's reason, or a failed size's
 * build stays running; a Thread pins another size's snapshot, runs as
 * root, or sends the key anywhere but the Authorization header; an idle
 * Orb is never paused (Lizard has no pause of its own and its timeout
 * deletes the disk), is paused with no key because the sweep looked for a
 * deployment key, one whose activity moved its deadline is paused anyway,
 * or a failed pause is never retried; a paused Orb is not resumed on the
 * next activation, or does not say its processes restarted; archiving
 * deletes instead of pausing, or destroying keeps the sandbox.
 */

const owner = "lz-byok-owner" as UserId;
const project = "prj_00000000-0000-4000-8000-0000000009a1";
const threadId = "thr_00000000-0000-4000-8000-0000000009a2";
const timestamp = "2026-11-17T00:00:00.000Z";

let world: LizardWorld;
let connectors: OrbProviderConnectors;
let send: typeof fetch;

/** No Lizard binding at all: only people's own projects run it. */
const bindings: Bindings = {
  DB: env.DB,
  DX_RUNTIME_MODE: "deployed",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
};

const call = async (
  path: string,
  method: "GET" | "PUT" = "GET",
  body?: unknown,
  using: Bindings = bindings,
) => {
  const router = new Hono<AppEnv>();
  router.use("*", requestId);
  router.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId: owner,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  router.route(
    "/personal/orb-providers",
    makePersonalOrbProviderRoutes({ connectors }),
  );
  router.onError(errorHandler);
  const response = await router.request(
    `/personal/orb-providers${path}`,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    },
    using,
  );
  const text = await response.text();
  // The key never comes back from the API.
  expect(text).not.toContain(world.apiKey);
  // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted below.
  return { status: response.status, body: JSON.parse(text) as any };
};

const lizardOf = async () =>
  (
    (await call("")).body.data.providers as Array<{
      id: string;
      // biome-ignore lint/suspicious/noExplicitAny: asserted below.
      connection: any;
      // biome-ignore lint/suspicious/noExplicitAny: asserted below.
      fields: any;
      deployment: boolean;
    }>
  ).find(({ id }) => id === "lizard");

const connect = (credentials: Record<string, string>) =>
  call("/lizard/connection", "PUT", { credentials });

const prepare = async () => {
  for (let step = 0; step < 60; step += 1) {
    const outcome = await advanceConnection(
      bindings,
      env.DB,
      { scope: "personal", targetId: owner, providerId: "lizard" },
      connectors,
    );
    if (outcome.nextStepInMs === undefined) return;
  }
  throw new Error("Preparation never finished.");
};

const pin = (runnerProfileId: string) =>
  resolveThreadExecutionPin({
    db: env.DB,
    bindings,
    userId: owner,
    projectId: project,
    runnerProfileId,
    connectors,
  });

/** Pins the Thread to `runnerProfileId` as a new Thread would. */
const pinThread = async (runnerProfileId: string) => {
  const pinned = await pin(runnerProfileId);
  await env.DB.prepare(
    "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(threadId, project, owner, timestamp, timestamp)
    .run();
  await env.DB.prepare(
    `UPDATE execution_workspace
        SET provider = ?, runner_profile_id = ?, account_scope = ?,
            account_owner_id = ?, provider_account = ?, provider_template = ?
      WHERE thread_id = ?`,
  )
    .bind(
      pinned?.provider,
      pinned?.runnerProfileId,
      pinned?.credentialScope,
      pinned?.credentialOwnerId,
      pinned?.credentialAccount,
      pinned?.providerTemplate,
      threadId,
    )
    .run();
  return pinned;
};

const idleRows = async () =>
  (
    await env.DB.prepare(
      "SELECT provider_id, sandbox_id, thread_id FROM orb_idle_deadline",
    ).all()
  ).results;

const sweep = (now: number) =>
  sweepIdleDeadlines(
    bindings,
    {
      lizard: (sweepBindings, sandboxId, thread) =>
        pauseIdleLizardSandbox(sweepBindings, sandboxId, thread, send),
    },
    now,
  );

beforeEach(async () => {
  world = lizardWorld();
  send = fakeLizard(world) as typeof fetch;
  connectors = { lizard: makeLizardConnector({ fetch: send }) };
  await env.DB.batch([
    env.DB.prepare("DELETE FROM orb_idle_deadline"),
    env.DB.prepare(
      'INSERT OR REPLACE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(owner, owner, `${owner}@example.com`, 1, 1),
    env.DB.prepare(
      `INSERT OR REPLACE INTO projects (id, owner_user_id, workspace_id, name, runner_profile_id, created_at, updated_at)
       VALUES (?, ?, NULL, 'Lizard project', 'lz.medium', ?, ?)`,
    ).bind(project, owner, timestamp, timestamp),
  ]);
});

describe("Lizard in a person's own project", () => {
  it("is never the deployment's account, even with an old LIZARD_API_KEY binding, and refuses a bad key or project", async () => {
    const legacy = {
      ...bindings,
      LIZARD_API_KEY: world.apiKey,
      LIZARD_PROJECT_ID: world.projectId,
    } as Bindings;
    expect(
      resolveExecutionProviders(legacy).map(({ providerId }) => providerId),
    ).not.toContain("lizard");
    const listed = await lizardOf();
    expect(listed).toMatchObject({
      deployment: false,
      connection: null,
      fields: [
        { id: "apiKey", secret: true },
        { id: "projectId", secret: false },
      ],
    });
    // Nothing to start on before the person connects.
    await expect(pin("lz.small")).rejects.toMatchObject({
      reason: "no-provider",
    });

    const badKey = await connect({
      apiKey: "liz_wrong",
      projectId: world.projectId,
    });
    expect(badKey.status).toBe(400);
    expect(badKey.body.data.detail).toBe("Lizard rejected this API key.");
    const badProject = await connect({
      apiKey: world.apiKey,
      projectId: "prj_someone_else",
    });
    expect(badProject.status).toBe(400);
    expect(badProject.body.data.detail).toMatch(/no such project/);
    expect(world.sandboxes.size).toBe(0);
  });

  it("builds and checks one snapshot per size, marks a size the account refuses unavailable, and leaves nothing running", async () => {
    const saved = await connect({
      apiKey: world.apiKey,
      projectId: world.projectId,
    });
    expect(saved.status).toBe(200);
    // The account is the project, the same for every key of it.
    expect((await lizardOf())?.connection).toMatchObject({
      account: world.projectId,
      status: "preparing",
    });
    // Before preparation no Thread can start.
    await expect(pin("lz.medium")).rejects.toMatchObject({
      reason: "preparing",
    });
    await prepare();
    expect((await lizardOf())?.connection).toMatchObject({ status: "ready" });

    // A build per size the account may start, from the claude template.
    const builds = [...world.sandboxes.values()].filter(
      ({ template }) => template === "claude",
    );
    expect(builds.map(({ size }) => size).sort()).toEqual(
      ["medium", "mini", "small"].sort(),
    );
    for (const build of builds) {
      // Within the hour Lizard's trial allows a sandbox.
      expect(build.timeoutMs).toBeGreaterThan(0);
      expect(build.timeoutMs).toBeLessThanOrEqual(60 * 60_000);
      expect(
        build.execs.some(
          ({ cmd, user }) =>
            cmd.includes("install.sh --vm") && user === undefined,
        ),
      ).toBe(true);
    }
    // A snapshot per size, each taken at its own size, and a test Orb from
    // each ran dx-orb-check.
    const snapshots = [...world.snapshots.values()];
    expect(snapshots.map(({ size }) => size).sort()).toEqual(
      ["medium", "mini", "small"].sort(),
    );
    const probes = [...world.sandboxes.values()].filter(
      ({ snapshotId }) => snapshotId !== null,
    );
    expect(probes).toHaveLength(3);
    for (const probe of probes)
      expect(
        probe.execs.some(({ cmd }) => cmd.includes("/opt/dx/bin/dx-orb-check")),
      ).toBe(true);
    expect(
      [...world.sandboxes.values()].filter(
        ({ status }) => status !== "stopped",
      ),
    ).toEqual([]);

    // Threads pin their own size's snapshot on the person's project.
    for (const size of ["mini", "small", "medium"]) {
      const pinned = await pin(`lz.${size}`);
      const snapshot = snapshots.find((entry) => entry.size === size);
      expect(pinned).toMatchObject({
        provider: "lizard",
        credentialScope: "personal",
        credentialOwnerId: owner,
        credentialAccount: world.projectId,
        providerTemplate: snapshot?.id,
      });
    }
    // Large, which the trial refuses, is unavailable with Lizard's reason.
    await expect(pin("lz.large")).rejects.toMatchObject({
      reason: "size-unavailable",
    });
    expect(
      JSON.stringify((await lizardOf())?.connection.unavailableSizes),
    ).toContain("Sandboxes are not available");
  });

  it("takes one snapshot per size even when Lizard's answer to it is lost", async () => {
    // A full VM's snapshot can outlast the request: the first two answers
    // are lost although Lizard takes both snapshots.
    world.loseSnapshotAnswers = 2;
    await connect({ apiKey: world.apiKey, projectId: world.projectId });
    await prepare();
    expect((await lizardOf())?.connection.status).toBe("ready");
    const names = [...world.snapshots.values()].map(({ name }) => name);
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
  });

  it("retries a size Lizard is too busy to start now, instead of giving it up", async () => {
    // The trial runs 1 Small at a time: a refusal for that is retried.
    world.busyOnce.add("small");
    await connect({ apiKey: world.apiKey, projectId: world.projectId });
    await prepare();
    expect((await pin("lz.small"))?.provider).toBe("lizard");
    expect(world.busyOnce.size).toBe(0);
  });

  it("keeps the other sizes when one size's build fails, and fails only when none can run", async () => {
    world.failingSetup.add("mini");
    await connect({ apiKey: world.apiKey, projectId: world.projectId });
    await prepare();
    expect((await lizardOf())?.connection.status).toBe("ready");
    await expect(pin("lz.mini")).rejects.toMatchObject({
      reason: "size-unavailable",
    });
    expect((await pin("lz.small"))?.provider).toBe("lizard");
    expect(
      JSON.stringify((await lizardOf())?.connection.unavailableSizes),
    ).toContain("No space left on device");
    // The failed build is deleted, and so is any snapshot it left.
    expect(
      [...world.sandboxes.values()].filter(
        ({ status }) => status !== "stopped",
      ),
    ).toEqual([]);
    expect(
      [...world.snapshots.values()].filter(({ size }) => size === "mini"),
    ).toEqual([]);

    // An account that can start no size fails, with every reason.
    world = lizardWorld({ allowedSizes: new Set() });
    send = fakeLizard(world) as typeof fetch;
    connectors = { lizard: makeLizardConnector({ fetch: send }) };
    await connect({ apiKey: world.apiKey, projectId: world.projectId });
    await prepare();
    const failed = (await lizardOf())?.connection;
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("No Orb size could run");
  });

  it("starts a Thread from its size's snapshot as `user`, pauses it when idle with the person's key, resumes it, archives and destroys it", async () => {
    await connect({ apiKey: world.apiKey, projectId: world.projectId });
    await prepare();
    const pinned = await pinThread("lz.small");
    const target = await Effect.runPromise(
      resolveExecutionTarget(bindings, threadId, { admission: false }),
    );
    expect(target.profile).toMatchObject({
      adapter: "lizard",
      size: "small",
      snapshot: pinned?.providerTemplate,
    });
    if (target.credential.scope !== "personal") throw new Error("no account");
    expect(Redacted.value(target.credential.credentials)).toEqual({
      apiKey: world.apiKey,
      projectId: world.projectId,
    });
    const context: ExecutionContext = {
      account: {
        scope: "personal",
        userId: owner,
        providerAccount: world.projectId,
      },
      credentials: target.credential.credentials,
      profile: target.profile,
    };

    const provider = makeLizardExecutionProvider({ fetch: send });
    const handle = await provider.workspace.create(
      context,
      { threadId: threadId as never },
      { authorize: async () => {} },
    );
    const thread = [...world.sandboxes.values()].find(
      ({ snapshotId, status }) =>
        snapshotId === pinned?.providerTemplate && status === "running",
    );
    expect(thread).toBeDefined();
    // A Thread's sandbox never has a Lizard deadline: that would delete it.
    expect(thread?.timeoutMs).toBe(0);
    expect(handle.processesStartedAt).toBe(1_794_300_000 * 1_000);
    const ran = await handle.guest.commands.run("whoami", {
      cwd: "/home/user",
    });
    expect(ran.exitCode).toBe(0);
    expect(thread?.execs.at(-1)).toMatchObject({ user: "user" });
    expect(thread?.execs.at(-1)?.cmd).toContain("exec bash -l -c");

    // Idle: the deadline lives in D1, and the minute sweep pauses the Orb
    // with the key the Thread's pin resolves to (no deployment key exists).
    const now = Date.now();
    await handle.setIdleDeadline(60_000);
    expect(await idleRows()).toMatchObject([
      { provider_id: "lizard", sandbox_id: thread?.id, thread_id: threadId },
    ]);
    expect(await sweep(now + 30_000)).toBe(0);
    expect(thread?.status).toBe("running");
    // Activity moved the deadline: still running at the old one.
    await handle.setIdleDeadline(600_000);
    expect(await sweep(now + 120_000)).toBe(0);
    expect(thread?.status).toBe("running");
    // A pause Lizard fails is tried again on the next tick.
    world.failPauses = 1;
    expect(await sweep(now + 700_000)).toBe(0);
    expect(thread?.status).toBe("running");
    expect(await idleRows()).toHaveLength(1);
    expect(await sweep(now + 760_000)).toBe(1);
    expect(thread?.status).toBe("paused");
    expect(await idleRows()).toEqual([]);

    // The next activation resumes the paused sandbox in place.
    const resumed = await provider.workspace.connect(
      context,
      { threadId: threadId as never },
      { authorize: async () => {} },
    );
    expect(thread?.status).toBe("running");
    // A fresh boot: the processes started after the pause.
    expect(resumed.processesStartedAt).toBe((1_794_300_000 + 600) * 1_000);

    // Archiving pauses it (and clears its deadline); destroying deletes it.
    await resumed.setIdleDeadline(60_000);
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(threadId)
      .run();
    await provider.workspace.release(
      context,
      { threadId: threadId as never },
      "archive",
    );
    expect(thread?.status).toBe("paused");
    expect(await idleRows()).toEqual([]);
    await provider.workspace.release(
      context,
      { threadId: threadId as never },
      "destroy",
    );
    expect(thread?.status).toBe("stopped");
    const record = await env.DB.prepare(
      "SELECT state FROM execution_workspace WHERE thread_id = ?",
    )
      .bind(threadId)
      .first<{ state: string }>();
    expect(record?.state).toBe("lost");

    // The key went to Lizard only in the Authorization header.
    expect(world.traffic.filter((line) => line.includes(world.apiKey))).toEqual(
      [],
    );
  });
});

/**
 * One Thread, one sandbox. Ways it could fail, each covered below: two
 * activations at once (a new Thread's early Orb start and its first run)
 * each create a sandbox; an activation whose create reached Lizard but
 * whose request was cancelled before recording it leaves that sandbox
 * running and unrecorded while the next activation makes a second (Lizard
 * lists sandboxes without their metadata, so dx must read each one).
 */
describe("Lizard creates one sandbox per Thread", () => {
  const ready = async () => {
    await connect({ apiKey: world.apiKey, projectId: world.projectId });
    await prepare();
    await pinThread("lz.small");
    const target = await Effect.runPromise(
      resolveExecutionTarget(bindings, threadId, { admission: false }),
    );
    if (target.credential.scope !== "personal") throw new Error("no account");
    const context: ExecutionContext = {
      account: {
        scope: "personal",
        userId: owner,
        providerAccount: world.projectId,
      },
      credentials: target.credential.credentials,
      profile: target.profile,
    };
    const provider = makeLizardExecutionProvider({ fetch: send });
    return () =>
      provider.workspace.create(
        context,
        { threadId: threadId as never },
        { authorize: async () => {} },
      );
  };
  const threadSandboxes = () =>
    [...world.sandboxes.values()].filter(
      ({ metadata, status }) =>
        metadata.dxThread === threadId && status !== "stopped",
    );
  const record = () =>
    env.DB.prepare(
      "SELECT state, provider_sandbox_id FROM execution_workspace WHERE thread_id = ?",
    )
      .bind(threadId)
      .first();

  it("gives two activations at once the same sandbox", async () => {
    const open = await ready();
    await Promise.all([open(), open()]);
    const sandboxes = threadSandboxes();
    expect(sandboxes).toHaveLength(1);
    expect(await record()).toEqual({
      state: "initialized",
      provider_sandbox_id: sandboxes[0]?.id,
    });
  }, 30_000);

  it("adopts the sandbox a cancelled create made instead of making another", async () => {
    const open = await ready();
    // The early start claimed and reached Lizard, then its request ended.
    await env.DB.prepare(
      `UPDATE execution_workspace
          SET state = 'provisioning', initialization_attempt_id = 'attempt-cancelled',
              updated_at = ?
        WHERE thread_id = ?`,
    )
      .bind(new Date().toISOString(), threadId)
      .run();
    const snapshot = [...world.snapshots.values()].find(
      ({ status }) => status === "ready",
    );
    world.count += 1;
    world.sandboxes.set(`sbx-${world.count}`, {
      id: `sbx-${world.count}`,
      size: "small",
      template: null,
      snapshotId: snapshot?.id ?? null,
      timeoutMs: 0,
      status: "running",
      files: new Map(),
      execs: [],
      setupPolls: 0,
      pauses: 0,
      orb: true,
      metadata: { dxThread: threadId, dxAttempt: "attempt-cancelled" },
    });
    const creates = world.calls.filter(
      (line) => line === "POST /api/sandboxes",
    ).length;
    await open();
    expect(
      world.calls.filter((line) => line === "POST /api/sandboxes").length,
    ).toBe(creates);
    expect(threadSandboxes()).toHaveLength(1);
    expect(await record()).toEqual({
      state: "initialized",
      provider_sandbox_id: `sbx-${world.count}`,
    });
  }, 30_000);
});
