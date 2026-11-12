import { env } from "cloudflare:test";
import { Principal, type UserId } from "@dx/domain";
import { Effect, Redacted, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { makeBoatConnector } from "../../src/execution/boat/connector.js";
import { makeBoatExecutionProvider } from "../../src/execution/boat/provider.js";
import type { DeploymentOrbs } from "../../src/execution/deployment-orbs.js";
import { loadRunnerProfileCatalog } from "../../src/execution/runner-profiles/catalog.js";
import { resolveExecutionTarget } from "../../src/execution/runner-profiles/execution.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import type { OrbProviderConnectors } from "../../src/plugins/execution/connector.js";
import { advanceDeploymentPreparation } from "../../src/plugins/execution/deployment-preparation.js";
import { makePersonalOrbProviderRoutes } from "../../src/plugins/execution/orb-provider-routes.js";
import { resolveThreadExecutionPin } from "../../src/plugins/execution/orb-providers.js";
import {
  composeExecutionWorkspaces,
  type ExecutionActivation,
  type ExecutionContext,
  resolveExecutionProviders,
} from "../../src/plugins/execution/provider.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { setBetaOrbProviders } from "./beta-orb-providers.js";
import { fakeBoat, type World } from "./fake-boat.js";

/**
 * Boat on the deployment's own account: a `BOAT_API_KEY` binding installs
 * it, and the deployment prepares one saved Orb snapshot that every
 * person's Threads start from. The key stays in the Worker.
 */

const owner = "bt-deploy-owner" as UserId;
const project = "prj_00000000-0000-4000-8000-0000000007d1";
const threadId = "thr_00000000-0000-4000-8000-0000000007d2";
const timestamp = "2026-11-01T00:00:00.000Z";
const deploymentKey = "boat_deployment_key_7d";
const deploymentAccount = "usr_boat_deployment";

const withoutBoat: Bindings = {
  DB: env.DB,
  DX_RUNTIME_MODE: "deployed",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
};
const withBoat: Bindings = { ...withoutBoat, BOAT_API_KEY: deploymentKey };

let world: World;
let connectors: OrbProviderConnectors;

const pin = (bindings: Bindings, runnerProfileId = "bt.medium") =>
  resolveThreadExecutionPin({
    db: env.DB,
    bindings,
    userId: owner,
    projectId: project,
    runnerProfileId,
    connectors,
  });

/** The Orb Providers page's response for the owner. */
const orbProvidersPage = async (deploymentOrbs?: DeploymentOrbs) => {
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
    makePersonalOrbProviderRoutes({
      connectors,
      ...(deploymentOrbs === undefined ? {} : { deploymentOrbs }),
    }),
  );
  router.onError(errorHandler);
  const response = await router.request(
    "/personal/orb-providers",
    {},
    withBoat,
  );
  return { status: response.status, text: await response.text() };
};

const prepare = async () => {
  for (let step = 0; step < 40; step += 1) {
    const outcome = await advanceDeploymentPreparation(
      withBoat,
      env.DB,
      "boat",
      connectors,
    );
    if (outcome.nextStepInMs === undefined) return;
  }
  throw new Error("Preparation never finished.");
};

beforeEach(async () => {
  world = {
    keys: new Map([
      [
        deploymentKey,
        { id: deploymentAccount, plan: "p100", zeroDataRetention: false },
      ],
    ]),
    sandboxes: new Map(),
    deleted: [],
    saved: new Map(),
    machineTypes: ["small", "default", "large", "xlarge"],
    calls: [],
    traffic: [],
    count: 0,
    clock: 1_793_500_000,
    failSetup: false,
    loseNextThreadCreate: false,
  };
  connectors = {
    boat: makeBoatConnector({ fetch: fakeBoat(world) as typeof fetch }),
  };
  await env.DB.batch([
    env.DB.prepare("DELETE FROM orb_deployment_preparation"),
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(owner, owner, `${owner}@example.com`, 1, 1),
    env.DB.prepare(
      `INSERT INTO projects (id, owner_user_id, workspace_id, name, runner_profile_id, created_at, updated_at)
       VALUES (?, ?, NULL, 'Boat project', 'bt.medium', ?, ?)`,
    ).bind(project, owner, timestamp, timestamp),
  ]);
});

// Beta behind its personal flag (#1924); these tests turn it on.
beforeEach(() => setBetaOrbProviders(owner, ["orb-provider-boat"]));

describe("Boat on the deployment's own account", () => {
  it("is not installed without BOAT_API_KEY, so a self-hoster sees no change", async () => {
    expect(
      resolveExecutionProviders(withoutBoat).map(
        ({ providerId }) => providerId,
      ),
    ).not.toContain("boat");
    await expect(pin(withoutBoat)).rejects.toMatchObject({
      reason: "no-provider",
    });
    expect(world.calls).toEqual([]);
  });

  it("prepares one snapshot for every person, pins it, and keeps the key in the Worker", async () => {
    expect(
      resolveExecutionProviders(withBoat).map(({ providerId }) => providerId),
    ).toContain("boat");
    // Before preparation a Thread cannot start yet.
    await expect(pin(withBoat)).rejects.toMatchObject({ reason: "preparing" });

    await prepare();
    const [build] = world.deleted.filter(({ name }) =>
      name.startsWith("dx-orb-build-"),
    );
    // The snapshot holds the Orb recipe only: no person's files or secrets.
    expect(build?.noEnv).toBe(true);
    expect(
      [...(build?.files.keys() ?? [])].every(
        (path) => !path.includes(owner) && !path.includes(project),
      ),
    ).toBe(true);
    const snapshots = [...world.saved.keys()];
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0] as string;

    const pinned = await pin(withBoat);
    expect(pinned).toMatchObject({
      provider: "boat",
      runnerProfileId: "bt.medium",
      credentialScope: "deployment",
      providerTemplate: snapshot,
    });

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
    const target = await Effect.runPromise(
      resolveExecutionTarget(withBoat, threadId, { admission: false }),
    );
    expect(target.credential.scope).toBe("deployment");
    expect(target.profile).toMatchObject({ adapter: "boat", snapshot });

    const provider = makeBoatExecutionProvider({
      fetch: fakeBoat(world) as typeof fetch,
    });
    const context: ExecutionContext = {
      account: { scope: "deployment" },
      credentials: Redacted.make({ apiKey: deploymentKey }),
      profile: target.profile,
    };
    const handle = await provider.workspace.create(
      context,
      { threadId: threadId as never },
      { authorize: async () => {} },
    );
    await handle.guest.commands.run("env", { cwd: "/home/user" });
    const sandbox = [...world.sandboxes.values()].find(
      ({ idempotencyKey }) => idempotencyKey !== null,
    );
    expect(sandbox).toMatchObject({ from: snapshot, noEnv: true });

    // The key reaches Boat only in the Authorization header: never in a
    // request body, a command, a file, or a URL.
    expect(world.traffic?.length).toBeGreaterThan(0);
    expect(
      (world.traffic ?? []).filter((request) =>
        request.includes(deploymentKey),
      ),
    ).toEqual([]);
    const page = await orbProvidersPage();
    expect(page.status).toBe(200);
    expect(page.text).toContain('"boat"');
    expect(page.text).not.toContain(deploymentKey);
    for (const box of world.sandboxes.values())
      expect(
        JSON.stringify([...box.files.values(), ...box.execs]),
      ).not.toContain(deploymentKey);
  });

  it("presents the deployment's account under the deployment's name and idle time, and only it", async () => {
    const hosted: DeploymentOrbs = {
      boat: {
        displayName: "Hosted Orb",
        description: "Stops after an hour idle.",
        inactivityMs: 3_600_000,
        costLabels: { "bt.medium": "Example cost label" },
      },
    };
    const sizeCost = async (bindings: Bindings) =>
      (
        await Effect.runPromise(loadRunnerProfileCatalog(bindings, hosted))
      ).publicCatalog.profiles.find(({ id }) => id === "bt.medium")?.costLabel;
    // The deployment's price shows only where its account runs the size.
    expect(await sizeCost(withoutBoat)).toBeUndefined();
    expect(await sizeCost(withBoat)).toBe("Example cost label");
    const providerNames = async (bindings: Bindings) =>
      (
        await Effect.runPromise(loadRunnerProfileCatalog(bindings, hosted))
      ).publicCatalog.providers?.find(({ adapter }) => adapter === "boat");
    // Without the key the deployment has no Boat account to present.
    expect(await providerNames(withoutBoat)).toMatchObject({
      displayName: "Boat",
    });
    expect(await providerNames(withBoat)).toMatchObject({
      displayName: "Hosted Orb",
      shortName: "Hosted Orb",
    });

    await prepare();
    const page = JSON.parse((await orbProvidersPage(hosted)).text).data;
    expect(
      page.resolved.find(
        ({ providerId }: { providerId: string }) => providerId === "boat",
      ),
    ).toMatchObject({
      scope: "deployment",
      displayName: "Hosted Orb",
      description: "Stops after an hour idle.",
    });
    // The connection settings keep Boat for a person's own key, and do not
    // list the deployment's account under it.
    expect(
      page.providers.find(({ id }: { id: string }) => id === "boat"),
    ).toMatchObject({ displayName: "Boat", deployment: false });

    // The deployment's account runs with its idle time.
    const pinned = await pin(withBoat);
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
    const contexts: Array<ExecutionContext> = [];
    const workspaces = composeExecutionWorkspaces(
      withBoat,
      {
        boat: makeBoatExecutionProvider({
          fetch: fakeBoat(world) as typeof fetch,
        }),
      },
      () =>
        ({
          activate: async (context: ExecutionContext) => {
            contexts.push(context);
            throw new Error("Orb started.");
          },
          reconnect: async () => {
            throw new Error("unused");
          },
          ensureDaemon: async () => {
            throw new Error("unused");
          },
          recordResidentTerminalInput: async () => undefined,
          recordResidentTerminalHeartbeat: () => undefined,
        }) as unknown as ExecutionActivation,
      undefined,
      undefined,
      undefined,
      hosted,
    );
    await expect(
      workspaces.sandboxFactory.createSandbox({ id: threadId }),
    ).rejects.toThrow("Orb started.");
    expect(contexts[0]?.inactivityMs).toBe(3_600_000);
    const handle = await makeBoatExecutionProvider({
      fetch: fakeBoat(world) as typeof fetch,
    }).workspace.create(
      contexts[0] as ExecutionContext,
      { threadId: threadId as never },
      { authorize: async () => {} },
    );
    expect(handle.inactivityMs).toBe(3_600_000);
    const sandbox = [...world.sandboxes.values()].find(
      ({ idempotencyKey }) => idempotencyKey !== null,
    );
    expect(sandbox?.ttlSeconds).toBe(3_600);
  });
});
