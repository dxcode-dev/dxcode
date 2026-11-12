import { env } from "cloudflare:test";
import { Principal, type UserId } from "@dx/domain";
import { Effect, Redacted, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { DeploymentOrbs } from "../../src/execution/deployment-orbs.js";
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
import {
  advanceDeploymentPreparation,
  findDeploymentPreparation,
} from "../../src/plugins/execution/deployment-preparation.js";
import { makePersonalOrbProviderRoutes } from "../../src/plugins/execution/orb-provider-routes.js";
import { resolveThreadExecutionPin } from "../../src/plugins/execution/orb-providers.js";
import {
  composeExecutionWorkspaces,
  type ExecutionActivation,
  type ExecutionContext,
  resolveExecutionProviders,
} from "../../src/plugins/execution/provider.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { fakeLizard, type LizardWorld, lizardWorld } from "./fake-lizard.js";

/**
 * Lizard on the deployment's own account (a hosted offer's Orbs), over real D1
 * with Lizard faked at the HTTP boundary.
 *
 * Ways it could fail, each covered below: Lizard is installed without its
 * key, or with a key and no project it crashes instead of failing clearly;
 * preparation builds one snapshot for every size although each size
 * restores only at its own; a size the account cannot start (Large on the
 * trial) fails the whole preparation instead of being unavailable with
 * Lizard's reason, or a failed size's build stays running; a Thread pins
 * another size's snapshot, runs as root, or sends the key anywhere but the
 * Authorization header; a person saves their own Lizard connection; an idle
 * Orb is never paused (Lizard has no pause of its own and its timeout
 * deletes the disk), one whose activity moved its deadline is paused
 * anyway, or a failed pause is never retried; a paused Orb is not resumed on
 * the next activation, or does not say its processes restarted (a Lizard
 * pause keeps files only); archiving deletes instead of pausing, or destroying
 * keeps the sandbox.
 */

const owner = "lz-deploy-owner" as UserId;
const project = "prj_00000000-0000-4000-8000-0000000009a1";
const threadId = "thr_00000000-0000-4000-8000-0000000009a2";
const timestamp = "2026-11-10T00:00:00.000Z";

let world: LizardWorld;
let connectors: OrbProviderConnectors;
let send: typeof fetch;

const base: Bindings = {
  DB: env.DB,
  DX_RUNTIME_MODE: "deployed",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
};
const withLizard = (): Bindings => ({
  ...base,
  LIZARD_API_KEY: world.apiKey,
  LIZARD_PROJECT_ID: world.projectId,
});

const prepare = async (bindings = withLizard()) => {
  for (let step = 0; step < 40; step += 1) {
    const outcome = await advanceDeploymentPreparation(
      bindings,
      env.DB,
      "lizard",
      connectors,
    );
    if (outcome.nextStepInMs === undefined) return;
  }
  throw new Error("Preparation never finished.");
};

const pin = (runnerProfileId: string) =>
  resolveThreadExecutionPin({
    db: env.DB,
    bindings: withLizard(),
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

/** The execution context Core composes for the Thread from the bindings. */
const composedContext = async (deploymentOrbs?: DeploymentOrbs) => {
  const contexts: Array<ExecutionContext> = [];
  const workspaces = composeExecutionWorkspaces(
    withLizard(),
    { lizard: makeLizardExecutionProvider({ fetch: send }) },
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
    deploymentOrbs,
  );
  await expect(
    workspaces.sandboxFactory.createSandbox({ id: threadId }),
  ).rejects.toThrow("Orb started.");
  return contexts[0] as ExecutionContext;
};

const idleRows = async () =>
  (
    await env.DB.prepare(
      "SELECT provider_id, sandbox_id, thread_id, deadline_at FROM orb_idle_deadline",
    ).all<{
      provider_id: string;
      sandbox_id: string;
      thread_id: string;
      deadline_at: number;
    }>()
  ).results;

const sweep = (now: number) =>
  sweepIdleDeadlines(
    withLizard(),
    {
      lizard: (bindings, sandboxId) =>
        pauseIdleLizardSandbox(bindings, sandboxId, send),
    },
    now,
  );

beforeEach(async () => {
  world = lizardWorld();
  send = fakeLizard(world) as typeof fetch;
  connectors = { lizard: makeLizardConnector({ fetch: send }) };
  await env.DB.batch([
    env.DB.prepare("DELETE FROM orb_deployment_preparation"),
    env.DB.prepare("DELETE FROM orb_idle_deadline"),
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(owner, owner, `${owner}@example.com`, 1, 1),
    env.DB.prepare(
      `INSERT INTO projects (id, owner_user_id, workspace_id, name, runner_profile_id, created_at, updated_at)
       VALUES (?, ?, NULL, 'Lizard project', 'lz.medium', ?, ?)`,
    ).bind(project, owner, timestamp, timestamp),
  ]);
});

describe("Lizard on the deployment's own account", () => {
  it("is installed only by its key, and without a project fails preparation clearly", async () => {
    expect(
      resolveExecutionProviders(base).map(({ providerId }) => providerId),
    ).not.toContain("lizard");
    expect(
      resolveExecutionProviders(withLizard()).map(
        ({ providerId }) => providerId,
      ),
    ).toContain("lizard");
    expect(world.calls).toEqual([]);

    const { LIZARD_PROJECT_ID: _, ...noProject } = withLizard();
    await prepare(noProject);
    const failed = await findDeploymentPreparation(env.DB, "lizard");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("LIZARD_PROJECT_ID");
    expect(world.sandboxes.size).toBe(0);
  });

  it("builds and checks one snapshot per size, marks a size the account refuses unavailable, and leaves nothing running", async () => {
    // Before preparation no Thread can start.
    await expect(pin("lz.medium")).rejects.toMatchObject({
      reason: "preparing",
    });
    await prepare();
    const prepared = await findDeploymentPreparation(env.DB, "lizard");
    expect(prepared?.status).toBe("ready");

    // A build per size the account may start, from the claude template.
    const builds = [...world.sandboxes.values()].filter(
      ({ template }) => template === "claude",
    );
    expect(builds.map(({ size }) => size).sort()).toEqual(
      ["medium", "mini", "small"].sort(),
    );
    // Each build ran the Orb recipe as root and deletes itself if dx loses
    // it; none of it runs any more.
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

    // Threads pin their own size's snapshot.
    for (const size of ["mini", "small", "medium"]) {
      const pinned = await pin(`lz.${size}`);
      const snapshot = snapshots.find((entry) => entry.size === size);
      expect(pinned).toMatchObject({
        provider: "lizard",
        credentialScope: "deployment",
        providerTemplate: snapshot?.id,
      });
    }
    // Large, which the trial refuses, is unavailable with Lizard's reason.
    await expect(pin("lz.large")).rejects.toMatchObject({
      reason: "size-unavailable",
    });
    expect(JSON.stringify(prepared?.state)).toContain(
      "Sandboxes are not available",
    );
  });

  it("takes one snapshot per size even when Lizard's answer to it is lost", async () => {
    // A full VM's snapshot can outlast the request: the first two answers
    // are lost although Lizard takes both snapshots.
    world.loseSnapshotAnswers = 2;
    await prepare();
    expect((await findDeploymentPreparation(env.DB, "lizard"))?.status).toBe(
      "ready",
    );
    const names = [...world.snapshots.values()].map(({ name }) => name);
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
  });

  it("retries a size Lizard is too busy to start now, instead of giving it up", async () => {
    // The trial runs 1 Small at a time: a refusal for that is retried.
    world.busyOnce.add("small");
    await prepare();
    expect((await pin("lz.small"))?.provider).toBe("lizard");
    expect(world.busyOnce.size).toBe(0);
  });

  it("keeps the other sizes when one size's build fails, and fails only when none can run", async () => {
    world.failingSetup.add("mini");
    await prepare();
    const prepared = await findDeploymentPreparation(env.DB, "lizard");
    expect(prepared?.status).toBe("ready");
    await expect(pin("lz.mini")).rejects.toMatchObject({
      reason: "size-unavailable",
    });
    expect((await pin("lz.small"))?.provider).toBe("lizard");
    expect(JSON.stringify(prepared?.state)).toContain(
      "No space left on device",
    );
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
    await env.DB.prepare("DELETE FROM orb_deployment_preparation").run();
    await prepare();
    const failed = await findDeploymentPreparation(env.DB, "lizard");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("No Orb size could run");
  });

  it("is never a person's own connection, only the deployment's", async () => {
    await prepare();
    const page = async (deploymentOrbs: DeploymentOrbs) => {
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
          deploymentOrbs,
          // Open to everyone, as a deployment's own offer is once launched.
          closedOrbProviders: async () => new Set(),
        }),
      );
      router.onError(errorHandler);
      return router;
    };
    // A person cannot save their own Lizard key.
    const saved = await (await page({})).request(
      "/personal/orb-providers/lizard/connection",
      {
        method: "PUT",
        body: JSON.stringify({ credentials: { apiKey: "liz_someone_else" } }),
        headers: { "content-type": "application/json" },
      },
      withLizard(),
    );
    expect(saved.status).toBe(400);
    type Page = {
      data: {
        providers: Array<{
          id: string;
          fields: Array<unknown>;
          deployment: boolean;
        }>;
        resolved: Array<{
          providerId: string;
          scope: string;
          displayName: string;
          status: string;
        }>;
      };
    };
    const read = async (deploymentOrbs: DeploymentOrbs) => {
      const response = await (await page(deploymentOrbs)).request(
        "/personal/orb-providers",
        {},
        withLizard(),
      );
      const text = await response.text();
      expect(text).not.toContain(world.apiKey);
      return (JSON.parse(text) as Page).data;
    };
    // Unpresented, it is listed as the deployment's account, with no form.
    const plain = await read({});
    expect(plain.providers.find(({ id }) => id === "lizard")).toMatchObject({
      deployment: true,
      fields: [],
    });
    // Presented under the deployment's own name, it is offered
    // as that, ready, and not listed under Lizard at all.
    const hosted = await read({
      lizard: {
        displayName: "Hosted Orbs",
        description: "Pauses when idle.",
        inactivityMs: 3_600_000,
        costLabels: {},
      },
    });
    expect(hosted.providers.find(({ id }) => id === "lizard")).toBeUndefined();
    expect(
      hosted.resolved.find(({ providerId }) => providerId === "lizard"),
    ).toMatchObject({
      scope: "deployment",
      displayName: "Hosted Orbs",
      status: "ready",
    });
  });

  it("starts a Thread from its size's snapshot as `user`, pauses it when idle, resumes it, archives and destroys it", async () => {
    await prepare();
    const pinned = await pinThread("lz.small");
    const target = await Effect.runPromise(
      resolveExecutionTarget(withLizard(), threadId, { admission: false }),
    );
    expect(target.profile).toMatchObject({
      adapter: "lizard",
      size: "small",
      snapshot: pinned?.providerTemplate,
    });
    // Core composes the deployment's key with its project.
    const context = await composedContext();
    expect(Redacted.value(context.credentials as never)).toEqual({
      apiKey: world.apiKey,
      projectId: world.projectId,
    });

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
    // A pause keeps files only, so the handle says when the Orb's
    // processes started: a Terminal from before a pause is gone.
    expect(handle.processesStartedAt).toBe(1_794_300_000 * 1_000);
    const ran = await handle.guest.commands.run("whoami", {
      cwd: "/home/user",
    });
    expect(ran.exitCode).toBe(0);
    expect(thread?.execs.at(-1)).toMatchObject({ user: "user" });
    expect(thread?.execs.at(-1)?.cmd).toContain("exec bash -l -c");

    // Idle: the deadline lives in D1, and the minute sweep pauses the Orb.
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
    expect(
      (await resumed.guest.commands.run("true", { cwd: "/home/user" }))
        .exitCode,
    ).toBe(0);
    expect(
      [...world.sandboxes.values()].filter(
        ({ snapshotId }) => snapshotId === pinned?.providerTemplate,
      ),
    ).toHaveLength(2); // the preparation's test Orb, and the Thread's

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
