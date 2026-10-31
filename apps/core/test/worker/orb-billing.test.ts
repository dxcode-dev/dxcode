import { env } from "cloudflare:test";
import { ProjectRepository, ThreadRepository, UserId } from "@dx/domain";
import { FlueError } from "@flue/runtime";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeExecutionActivation } from "../../src/execution/activation.js";
import {
  noOrbBilling,
  type OrbBillingPolicy,
  type OrbStartRequest,
  type OrbUsage,
} from "../../src/execution/orb-billing.js";
import type { Bindings } from "../../src/http/types.js";
import {
  composeExecutionWorkspaces,
  type ExecutionWorkspaceHandle,
} from "../../src/plugins/execution/provider.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * A run's Orb start through Core's real activation pipeline and composition
 * over real D1, with the deployment's billing policy in front of the
 * provider. Public dx ships the no-op policy; dx's own deployment registers
 * one that can refuse a start with a reason the Thread shows, or meter it.
 */

const now = "2026-10-31T12:00:00.000Z";
const owner = Schema.decodeUnknownSync(UserId)("billing-owner");
const ownerProject = project(
  "prj_00000000-0000-4000-8000-000000000b01",
  owner,
  "Billing",
);
const billedThread = thread(
  "thr_00000000-0000-4000-8000-000000000b01",
  ownerProject.id,
  owner,
  now,
);

const bindings: Bindings = {
  DB: env.DB,
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  DX_RUNTIME_MODE: "deployed",
  E2B_API_KEY: "deployment-key",
};

/** Stops the activation once the Orb is up; the guest is not faked. */
const orbUp = new Error("Orb started.");

/**
 * Flue's sandbox factory for the Thread's run, over a provider whose
 * create stands for the Orb starting.
 */
const orbStart = (policy: OrbBillingPolicy) => {
  const handle = {
    inactivityMs: 600_000,
    setIdleDeadline: vi.fn(async () => undefined),
    development: {
      source: async () => {
        throw orbUp;
      },
    },
  } as unknown as ExecutionWorkspaceHandle;
  const create = vi.fn(async () => handle);
  const workspaces = composeExecutionWorkspaces(
    bindings,
    {
      e2b: {
        workspace: { create, connect: vi.fn(), release: vi.fn() },
      },
    },
    makeExecutionActivation({ orbBilling: policy }),
    [{ providerId: "e2b", capabilities: ["execution.workspace"] }],
  );
  return {
    create,
    run: () => workspaces.sandboxFactory.createSandbox({ id: billedThread.id }),
  };
};

const recordingPolicy = (
  decision: Awaited<ReturnType<OrbBillingPolicy["admitOrbStart"]>>,
) => {
  const requests: OrbStartRequest[] = [];
  const usage: OrbUsage[] = [];
  const policy: OrbBillingPolicy = {
    admitOrbStart: async (request) => {
      requests.push(request);
      return decision;
    },
    recordUsage: async (reported) => {
      usage.push(reported);
    },
  };
  return { policy, requests, usage };
};

beforeEach(async () => {
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
  )
    .bind(owner, "Ada Owner", `${owner}@example.test`, now, now)
    .run();
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(ownerProject);
      yield* (yield* ThreadRepository).insert(billedThread);
    }),
  );
  // The fixture names a profile outside the test catalog.
  await env.DB.prepare(
    "UPDATE projects SET runner_profile_id = 'a1.medium' WHERE id = ?",
  )
    .bind(ownerProject.id)
    .run();
});

describe("Orb billing policy, in workerd with real D1", () => {
  it("public dx's no-op policy lets the Orb start", async () => {
    const start = orbStart(noOrbBilling);
    await expect(start.run()).rejects.toBe(orbUp);
    expect(start.create).toHaveBeenCalledOnce();
  });

  it("a refusing policy blocks the Orb start with the reason the Thread shows", async () => {
    const reason = "Your Orb credits are used up.";
    const refusing = recordingPolicy({ outcome: "refuse", reason });
    const start = orbStart(refusing.policy);
    let failure: unknown;
    await start.run().catch((cause) => {
      failure = cause;
    });
    // Flue settles the run with this error; a plain Error would lose it.
    expect(failure).toBeInstanceOf(FlueError);
    expect(failure).toEqual(
      expect.objectContaining({
        type: "orb_start_refused",
        message: reason,
        meta: expect.objectContaining({ code: "ORB_START_REFUSED" }),
      }),
    );
    expect(start.create).not.toHaveBeenCalled();
    expect(refusing.requests).toEqual([
      {
        threadId: billedThread.id,
        operation: "create",
        account: { scope: "deployment" },
        providerId: "e2b",
        runnerProfileId: "a1.medium",
      },
    ]);
    expect(refusing.usage).toEqual([]);
  });

  it("an allowed start reports no usage; a metered start reports its Orb time", async () => {
    const allowing = recordingPolicy({ outcome: "allow" });
    await expect(orbStart(allowing.policy).run()).rejects.toBe(orbUp);
    expect(allowing.usage).toEqual([]);

    const metering = recordingPolicy({ outcome: "meter" });
    const before = Date.now();
    const start = orbStart(metering.policy);
    await expect(start.run()).rejects.toBe(orbUp);
    expect(start.create).toHaveBeenCalledOnce();
    // The Orb runs at least until the idle deadline its start set.
    expect(metering.usage).toEqual([
      {
        kind: "orb-time",
        threadId: billedThread.id,
        account: { scope: "deployment" },
        providerId: "e2b",
        runnerProfileId: "a1.medium",
        from: expect.any(Number),
        until: expect.any(Number),
      },
    ]);
    const [reported] = metering.usage;
    expect(reported?.from).toBeGreaterThanOrEqual(before);
    expect((reported?.until ?? 0) - (reported?.from ?? 0)).toBe(600_000);
  });
});
