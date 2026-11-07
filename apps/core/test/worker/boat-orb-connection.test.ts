import { env } from "cloudflare:test";
import { BOAT_ORB_SIZES, Principal, type UserId } from "@dx/domain";
import { Effect, Redacted, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import vmSetup from "../../../../deploy/orb/vm-setup.sh?raw";
import { makeBoatConnector } from "../../src/execution/boat/connector.js";
import { makeBoatExecutionProvider } from "../../src/execution/boat/provider.js";
import { resolveExecutionTarget } from "../../src/execution/runner-profiles/execution.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import type { OrbProviderConnectors } from "../../src/plugins/execution/connector.js";
import { makePersonalOrbProviderRoutes } from "../../src/plugins/execution/orb-provider-routes.js";
import { resolveThreadExecutionPin } from "../../src/plugins/execution/orb-providers.js";
import { advanceConnection } from "../../src/plugins/execution/preparation.js";
import type { ExecutionContext } from "../../src/plugins/execution/provider.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { setBetaOrbProviders } from "./beta-orb-providers.js";
import {
  type FakeAccount,
  type FakeSandbox,
  fakeBoat,
  type World,
} from "./fake-boat.js";

const solo = "bt-orb-solo" as UserId;
const project = "prj_00000000-0000-4000-8000-0000000007b1";
const threadId = "thr_00000000-0000-4000-8000-0000000007c1";
const timestamp = "2026-10-24T00:00:00.000Z";
const accountId = "usr_boat_00000007a1";

/** No deployment provider: Boat runs only on a person's account. */
const bindings: Bindings = {
  DB: env.DB,
  DX_RUNTIME_MODE: "deployed",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
};

let world: World;
let connectors: OrbProviderConnectors;

const app = () => {
  const router = new Hono<AppEnv>();
  router.use("*", requestId);
  router.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId: solo,
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
  return router;
};

const call = async (
  path: string,
  method: "GET" | "PUT" = "GET",
  body?: unknown,
) => {
  const response = await app().request(
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
    bindings,
  );
  // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted below.
  return { status: response.status, body: (await response.json()) as any };
};

const boatOf = (data: {
  readonly providers: ReadonlyArray<{ readonly id: string }>;
}) =>
  // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted below.
  data.providers.find(({ id }) => id === "boat") as any;

const key = {
  scope: "personal",
  targetId: solo,
  providerId: "boat",
} as const;

const prepare = async () => {
  const steps: Array<string> = [];
  for (let step = 0; step < 40; step += 1) {
    const outcome = await advanceConnection(bindings, env.DB, key, connectors);
    steps.push(
      boatOf((await call("")).body.data).connection?.progress?.step ?? "done",
    );
    if (outcome.nextStepInMs === undefined) return steps;
  }
  throw new Error("Preparation never finished.");
};

const pinThread = async (id: string, runnerProfileId?: string) => {
  await env.DB.prepare(
    "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, project, solo, timestamp, timestamp)
    .run();
  const pin = await resolveThreadExecutionPin({
    db: env.DB,
    bindings,
    userId: solo,
    projectId: project,
    runnerProfileId,
    connectors,
  });
  await env.DB.prepare(
    `UPDATE execution_workspace
        SET provider = ?, runner_profile_id = ?, account_scope = ?,
            account_owner_id = ?, provider_account = ?, provider_template = ?
      WHERE thread_id = ?`,
  )
    .bind(
      pin?.provider,
      pin?.runnerProfileId,
      pin?.credentialScope,
      pin?.credentialOwnerId,
      pin?.credentialAccount,
      pin?.providerTemplate,
      id,
    )
    .run();
  const target = await Effect.runPromise(
    resolveExecutionTarget(bindings, id, { admission: false }),
  );
  return { pin, target };
};

const record = async (id: string) =>
  env.DB.prepare(
    "SELECT provider, state, provider_sandbox_id FROM execution_workspace WHERE thread_id = ?",
  )
    .bind(id)
    .first();

beforeEach(async () => {
  const paid: FakeAccount = {
    id: accountId,
    plan: "p20",
    zeroDataRetention: false,
  };
  world = {
    keys: new Map([
      ["boat_key_1", paid],
      ["box_key_2", paid],
      [
        "boat_trial",
        { id: "usr_trial", plan: "trial", zeroDataRetention: false },
      ],
      ["boat_zdr", { id: "usr_zdr", plan: "p20", zeroDataRetention: true }],
    ]),
    sandboxes: new Map(),
    deleted: [],
    saved: new Map(),
    // The $20 plan: no xlarge.
    machineTypes: ["small", "default", "large"],
    calls: [],
    count: 0,
    clock: 1_793_000_000,
    failSetup: false,
    loseNextThreadCreate: false,
  };
  connectors = {
    boat: makeBoatConnector({ fetch: fakeBoat(world) as typeof fetch }),
  };
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(solo, solo, `${solo}@example.com`, 1, 1),
    env.DB.prepare(
      `INSERT INTO projects (id, owner_user_id, workspace_id, name, runner_profile_id, created_at, updated_at)
       VALUES (?, ?, NULL, 'Boat project', 'bt.medium', ?, ?)`,
    ).bind(project, solo, timestamp, timestamp),
  ]);
});

// Beta behind its personal flag (#1924); these tests turn it on.
beforeEach(() => setBetaOrbProviders(solo, ["orb-provider-boat"]));

describe("Boat in a person's own account", () => {
  it("saves one Orb snapshot, tests it, and runs a Thread's sandbox through stop and resume", async () => {
    const listed = await call("");
    expect(boatOf(listed.body.data)).toMatchObject({
      deployment: false,
      connection: null,
      pauseResume: "filesystem",
      fields: [{ id: "apiKey", secret: true }],
    });
    expect(
      boatOf(listed.body.data).sizes.map(({ id }: { id: string }) => id),
    ).toEqual(BOAT_ORB_SIZES.map(({ id }) => id));

    // A refused key, a trial account, and a zero-data-retention account
    // fail in the save request, before anything runs in Boat.
    const refused = await call("/boat/connection", "PUT", {
      credentials: { apiKey: "not-a-key" },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.data.detail).toBe("Boat rejected this API key.");
    const trial = await call("/boat/connection", "PUT", {
      credentials: { apiKey: "boat_trial" },
    });
    expect(trial.status).toBe(400);
    expect(trial.body.data.detail).toMatch(/free trial cannot save snapshots/);
    const zdr = await call("/boat/connection", "PUT", {
      credentials: { apiKey: "boat_zdr" },
    });
    expect(zdr.status).toBe(400);
    expect(zdr.body.data.detail).toMatch(/zero data retention/);
    expect(
      world.calls.filter((call) => call === "POST /api/v1/sandboxes"),
    ).toEqual([]);

    const saved = await call("/boat/connection", "PUT", {
      credentials: { apiKey: "boat_key_1" },
    });
    expect(saved.status).toBe(200);
    expect(boatOf(saved.body.data).connection).toMatchObject({
      account: accountId,
      status: "preparing",
    });

    const steps = [...new Set(await prepare())];
    expect(steps).toEqual([
      "Building the Orb in your Boat account",
      "Starting a test Orb",
      "done",
    ]);

    // One stock sandbox, with none of the account's secrets and no
    // retained command output, ran the VM recipe as root and became the
    // saved snapshot; then it was deleted.
    const recipe = await (connectors.boat?.recipe() as Promise<string>);
    const snapshot = `dx-orb-${recipe}`;
    expect([...world.saved.keys()]).toEqual([snapshot]);
    expect(world.sandboxes.size).toBe(0);
    const build = world.deleted.find(({ name }) =>
      name.startsWith("dx-orb-build-"),
    );
    expect(build).toMatchObject({ from: null, noEnv: true, monitoring: false });
    expect(build?.files.get("/var/lib/dx-orb-setup/vm-setup.sh")).toBe(vmSetup);
    expect(build?.files.has("/var/lib/dx-orb-setup/files/dx-orb-init")).toBe(
      true,
    );
    expect(build?.execs.every(({ asRoot }) => asRoot)).toBe(true);
    // The test Orb started from the snapshot and found dx-orb-init running.
    const probe = world.deleted.find(({ name }) => name === "dx-orb-probe");
    expect(probe).toMatchObject({ from: snapshot, orb: true, noEnv: true });

    const ready = await call("");
    expect(boatOf(ready.body.data).connection).toMatchObject({
      status: "ready",
      account: accountId,
      unavailableSizes: [
        {
          id: "bt.xlarge",
          reason:
            "Your Boat plan does not include this size (Boat: needs the $100 plan).",
        },
      ],
    });

    // A Thread on bt.medium pins the one snapshot; the plan has no xlarge.
    const { pin, target } = await pinThread(threadId);
    expect(pin).toEqual({
      provider: "boat",
      runnerProfileId: "bt.medium",
      credentialScope: "personal",
      credentialOwnerId: solo,
      credentialAccount: accountId,
      providerTemplate: snapshot,
    });
    await expect(
      resolveThreadExecutionPin({
        db: env.DB,
        bindings,
        userId: solo,
        projectId: project,
        runnerProfileId: "bt.xlarge",
        connectors,
      }),
    ).rejects.toMatchObject({ reason: "size-unavailable" });
    expect(target.profile).toMatchObject({
      adapter: "boat",
      machineType: "default",
      snapshot,
    });
    if (target.credential.scope !== "personal") throw new Error("no account");
    expect(Redacted.value(target.credential.credentials)).toEqual({
      apiKey: "boat_key_1",
    });

    const provider = makeBoatExecutionProvider({
      fetch: fakeBoat(world) as typeof fetch,
    });
    const context: ExecutionContext = {
      account: { scope: "personal", userId: solo, providerAccount: accountId },
      credentials: target.credential.credentials,
      profile: target.profile,
    };
    const authorize = async () => {};

    // The first create reaches Boat but its answer is lost; the retry gets
    // the same sandbox back instead of a second one.
    world.loseNextThreadCreate = true;
    await expect(
      provider.workspace.create(
        context,
        { threadId: threadId as never },
        { authorize },
      ),
    ).rejects.toThrow();
    const handle = await provider.workspace.create(
      context,
      { threadId: threadId as never },
      { authorize },
    );
    expect(world.sandboxes.size).toBe(1);
    const sandbox = [...world.sandboxes.values()][0] as FakeSandbox;
    expect(sandbox).toMatchObject({
      from: snapshot,
      type: "default",
      noEnv: true,
      monitoring: false,
      state: "ready",
      // One idle window (DX_WORKSPACE_INACTIVITY_MS's default).
      ttlSeconds: 300,
    });
    expect(await record(threadId)).toEqual({
      provider: "boat",
      state: "initialized",
      provider_sandbox_id: sandbox.id,
    });
    expect(handle.processesStartedAt).toBe(world.clock * 1_000);

    // Commands and writes run as the workspace account.
    const ran = await handle.guest.commands.run("pwd", {
      cwd: "/home/user/workspace",
      envs: { DX_EXAMPLE: "it's" },
    });
    expect(ran).toMatchObject({ exitCode: 0, stdout: "ran as user" });
    await handle.guest.files.write("/home/user/note.txt", "hello");
    expect(sandbox.files.get("/home/user/note.txt")).toBe("hello");
    const flue = await handle.sandbox("/home/user/workspace");
    await flue.writeFile("/opt/dx-note.txt", "outside");
    expect(sandbox.files.get("/opt/dx-note.txt")).toBe("outside");
    expect(await flue.readFile("/home/user/note.txt")).toBe("hello");
    // Above 5 MiB, files go through Boat's signed URLs both ways.
    const large = "x".repeat(6 * 1024 * 1024);
    await flue.writeFile("/home/user/large.txt", large);
    expect(sandbox.files.get("/home/user/large.txt")).toBe(large);
    expect(await flue.readFile("/home/user/large.txt")).toBe(large);
    expect(sandbox.execs.some(({ asRoot }) => asRoot)).toBe(false);

    // Core moves Boat's own auto-stop forward while the Orb is in use.
    await handle.setIdleDeadline(900_000);
    expect(sandbox.ttlSeconds).toBe(900);

    // Idle: Boat's auto-stop stops the sandbox, keeping only its disk. The
    // next activation resumes it on a new machine and reports the new boot.
    sandbox.state = "archived";
    world.clock += 3_600;
    const residency: Array<string> = [];
    const woken = await provider.workspace.create(
      context,
      { threadId: threadId as never },
      {
        authorize,
        observeResidency: (seen) => {
          residency.push(seen);
        },
      },
    );
    expect(residency).toEqual(["paused"]);
    expect(sandbox).toMatchObject({ state: "ready", ttlSeconds: 300 });
    expect(woken.processesStartedAt).toBe(world.clock * 1_000);
    expect(world.sandboxes.size).toBe(1);
    // A connect to the running sandbox resumes nothing.
    const resumes = world.calls.filter((call) =>
      call.endsWith("/resume"),
    ).length;
    await provider.workspace.connect(
      context,
      { threadId: threadId as never },
      { authorize },
    );
    expect(world.calls.filter((call) => call.endsWith("/resume")).length).toBe(
      resumes,
    );

    // Archiving stops the sandbox; deleting the Thread deletes it.
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
    expect(sandbox.state).toBe("archived");
    await provider.workspace.release(
      context,
      { threadId: threadId as never },
      "archive",
    );
    await provider.workspace.release(
      context,
      { threadId: threadId as never },
      "destroy",
    );
    expect(world.sandboxes.size).toBe(0);
    expect(world.deleted.at(-1)?.id).toBe(sandbox.id);
    expect(await record(threadId)).toMatchObject({ state: "lost" });

    // A new key for the same account keeps the snapshot it already saved:
    // preparing again starts only a test Orb.
    const created = world.calls.filter(
      (call) => call === "POST /api/v1/sandboxes",
    ).length;
    const rotating = await call("/boat/connection", "PUT", {
      credentials: { apiKey: "box_key_2" },
    });
    expect(boatOf(rotating.body.data).connection).toMatchObject({
      account: accountId,
      status: "preparing",
      updating: true,
    });
    await prepare();
    expect(boatOf((await call("")).body.data).connection).toMatchObject({
      status: "ready",
      updating: false,
    });
    expect([...world.saved.keys()]).toEqual([snapshot]);
    expect(
      world.calls.filter((call) => call === "POST /api/v1/sandboxes").length -
        created,
    ).toBe(1);

    // The person moves to the $100 plan and checks again: the same
    // snapshot now serves bt.xlarge, after one more test Orb.
    world.machineTypes = ["small", "default", "large", "xlarge"];
    expect((await call("/boat/connection/retry", "POST")).status).toBe(200);
    await prepare();
    expect(boatOf((await call("")).body.data).connection).toMatchObject({
      status: "ready",
      unavailableSizes: [],
    });
    const xlarge = await resolveThreadExecutionPin({
      db: env.DB,
      bindings,
      userId: solo,
      projectId: project,
      runnerProfileId: "bt.xlarge",
      connectors,
    });
    expect(xlarge).toMatchObject({
      runnerProfileId: "bt.xlarge",
      providerTemplate: snapshot,
    });
    expect([...world.saved.keys()]).toEqual([snapshot]);
    expect(
      world.calls.filter((call) => call === "POST /api/v1/sandboxes").length -
        created,
    ).toBe(2);
  }, 30_000);

  it("marks a Thread lost when Boat deleted its stopped disk after 14 days", async () => {
    await call("/boat/connection", "PUT", {
      credentials: { apiKey: "boat_key_1" },
    });
    await prepare();
    const { target } = await pinThread(threadId);
    const provider = makeBoatExecutionProvider({
      fetch: fakeBoat(world) as typeof fetch,
    });
    const context: ExecutionContext = {
      account: { scope: "personal", userId: solo, providerAccount: accountId },
      credentials:
        target.credential.scope === "personal"
          ? target.credential.credentials
          : undefined,
      profile: target.profile,
    };
    const authorize = async () => {};
    await provider.workspace.create(
      context,
      { threadId: threadId as never },
      { authorize },
    );
    const sandbox = [...world.sandboxes.values()][0] as FakeSandbox;
    sandbox.state = "archived";
    sandbox.dataExpiredAt = timestamp;
    await expect(
      provider.workspace.connect(
        context,
        { threadId: threadId as never },
        { authorize },
      ),
    ).rejects.toMatchObject({
      reason: "Boat deleted this Orb's disk 14 days after it stopped",
    });
    expect(await record(threadId)).toMatchObject({ state: "lost" });
    // Destroying a lost Thread calls nothing more.
    const calls = world.calls.length;
    await provider.workspace.release(
      context,
      { threadId: threadId as never },
      "destroy",
    );
    expect(world.calls.length).toBe(calls);
  }, 30_000);

  it("fails with the end of the setup log and leaves no build sandbox when the Orb setup fails", async () => {
    world.failSetup = true;
    const saved = await call("/boat/connection", "PUT", {
      credentials: { apiKey: "boat_key_1" },
    });
    expect(saved.status).toBe(200);
    await prepare();
    expect(boatOf((await call("")).body.data).connection).toMatchObject({
      status: "failed",
      error: "The Orb setup failed: E: Unable to locate package gh",
    });
    expect(world.sandboxes.size).toBe(0);
    expect(world.saved.size).toBe(0);
  }, 30_000);
});
