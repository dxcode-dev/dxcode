import { env } from "cloudflare:test";
import {
  AGENT37_ORB_SIZES,
  orbSizeHourlyPrice,
  Principal,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import publicImage from "../../../../deploy/orb/public-image.json" with {
  type: "json",
};
import { makeAgent37Connector } from "../../src/execution/agent37/connector.js";
import {
  makeAgent37ExecutionProvider,
  pauseIdleAgent37Instance,
} from "../../src/execution/agent37/provider.js";
import type { DeploymentOrbs } from "../../src/execution/deployment-orbs.js";
import { sweepIdleDeadlines } from "../../src/execution/idle-deadlines.js";
import { loadRunnerProfileCatalog } from "../../src/execution/runner-profiles/catalog.js";
import { resolveExecutionTarget } from "../../src/execution/runner-profiles/execution.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import {
  encryptOrbCredentials,
  putConnectionStatement,
} from "../../src/plugins/execution/connections-d1.js";
import type { OrbProviderConnectors } from "../../src/plugins/execution/connector.js";
import { makePersonalOrbProviderRoutes } from "../../src/plugins/execution/orb-provider-routes.js";
import { resolveThreadExecutionPin } from "../../src/plugins/execution/orb-providers.js";
import { advanceConnection } from "../../src/plugins/execution/preparation.js";
import type { ExecutionContext } from "../../src/plugins/execution/provider.js";
import { loadConfigEncryptionKeyring } from "../../src/settings/config-encryption.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import {
  type Agent37World,
  agent37World,
  type FakeInstance,
  fakeAgent37,
} from "./fake-agent37.js";

/**
 * Agent37 Orbs over real D1, with Agent37 faked at the HTTP boundary.
 *
 * Ways it could fail, each covered below: a bad key is saved, or the
 * account changes with the key so pinned Threads lose their Orbs;
 * preparation copies another image than the public Orb image, or leaves
 * its test Orb running, or is ready though the test Orb lacks a workspace
 * feature; a Thread's instance takes the wrong shape, mounts its disk over
 * /home/user (hiding the Orb's home), runs as root, or sends the key
 * anywhere but a header; a file above Agent37's 1 MB request or 512 KB
 * output cap is cut short; an idle Orb is never slept (Agent37's own
 * auto-sleep cannot see dxd), is slept although activity moved its
 * deadline, is slept with someone else's key, or a failed sleep is never
 * retried; a slept Orb is not woken on the next activation, or says its
 * processes restarted when the sleep kept them; archiving deletes instead
 * of sleeping, or destroying keeps the instance; an empty wallet crashes
 * instead of saying so.
 */

const solo = "a37-orb-solo" as UserId;
const project = "prj_00000000-0000-4000-8000-0000000037a1";
const threadId = "thr_00000000-0000-4000-8000-0000000037c1";
const timestamp = "2026-11-16T00:00:00.000Z";

/** No deployment provider: Agent37 runs only on a person's account. */
const bindings: Bindings = {
  DB: env.DB,
  DX_RUNTIME_MODE: "deployed",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
};

let world: Agent37World;
let send: typeof fetch;
let connectors: OrbProviderConnectors;

const call = async (
  path: string,
  method: "GET" | "PUT" | "POST" | "DELETE" = "GET",
  body?: unknown,
  using: Bindings = bindings,
) => {
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
  // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted below.
  return { status: response.status, body: (await response.json()) as any };
};

const agent37Of = (data: {
  readonly providers: ReadonlyArray<{ readonly id: string }>;
}) =>
  // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted below.
  data.providers.find(({ id }) => id === "agent37") as any;

const key = {
  scope: "personal",
  targetId: solo,
  providerId: "agent37",
} as const;

const prepare = async () => {
  const steps: Array<string> = [];
  for (let step = 0; step < 40; step += 1) {
    const outcome = await advanceConnection(bindings, env.DB, key, connectors);
    steps.push(
      agent37Of((await call("")).body.data).connection?.progress?.step ??
        "done",
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

const idleRows = async () =>
  (
    await env.DB.prepare(
      "SELECT provider_id, sandbox_id, thread_id FROM orb_idle_deadline",
    ).all()
  ).results;

const sweep = (now: number, using: Bindings = bindings) =>
  sweepIdleDeadlines(
    using,
    {
      agent37: (sweepBindings, instanceId, thread) =>
        pauseIdleAgent37Instance(sweepBindings, instanceId, thread, send),
    },
    now,
  );

beforeEach(async () => {
  world = agent37World();
  send = fakeAgent37(world) as typeof fetch;
  const connector = makeAgent37Connector({ fetch: send });
  if (connector === undefined) throw new Error("no public Orb image");
  connectors = { agent37: connector };
  await env.DB.batch([
    env.DB.prepare("DELETE FROM orb_idle_deadline"),
    env.DB.prepare("DELETE FROM orb_deployment_preparation"),
    env.DB.prepare(
      'INSERT OR REPLACE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(solo, solo, `${solo}@example.com`, 1, 1),
    env.DB.prepare(
      `INSERT OR REPLACE INTO projects (id, owner_user_id, workspace_id, name, runner_profile_id, created_at, updated_at)
       VALUES (?, ?, NULL, 'Agent37 project', 'a37.medium', ?, ?)`,
    ).bind(project, solo, timestamp, timestamp),
  ]);
});

describe("Agent37 in a person's own workspace", () => {
  it("registers the Orb image, tests it, and runs a Thread's instance through idle sleep, wake, archive, and destroy", async () => {
    const listed = await call("");
    expect(agent37Of(listed.body.data)).toMatchObject({
      deployment: false,
      connection: null,
      pauseResume: "processes",
      fields: [{ id: "apiKey", secret: true }],
    });
    expect(
      agent37Of(listed.body.data).sizes.map(({ id }: { id: string }) => id),
    ).toEqual(AGENT37_ORB_SIZES.map(({ id }) => id));

    // A refused key fails in the save request, before anything runs.
    const refused = await call("/agent37/connection", "PUT", {
      credentials: { apiKey: "sk_live_wrong" },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.data.detail).toBe("Agent37 rejected this API key.");
    expect(world.templates.size).toBe(0);

    const saved = await call("/agent37/connection", "PUT", {
      credentials: { apiKey: "sk_live_one" },
    });
    expect(saved.status).toBe(200);
    // The account is the workspace's first member, the same for every key.
    expect(agent37Of(saved.body.data).connection).toMatchObject({
      account: "mem_owner",
      status: "preparing",
      progress: { step: "Copying the Orb image into your Agent37 workspace" },
    });
    expect([...new Set(await prepare())]).toEqual([
      "Starting a test Orb",
      "done",
    ]);

    // One template, from the public Orb image by digest; the test Orb ran
    // dx-orb-check and is gone.
    const recipe = await (connectors.agent37?.recipe() as Promise<string>);
    const template = `dx-orb-${recipe}`;
    expect([...world.templates]).toEqual([
      [
        template,
        `${publicImage.registry}/${publicImage.repository}@${publicImage.digest}`,
      ],
    ]);
    expect(world.instances.size).toBe(0);
    const probe = world.deleted.find(({ name }) => name === "dx-orb-probe");
    expect(
      probe?.execs.some(({ command }) => command.includes("dx-orb-check")),
    ).toBe(true);
    expect(agent37Of((await call("")).body.data).connection).toMatchObject({
      status: "ready",
      account: "mem_owner",
    });

    // A Thread on a37.medium pins the template.
    const { pin, target } = await pinThread(threadId);
    expect(pin).toEqual({
      provider: "agent37",
      runnerProfileId: "a37.medium",
      credentialScope: "personal",
      credentialOwnerId: solo,
      credentialAccount: "mem_owner",
      providerTemplate: template,
    });
    expect(target.profile).toMatchObject({ adapter: "agent37", template });
    if (target.credential.scope !== "personal") throw new Error("no account");
    const context: ExecutionContext = {
      account: {
        scope: "personal",
        userId: solo,
        providerAccount: "mem_owner",
      },
      credentials: target.credential.credentials,
      profile: target.profile,
    };
    const provider = makeAgent37ExecutionProvider({ fetch: send });
    const authorize = async () => {};
    const handle = await provider.workspace.create(
      context,
      { threadId: threadId as never },
      { authorize },
    );
    const instance = [...world.instances.values()][0] as FakeInstance;
    expect(instance).toMatchObject({
      template,
      status: "running",
      // Only the workspace takes the disk; the Orb's home stays the image's.
      mountPath: "/home/user/workspace",
      resources: { cpu: 4, memory: 8, disk: 20 },
      metadata: { dxThread: threadId },
    });
    expect(await record(threadId)).toEqual({
      provider: "agent37",
      state: "initialized",
      provider_sandbox_id: instance.id,
    });
    expect(handle.processesStartedAt).toBe(world.clock * 1_000);

    // Commands run as the image's user, in a login shell.
    const ran = await handle.guest.commands.run("whoami", {
      cwd: "/home/user/workspace",
      envs: { DX_EXAMPLE: "it's" },
    });
    expect(ran).toMatchObject({ exitCode: 0, stdout: "user\n" });
    expect(instance.execs.every(({ root }) => !root)).toBe(true);
    // A command longer than one argument may be, as a Claude Code launch
    // with its files inline is, still runs.
    const long = await handle.guest.commands.run(
      `: ${"x".repeat(200_000)}; whoami`,
    );
    expect(long).toMatchObject({ exitCode: 0, stdout: "user\n" });

    // Files above the exec request and output caps arrive whole.
    const flue = await handle.sandbox("/home/user/workspace");
    await flue.writeFile("/home/user/note.txt", "hello");
    expect(instance.files.get("/home/user/note.txt")).toBe("hello");
    expect(await flue.readFile("/home/user/note.txt")).toBe("hello");
    const large = "0123456789abcdef".repeat(150_000); // 2.4 MB
    await flue.writeFile("/home/user/workspace/large.txt", large);
    expect(instance.files.get("/home/user/workspace/large.txt")).toBe(large);
    expect(await flue.readFile("/home/user/workspace/large.txt")).toBe(large);
    await flue.writeFile("/home/user/empty.txt", "");
    expect(await flue.readFile("/home/user/empty.txt")).toBe("");
    // Nothing staged is left behind.
    expect(
      [...instance.files.keys()].filter((path) => path.startsWith("/tmp/")),
    ).toEqual([]);

    // Idle: the deadline lives in D1, and the minute sweep sleeps the Orb
    // with the key the Thread's pin resolves to.
    const now = Date.now();
    await handle.setIdleDeadline(60_000);
    expect(await idleRows()).toEqual([
      { provider_id: "agent37", sandbox_id: instance.id, thread_id: threadId },
    ]);
    expect(await sweep(now + 30_000)).toBe(0);
    await handle.setIdleDeadline(600_000);
    expect(await sweep(now + 120_000)).toBe(0);
    expect(instance.status).toBe("running");
    world.failSleeps = 1;
    expect(await sweep(now + 700_000)).toBe(0);
    expect(instance.status).toBe("running");
    expect(await sweep(now + 760_000)).toBe(1);
    expect(instance.status).toBe("sleeping");
    expect(await idleRows()).toEqual([]);

    // The next activation wakes it in place: its processes kept running.
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
    expect(instance.status).toBe("running");
    expect(woken.processesStartedAt).toBe((world.clock - 3_600) * 1_000);
    expect(world.instances.size).toBe(1);

    // Archiving sleeps it and clears its deadline; destroying deletes it.
    await woken.setIdleDeadline(60_000);
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
    expect(instance.status).toBe("sleeping");
    expect(await idleRows()).toEqual([]);
    await provider.workspace.release(
      context,
      { threadId: threadId as never },
      "destroy",
    );
    expect(world.instances.size).toBe(0);
    expect(world.deleted.at(-1)?.id).toBe(instance.id);
    expect(await record(threadId)).toMatchObject({ state: "lost" });

    // A new key for the same workspace keeps the account and the template:
    // preparing again registers nothing and starts only a test Orb.
    const rotating = await call("/agent37/connection", "PUT", {
      credentials: { apiKey: "sk_live_two" },
    });
    expect(agent37Of(rotating.body.data).connection).toMatchObject({
      account: "mem_owner",
    });
    const registrations = world.calls.filter(
      (line) => line === "POST api.agent37.com/v1/templates",
    ).length;
    await prepare();
    expect(
      world.calls.filter((line) => line === "POST api.agent37.com/v1/templates")
        .length,
    ).toBe(registrations);
    expect(world.templates.size).toBe(1);

    // The key went to Agent37 only in headers.
    expect(world.traffic.filter((line) => line.includes("sk_live_"))).toEqual(
      [],
    );
  }, 60_000);

  it("sleeps the Orbs still running on a key when the person removes it", async () => {
    await call("/agent37/connection", "PUT", {
      credentials: { apiKey: "sk_live_one" },
    });
    await prepare();
    const provider = makeAgent37ExecutionProvider({ fetch: send });
    const second = "thr_00000000-0000-4000-8000-0000000037c2";
    for (const id of [threadId, second]) {
      const { target } = await pinThread(id);
      if (target.credential.scope !== "personal") throw new Error("no account");
      const handle = await provider.workspace.create(
        {
          account: {
            scope: "personal",
            userId: solo,
            providerAccount: "mem_owner",
          },
          credentials: target.credential.credentials,
          profile: target.profile,
        },
        { threadId: id as never },
        { authorize: async () => {} },
      );
      await handle.setIdleDeadline(3_600_000);
    }
    const instances = [...world.instances.values()] as Array<FakeInstance>;
    expect(instances.map(({ status }) => status)).toEqual([
      "running",
      "running",
    ]);

    // Agent37 refuses one sleep: the key is removed all the same.
    world.failSleeps = 1;
    const removed = await call("/agent37/connection", "DELETE");
    expect(removed.status).toBe(200);
    expect(agent37Of(removed.body.data).connection).toBeNull();
    expect(
      instances.map(({ status }) => status).sort((a, b) => a.localeCompare(b)),
    ).toEqual(["running", "sleeping"]);
    // No key is left to sleep an Orb later, so nothing waits on the sweep.
    expect(await idleRows()).toEqual([]);
    expect(await sweep(Date.now() + 7_200_000)).toBe(0);
  }, 60_000);

  it("fails preparation and leaves nothing running when the test Orb lacks a workspace feature", async () => {
    world.missingDesktop = true;
    await call("/agent37/connection", "PUT", {
      credentials: { apiKey: "sk_live_one" },
    });
    await prepare();
    expect(agent37Of((await call("")).body.data).connection).toMatchObject({
      status: "failed",
      error: "The test Orb is missing workspace features: desktop.start.",
    });
    expect(world.instances.size).toBe(0);
  }, 30_000);

  it("runs a VM size as an Agent37 VM on the shared sizes' template, at the VM rate", async () => {
    await call("/agent37/connection", "PUT", {
      credentials: { apiKey: "sk_live_one" },
    });
    await prepare();
    const listed = agent37Of((await call("")).body.data).sizes.map(
      ({ id }: { id: string }) => id,
    );
    expect(listed).toEqual(
      expect.arrayContaining(["a37.medium", "a37.vm-medium", "a37.vm-2xlarge"]),
    );
    const open = async (id: string, size: string) => {
      const { pin, target } = await pinThread(id, size);
      if (target.credential.scope !== "personal") throw new Error("no account");
      await makeAgent37ExecutionProvider({ fetch: send }).workspace.create(
        {
          account: {
            scope: "personal",
            userId: solo,
            providerAccount: "mem_owner",
          },
          credentials: target.credential.credentials,
          profile: target.profile,
        },
        { threadId: id as never },
        { authorize: async () => {} },
      );
      const instance = [...world.instances.values()].find(
        ({ metadata }) => metadata.dxThread === id,
      ) as FakeInstance;
      return { pin, instance };
    };
    const vm = await open(threadId, "a37.vm-medium");
    const shared = await open(
      "thr_00000000-0000-4000-8000-0000000037c2",
      "a37.medium",
    );
    // The VM size asks Agent37 for a VM of the medium shape; the shared
    // size asks for no type, as before.
    expect(vm.instance).toMatchObject({
      type: "vm",
      resources: { cpu: 4, memory: 8, disk: 20 },
    });
    expect(shared.instance.type).toBe("default");
    const creates = world.traffic.filter((line) =>
      line.startsWith("POST https://api.agent37.com/v1/instances "),
    );
    expect(creates.filter((line) => line.includes('"type":"vm"'))).toHaveLength(
      1,
    );
    // One template serves both: no second registration for VM sizes.
    expect(vm.pin?.providerTemplate).toBe(shared.pin?.providerTemplate);
    expect(world.templates.size).toBe(1);
    // A VM's compute meters at 2.5x; its disk at the same rate.
    const vmHour = orbSizeHourlyPrice("agent37", "a37.vm-medium", {
      cpuCores: 4,
      memoryMb: 8192,
      diskGb: 20,
    })?.usd as number;
    const sharedHour = orbSizeHourlyPrice("agent37", "a37.medium", {
      cpuCores: 4,
      memoryMb: 8192,
      diskGb: 20,
    })?.usd as number;
    const diskHour = (20 * 0.09) / 730;
    expect((vmHour - diskHour) / (sharedHour - diskHour)).toBeCloseTo(2.5, 6);
    expect(vmHour * 730).toBeCloseTo(23.8, 6);
  }, 30_000);

  it("says the wallet is empty instead of failing obscurely", async () => {
    await call("/agent37/connection", "PUT", {
      credentials: { apiKey: "sk_live_one" },
    });
    await prepare();
    const { target } = await pinThread(threadId);
    world.broke = true;
    const provider = makeAgent37ExecutionProvider({ fetch: send });
    await expect(
      provider.workspace.create(
        {
          account: {
            scope: "personal",
            userId: solo,
            providerAccount: "mem_owner",
          },
          credentials:
            target.credential.scope === "personal"
              ? target.credential.credentials
              : undefined,
          profile: target.profile,
        },
        { threadId: threadId as never },
        { authorize: async () => {} },
      ),
    ).rejects.toMatchObject({
      reason: expect.stringMatching(/^Agent37 needs more balance/),
    });
    expect(world.instances.size).toBe(0);
  }, 30_000);
});

describe("a deployment's named sizes on an Agent37 account its admin added", () => {
  /**
   * A hosted offer: an Agent37 account the deployment's admin added (a
   * deployment Orb account, `orb_connection` at scope `deployment`; no
   * deployment secret installs Agent37), under the deployment's own name,
   * with its own sizes. Its ways to fail: a person's own Agent37 key hides
   * the offer, or the offer hides the key; a named size runs on the
   * person's key, or a provider size on the deployment's account (billed to
   * the deployment under the provider's name); a Thread pins the named
   * size's ID instead of the provider size it runs as, or names no account.
   */
  const ACCOUNT = "oac_00000000-0000-4000-8000-0000000a3701";
  const hosted: DeploymentOrbs = {
    agent37: {
      displayName: "Hosted Orb",
      description: "The deployment's own Orbs.",
      sizes: [
        {
          id: "ho.small",
          label: "Small",
          runsAs: "a37.small",
          account: ACCOUNT,
        },
        {
          id: "ho.large",
          label: "Large",
          runsAs: "a37.large",
          account: ACCOUNT,
        },
      ],
    },
  };
  const deployed: Bindings = bindings;
  /** The admin adds the account: its key encrypted, then prepared. */
  const addAccount = async () => {
    const accountKey = {
      scope: "deployment",
      targetId: ACCOUNT,
      providerId: "agent37",
    } as const;
    const agent37 = connectors.agent37;
    if (agent37 === undefined) throw new Error("no Agent37 connector");
    const ring = await Effect.runPromise(loadConfigEncryptionKeyring(deployed));
    const credentials = { apiKey: "sk_live_two" };
    const recipe = await agent37.recipe();
    const configuredAt = new Date().toISOString();
    await putConnectionStatement(env.DB, accountKey, {
      envelope: await encryptOrbCredentials(ring, accountKey, credentials),
      configuredAt,
      recipe,
      preparation: await agent37.start(credentials, recipe),
    }).run();
    for (let step = 0; step < 40; step += 1) {
      const outcome = await advanceConnection(
        deployed,
        env.DB,
        accountKey,
        connectors,
      );
      if (outcome.nextStepInMs === undefined) break;
    }
  };
  const withHosted = async (
    path: string,
    method: "GET" | "PUT" = "GET",
    body?: unknown,
  ) => {
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
      makePersonalOrbProviderRoutes({
        connectors,
        deploymentOrbs: hosted,
        closedOrbProviders: async () => new Set(),
      }),
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
      deployed,
    );
    // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted below.
    return (await response.json()) as any;
  };
  const pinOf = (runnerProfileId: string) =>
    resolveThreadExecutionPin({
      db: env.DB,
      bindings: deployed,
      userId: solo,
      projectId: project,
      runnerProfileId,
      connectors,
      deploymentOrbs: hosted,
      closedProviders: async () => new Set(),
    });

  it("offers the named sizes beside a person's own key, each on its own account", async () => {
    await addAccount();
    // The catalog lists the named sizes, each marked with the provider
    // size it runs as.
    const catalog = await Effect.runPromise(
      loadRunnerProfileCatalog(deployed, hosted),
    );
    expect(
      catalog.publicCatalog.profiles
        .filter(({ runsAs }) => runsAs !== undefined)
        .map(({ id, label, adapter, runsAs }) => ({
          id,
          label,
          adapter,
          runsAs,
        })),
    ).toEqual([
      {
        id: "ho.small",
        label: "Small",
        adapter: "agent37",
        runsAs: "a37.small",
      },
      {
        id: "ho.large",
        label: "Large",
        adapter: "agent37",
        runsAs: "a37.large",
      },
    ]);

    // Without an own key: the offer only. Agent37's own sizes never fall
    // back to the deployment's account.
    const before = (await withHosted("")).data;
    expect(
      before.resolved.filter(
        ({ providerId }: { providerId: string }) => providerId === "agent37",
      ),
    ).toEqual([
      expect.objectContaining({
        scope: "deployment",
        namedSizes: true,
        displayName: "Hosted Orb",
      }),
    ]);
    await expect(pinOf("a37.small")).rejects.toMatchObject({
      reason: "no-provider",
    });
    const hostedPin = await pinOf("ho.small");
    expect(hostedPin).toMatchObject({
      provider: "agent37",
      // The provider size it runs as, so the Thread keeps its Orb whatever
      // the deployment later names its sizes after.
      runnerProfileId: "a37.small",
      credentialScope: "deployment",
      credentialOwnerId: ACCOUNT,
    });
    expect(hostedPin?.providerTemplate).toMatch(/^dx-orb-/);

    // With the person's own key: both, separately.
    await withHosted("/agent37/connection", "PUT", {
      credentials: { apiKey: "sk_live_one" },
    });
    for (let step = 0; step < 40; step += 1) {
      const outcome = await advanceConnection(
        deployed,
        env.DB,
        key,
        connectors,
      );
      if (outcome.nextStepInMs === undefined) break;
    }
    const after = (await withHosted("")).data;
    expect(
      after.resolved
        .filter(
          ({ providerId }: { providerId: string }) => providerId === "agent37",
        )
        .map(
          ({
            scope,
            namedSizes,
            displayName,
          }: {
            scope: string;
            namedSizes?: true;
            displayName?: string;
          }) => ({ scope, namedSizes, displayName }),
        ),
    ).toEqual([
      { scope: "personal", namedSizes: undefined, displayName: undefined },
      { scope: "deployment", namedSizes: true, displayName: "Hosted Orb" },
    ]);
    // Each account counts only its own sizes: the person's key is not
    // short of the deployment's named sizes, and Settings lists Agent37's.
    const own = after.resolved.find(
      ({ providerId, scope }: { providerId: string; scope: string }) =>
        providerId === "agent37" && scope === "personal",
    );
    expect(own.unavailableSizes).toEqual([]);
    const row = after.providers.find(
      ({ id }: { id: string }) => id === "agent37",
    );
    expect(row.sizes.map(({ id }: { id: string }) => id)).toEqual(
      AGENT37_ORB_SIZES.map(({ id }) => id),
    );
    expect(row.connection.unavailableSizes).toEqual([]);
    // A named size still runs on the deployment's account, never the key.
    expect(await pinOf("ho.large")).toMatchObject({
      runnerProfileId: "a37.large",
      credentialScope: "deployment",
      credentialOwnerId: ACCOUNT,
    });
    // Agent37's own size runs on the person's own key.
    expect(await pinOf("a37.small")).toMatchObject({
      runnerProfileId: "a37.small",
      credentialScope: "personal",
      credentialOwnerId: solo,
      credentialAccount: "mem_owner",
    });
  }, 30_000);
});

/**
 * One Thread, one instance. Ways it could fail, each covered below: two
 * activations at once (a new Thread's early Orb start and its first run)
 * each create an instance; an activation whose create reached Agent37 but
 * whose request was cancelled before recording it leaves that instance
 * running, unrecorded and never slept, while the next activation makes a
 * second; a claim whose holder vanished before reaching Agent37 is never
 * taken over, so the Thread never gets an Orb; a refused create (an empty
 * wallet) keeps the claim, so the next try waits it out; an instance left
 * behind before this fix is never deleted, or the cleanup deletes another
 * Thread's.
 */
describe("Agent37 creates one instance per Thread", () => {
  const ready = async (id: string) => {
    await call("/agent37/connection", "PUT", {
      credentials: { apiKey: "sk_live_one" },
    });
    await prepare();
    const { target } = await pinThread(id);
    if (target.credential.scope !== "personal") throw new Error("no account");
    const context: ExecutionContext = {
      account: {
        scope: "personal",
        userId: solo,
        providerAccount: "mem_owner",
      },
      credentials: target.credential.credentials,
      profile: target.profile,
    };
    return {
      context,
      provider: makeAgent37ExecutionProvider({ fetch: send }),
      template:
        target.profile.adapter === "agent37" ? target.profile.template : "",
    };
  };
  const open = (opened: Awaited<ReturnType<typeof ready>>, id: string) =>
    opened.provider.workspace.create(
      opened.context,
      { threadId: id as never },
      { authorize: async () => {} },
    );
  const created = () =>
    world.calls.filter((line) => line === "POST api.agent37.com/v1/instances")
      .length;
  /** An instance as Agent37 holds it after a create dx never saw finish. */
  const leftBehind = (
    id: string,
    template: string,
    metadata: Record<string, string>,
  ) => {
    world.count += 1;
    const instance: FakeInstance = {
      id: `left${world.count}`,
      template,
      name: `dx ${id}`,
      mountPath: "/home/user/workspace",
      resources: { cpu: 4, memory: 8, disk: 20 },
      metadata,
      type: "default",
      status: "running",
      startedAt: world.clock,
      files: new Map(),
      execs: [],
    };
    world.instances.set(instance.id, instance);
    return instance;
  };
  const claim = async (id: string, attempt: string, updatedAt: string) =>
    env.DB.prepare(
      `UPDATE execution_workspace
          SET state = 'provisioning', initialization_attempt_id = ?, updated_at = ?
        WHERE thread_id = ?`,
    )
      .bind(attempt, updatedAt, id)
      .run();

  it("gives two activations at once the same instance", async () => {
    const id = "thr_00000000-0000-4000-8000-0000000037d1";
    const opened = await ready(id);
    const before = created();
    const [first, second] = await Promise.all([
      open(opened, id),
      open(opened, id),
    ]);
    expect(created() - before).toBe(1);
    const instances = [...world.instances.values()].filter(
      ({ metadata }) => metadata.dxThread === id,
    );
    expect(instances).toHaveLength(1);
    const only = instances[0] as FakeInstance;
    expect(await record(id)).toEqual({
      provider: "agent37",
      state: "initialized",
      provider_sandbox_id: only.id,
    });
    // Both run commands in that one instance.
    await first.guest.commands.run("whoami");
    await second.guest.commands.run("whoami");
    expect(
      only.execs.filter(({ command }) => command.includes("whoami")),
    ).toHaveLength(2);
  }, 30_000);

  it("adopts the instance a cancelled create made instead of making another", async () => {
    const id = "thr_00000000-0000-4000-8000-0000000037d2";
    const opened = await ready(id);
    // The early start claimed and reached Agent37, then its request ended.
    await claim(id, "attempt-cancelled", new Date().toISOString());
    const orphan = leftBehind(id, opened.template, {
      dxThread: id,
      dxAttempt: "attempt-cancelled",
    });
    const before = created();
    await open(opened, id);
    expect(created() - before).toBe(0);
    expect(await record(id)).toMatchObject({
      state: "initialized",
      provider_sandbox_id: orphan.id,
    });
    expect(orphan.status).toBe("running");
  }, 30_000);

  it("takes over a claim whose holder never reached Agent37", async () => {
    const id = "thr_00000000-0000-4000-8000-0000000037d3";
    const opened = await ready(id);
    await claim(
      id,
      "attempt-vanished",
      new Date(Date.now() - 60_000).toISOString(),
    );
    const before = created();
    await open(opened, id);
    expect(created() - before).toBe(1);
    const instances = [...world.instances.values()].filter(
      ({ metadata }) => metadata.dxThread === id,
    );
    expect(instances).toHaveLength(1);
    // Made under a new attempt, not the vanished holder's.
    expect(instances[0]?.metadata.dxAttempt).not.toBe("attempt-vanished");
    expect(await record(id)).toMatchObject({
      state: "initialized",
      provider_sandbox_id: instances[0]?.id,
    });
  }, 30_000);

  it("waits on a fresh claim and adopts what its holder makes", async () => {
    const id = "thr_00000000-0000-4000-8000-0000000037d4";
    const opened = await ready(id);
    await claim(id, "attempt-slow", new Date().toISOString());
    const before = created();
    const waiting = open(opened, id);
    // The holder's create reaches Agent37 a moment later.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const made = leftBehind(id, opened.template, {
      dxThread: id,
      dxAttempt: "attempt-slow",
    });
    await waiting;
    expect(created() - before).toBe(0);
    expect(await record(id)).toMatchObject({
      state: "initialized",
      provider_sandbox_id: made.id,
    });
  }, 30_000);

  it("lets the next activation create at once after a refused create", async () => {
    const id = "thr_00000000-0000-4000-8000-0000000037d5";
    const opened = await ready(id);
    world.broke = true;
    await expect(open(opened, id)).rejects.toMatchObject({
      reason: expect.stringMatching(/^Agent37 needs more balance/),
    });
    expect(await record(id)).toMatchObject({ state: "uninitialized" });
    world.broke = false;
    const started = Date.now();
    await open(opened, id);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await record(id)).toMatchObject({ state: "initialized" });
  }, 30_000);

  it("deletes an instance left behind for the Thread when its own instance sleeps", async () => {
    const id = "thr_00000000-0000-4000-8000-0000000037d6";
    const other = "thr_00000000-0000-4000-8000-0000000037d7";
    const opened = await ready(id);
    const handle = await open(opened, id);
    const own = [...world.instances.values()].find(
      ({ metadata }) => metadata.dxThread === id,
    ) as FakeInstance;
    // From before creates were claimed: tagged with the Thread only.
    const stray = leftBehind(id, opened.template, { dxThread: id });
    const othersOwn = leftBehind(other, opened.template, { dxThread: other });
    const now = Date.now();
    await handle.setIdleDeadline(60_000);
    expect(await sweep(now + 120_000)).toBe(1);
    expect(own.status).toBe("sleeping");
    expect(world.instances.has(stray.id)).toBe(false);
    expect(world.deleted.map(({ id: deleted }) => deleted)).toContain(stray.id);
    expect(world.instances.get(othersOwn.id)?.status).toBe("running");
    expect(await record(id)).toMatchObject({ provider_sandbox_id: own.id });
  }, 30_000);
});
