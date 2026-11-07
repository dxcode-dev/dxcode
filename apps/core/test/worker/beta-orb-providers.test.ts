import { env } from "cloudflare:test";
import { Principal, type UserId } from "@dx/domain";
import { Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { makeBoatConnector } from "../../src/execution/boat/connector.js";
import type { DeploymentOrbs } from "../../src/execution/deployment-orbs.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import type { OrbProviderConnectors } from "../../src/plugins/execution/connector.js";
import { hiddenOrbProviders } from "../../src/plugins/execution/orb-provider-beta.js";
import { makePersonalOrbProviderRoutes } from "../../src/plugins/execution/orb-provider-routes.js";
import { resolveThreadExecutionPin } from "../../src/plugins/execution/orb-providers.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { setBetaOrbProviders } from "./beta-orb-providers.js";
import { fakeBoat, type World } from "./fake-boat.js";

/**
 * Boat, Docker Cloud Sandboxes, and Freestyle are in beta (#1924): each is
 * offered to a person only after they turn on its personal experimental
 * feature. E2B and Cloudflare are offered to everyone. Boat runs here on the
 * deployment's own account, so without the gate it would be listed and
 * pinned for every person.
 */

const person = "beta-orb-person" as UserId;
const project = "prj_00000000-0000-4000-8000-0000000019b1";
const timestamp = "2026-11-07T00:00:00.000Z";
const deploymentKey = "boat_deployment_key_beta";

const bindings: Bindings = {
  DB: env.DB,
  DX_RUNTIME_MODE: "deployed",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  BOAT_API_KEY: deploymentKey,
};

const principal = Schema.decodeUnknownSync(Principal)({
  userId: person,
  credentialScopes: ["personal", "workspace"],
});

let connectors: OrbProviderConnectors;

const app = (deploymentOrbs: DeploymentOrbs = {}) => {
  const router = new Hono<AppEnv>();
  router.use("*", requestId);
  router.use("*", async (context, next) => {
    context.set("principal", principal);
    await next();
  });
  router.route(
    "/personal/orb-providers",
    makePersonalOrbProviderRoutes({ connectors, deploymentOrbs }),
  );
  router.onError(errorHandler);
  return router;
};

const page = async (deploymentOrbs: DeploymentOrbs = {}) => {
  const response = await app(deploymentOrbs).request(
    "/personal/orb-providers",
    {},
    bindings,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    readonly data: {
      readonly providers: ReadonlyArray<{ readonly id: string }>;
      readonly resolved: ReadonlyArray<{ readonly providerId: string }>;
    };
  };
  return {
    listed: body.data.providers.map(({ id }) => id),
    offered: body.data.resolved.map(({ providerId }) => providerId),
  };
};

const connectBoat = async () =>
  (
    await app().request(
      "/personal/orb-providers/boat/connection",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { apiKey: "boat_personal_key" } }),
      },
      bindings,
    )
  ).status;

/** Why a new Thread on Boat's medium size cannot start, as the route pins it. */
const boatPinRefusal = async (deploymentOrbs: DeploymentOrbs = {}) => {
  try {
    await resolveThreadExecutionPin({
      db: env.DB,
      bindings,
      userId: person,
      projectId: project,
      runnerProfileId: "bt.medium",
      connectors,
      hiddenProviders: () => hiddenOrbProviders(bindings, principal),
      deploymentOrbs,
    });
    return "pinned";
  } catch (cause) {
    return (cause as { readonly reason?: string }).reason ?? String(cause);
  }
};

beforeEach(async () => {
  const world: World = {
    keys: new Map([
      [
        deploymentKey,
        { id: "usr_boat_beta", plan: "p100", zeroDataRetention: false },
      ],
      [
        "boat_personal_key",
        { id: "usr_boat_person", plan: "p20", zeroDataRetention: false },
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
    ).bind(person, person, `${person}@example.com`, 1, 1),
    env.DB.prepare(
      `INSERT INTO projects (id, owner_user_id, workspace_id, name, runner_profile_id, created_at, updated_at)
       VALUES (?, ?, NULL, 'Beta project', 'bt.medium', ?, ?)`,
    ).bind(project, person, timestamp, timestamp),
  ]);
});

describe("Beta Orb providers", () => {
  it("offers Boat, Docker, and Freestyle only to a person who turned each on, and never hides E2B or Cloudflare", async () => {
    await setBetaOrbProviders(person, []);
    expect([...(await hiddenOrbProviders(bindings, principal))].sort()).toEqual(
      ["boat", "docker", "freestyle"],
    );
    const off = await page();
    expect(off.listed).not.toContain("boat");
    expect(off.offered).not.toContain("boat");
    expect(await connectBoat()).toBe(400);
    expect(await boatPinRefusal()).toBe("beta-provider-off");

    await setBetaOrbProviders(person, ["orb-provider-boat"]);
    expect([...(await hiddenOrbProviders(bindings, principal))].sort()).toEqual(
      ["docker", "freestyle"],
    );
    const on = await page();
    expect(on.listed).toContain("boat");
    expect(on.offered).toContain("boat");
    // Offered now: the deployment's account is still preparing its snapshot.
    expect(await boatPinRefusal()).toBe("preparing");
  });

  it("keeps offering the deployment's own Orb it presents under its own name, and gates only people's own Boat keys", async () => {
    const hosted: DeploymentOrbs = {
      boat: { displayName: "Hosted Orb", description: "The deployment's Orb." },
    };
    await setBetaOrbProviders(person, []);
    const off = await page(hosted);
    // The deployment's own Orb is offered under its name...
    expect(off.offered).toContain("boat");
    // ...but Boat for a person's own key is not listed or connectable.
    expect(off.listed).not.toContain("boat");
    expect(await connectBoat()).toBe(400);
    // A new Thread waits for the deployment's snapshot instead of finding no provider.
    expect(await boatPinRefusal(hosted)).toBe("preparing");
  });

  it("refuses a Thread meant for a person's own Boat key while the flag is off, instead of moving it to the deployment's Orb", async () => {
    const hosted: DeploymentOrbs = {
      boat: { displayName: "Hosted Orb", description: "The deployment's Orb." },
    };
    await setBetaOrbProviders(person, ["orb-provider-boat"]);
    expect(await connectBoat()).toBe(200);
    await setBetaOrbProviders(person, []);
    // The person's own key wins Boat's sizes, so with it hidden nothing
    // else may run them: no fallback to the deployment's account.
    expect((await page(hosted)).offered).not.toContain("boat");
    expect(await boatPinRefusal(hosted)).toBe("beta-provider-off");
  });
});
