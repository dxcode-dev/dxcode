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
  type OrbUsageOutcome,
  withOrbBilling,
} from "../../src/execution/orb-billing.js";
import type { Bindings } from "../../src/http/types.js";
import {
  composeExecutionWorkspaces,
  type ExecutionContext,
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
 * `create` call (after Core's admission) stands for the Orb starting.
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
  // Like every provider, it runs Core's admission before the Orb starts.
  const create = vi.fn<(...input: unknown[]) => Promise<void>>();
  const provider = vi.fn(
    async (
      _context: unknown,
      _owner: unknown,
      options: { readonly authorize: () => Promise<void> },
    ) => {
      await options.authorize();
      await create();
      return handle;
    },
  );
  const workspaces = composeExecutionWorkspaces(
    bindings,
    {
      e2b: {
        workspace: { create: provider, connect: vi.fn(), release: vi.fn() },
      },
    },
    makeExecutionActivation({ orbBilling: policy }),
    [{ providerId: "e2b", capabilities: ["execution.workspace"] }],
  );
  return {
    create,
    provider,
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
      return "continue";
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

  it("a Thread whose authorization fails starts and bills no Orb, while the checks run in parallel", async () => {
    // Ways this could fail: the billing decision or the provider's reads run
    // beside the checks and the start does not wait for them; a refused
    // check surfaces as a provider error instead of the run's own reason.
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(billedThread.id)
      .run();
    const metering = recordingPolicy({ outcome: "meter" });
    const start = orbStart(metering.policy);
    await expect(start.run()).rejects.not.toBe(orbUp);
    // The provider was reached, and its start waited for the refusal.
    expect(start.provider).toHaveBeenCalledOnce();
    expect(start.create).not.toHaveBeenCalled();
    expect(metering.usage).toEqual([]);
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

  it("a renewal the policy stops keeps the Orb's deadline where it is", async () => {
    let outcome: OrbUsageOutcome = "continue";
    const usage: OrbUsage[] = [];
    const setIdleDeadline = vi.fn(async (_durationMs: number) => undefined);
    const raw = {
      inactivityMs: 600_000,
      setIdleDeadline,
    } as unknown as ExecutionWorkspaceHandle;
    const provider = withOrbBilling(
      {
        workspace: {
          create: vi.fn(async () => raw),
          connect: vi.fn(async () => raw),
          release: vi.fn(async () => undefined),
        },
      },
      {
        admitOrbStart: async () => ({ outcome: "meter" }),
        recordUsage: async (reported) => {
          usage.push(reported);
          return outcome;
        },
      },
    );
    const context = {
      account: { scope: "deployment" },
      credentials: undefined,
      profile: { id: "a1.medium", adapter: "e2b" },
    } as unknown as ExecutionContext;
    const handle = await provider.workspace.connect(
      context,
      { threadId: billedThread.id },
      { authorize: async () => undefined },
    );
    await handle.setIdleDeadline(600_000);
    expect(setIdleDeadline).toHaveBeenCalledOnce();
    outcome = "stop";
    await handle.setIdleDeadline(600_000);
    expect(setIdleDeadline).toHaveBeenCalledOnce();
    // The start and both renewals were reported.
    expect(usage).toHaveLength(3);
  });

  it("pins a stopped Orb's deadline to its paid time, whatever extended it, and stops it when none is left", async () => {
    // Ways this could fail: a connect or resume moved the provider's
    // deadline past the paid time and a refused charge leaves it there; a
    // refused renewal extends it anyway; an Orb with paid time left is
    // stopped on a reconnect; one with none left keeps running.
    const setIdleDeadline = vi.fn(async (_durationMs: number) => undefined);
    const raw = {
      inactivityMs: 3_600_000,
      setIdleDeadline,
    } as unknown as ExecutionWorkspaceHandle;
    const release = vi.fn(async () => undefined);
    let paidUntil = Date.now() + 120_000;
    const provider = withOrbBilling(
      {
        workspace: {
          create: vi.fn(async () => raw),
          // Like Boat's resume: the provider sets its own full idle hour.
          connect: vi.fn(async () => raw),
          release,
        },
      },
      {
        admitOrbStart: async () => ({ outcome: "meter" }),
        recordUsage: async () => "stop",
        paidUntil: async () => paidUntil,
        stopRefusal: { reason: "Out of credits." },
      },
    );
    const context = {
      account: { scope: "deployment" },
      credentials: undefined,
      profile: { id: "a1.medium", adapter: "e2b" },
    } as unknown as ExecutionContext;
    const owner = { threadId: billedThread.id };
    const pinned = () => setIdleDeadline.mock.calls.at(-1)?.[0] ?? 0;
    // A reconnect with two paid minutes left keeps the Orb, pinned to stop
    // inside them: early enough that the provider's stop ends by then.
    const handle = await provider.workspace.connect(context, owner, {
      authorize: async () => undefined,
    });
    expect(release).not.toHaveBeenCalled();
    expect(pinned()).toBeGreaterThan(90_000);
    expect(pinned()).toBeLessThanOrEqual(110_000);
    // A busy Orb's renewal is refused: still pinned, never extended.
    await handle.setIdleDeadline(3_600_000);
    expect(pinned()).toBeLessThanOrEqual(110_000);
    expect(
      setIdleDeadline.mock.calls.every(([duration]) => duration <= 110_000),
    ).toBe(true);
    // Its paid time is over and it still runs: the next refused renewal
    // stops it, keeping its files.
    paidUntil = Date.now() - 1;
    await handle.setIdleDeadline(3_600_000);
    expect(release).toHaveBeenCalledWith(context, owner, "archive");
    // A start with nothing paid is stopped and refused.
    await expect(
      provider.workspace.connect(context, owner, {
        authorize: async () => undefined,
      }),
    ).rejects.toEqual(expect.objectContaining({ type: "orb_start_refused" }));
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("pins an unpaid Orb's deadline to now when its stop is still pending or fails", async () => {
    // Ways this could fail: a provider answers `stopping` (#1740) and its
    // deadline stays where a resume or renewal set it, so the unpaid Orb
    // runs until the provider's own retry; a failed stop leaves it running
    // the same way; a refused start still opens; a confirmed stop is pinned
    // needlessly.
    const setIdleDeadline = vi.fn(async (_durationMs: number) => undefined);
    const raw = {
      inactivityMs: 3_600_000,
      setIdleDeadline,
    } as unknown as ExecutionWorkspaceHandle;
    const answers: Array<() => Promise<void | "stopping">> = [
      async () => "stopping",
      async () => {
        throw new Error("Boat is unavailable");
      },
      async () => undefined,
    ];
    const release = vi.fn(async () =>
      (answers.shift() as () => Promise<void | "stopping">)(),
    );
    let paidUntil = Date.now() + 120_000;
    const provider = withOrbBilling(
      {
        workspace: {
          create: vi.fn(async () => raw),
          connect: vi.fn(async () => raw),
          release,
        },
      },
      {
        admitOrbStart: async () => ({ outcome: "meter" }),
        recordUsage: async () => "stop",
        paidUntil: async () => paidUntil,
        stopRefusal: { reason: "Out of credits." },
      },
    );
    const context = {
      account: { scope: "deployment" },
      credentials: undefined,
      profile: { id: "a1.medium", adapter: "e2b" },
    } as unknown as ExecutionContext;
    const owner = { threadId: billedThread.id };
    const handle = await provider.workspace.connect(context, owner, {
      authorize: async () => undefined,
    });
    // Paid time runs out mid-session; the stop is still pending.
    paidUntil = Date.now() - 1;
    await handle.setIdleDeadline(3_600_000);
    expect(release).toHaveBeenCalledTimes(1);
    expect(setIdleDeadline.mock.calls.at(-1)?.[0]).toBe(0);
    // A start with nothing paid whose stop fails: pinned, and refused.
    setIdleDeadline.mockClear();
    await expect(
      provider.workspace.connect(context, owner, {
        authorize: async () => undefined,
      }),
    ).rejects.toEqual(expect.objectContaining({ type: "orb_start_refused" }));
    expect(release).toHaveBeenCalledTimes(2);
    expect(setIdleDeadline.mock.calls).toEqual([[0]]);
    // A stop that finishes needs no pin.
    setIdleDeadline.mockClear();
    await expect(
      provider.workspace.connect(context, owner, {
        authorize: async () => undefined,
      }),
    ).rejects.toEqual(expect.objectContaining({ type: "orb_start_refused" }));
    expect(release).toHaveBeenCalledTimes(3);
    expect(setIdleDeadline).not.toHaveBeenCalled();
  });

  it("stops an Orb whose first Orb time the policy refuses, and refuses the start with the policy's reason", async () => {
    // Ways this could fail: the first report's refusal is ignored, so the
    // Orb runs to the deadline its create set, unpaid; the Orb is refused
    // but left running; the run fails without the reason and its link.
    const setIdleDeadline = vi.fn(async (_durationMs: number) => undefined);
    const raw = {
      inactivityMs: 600_000,
      setIdleDeadline,
    } as unknown as ExecutionWorkspaceHandle;
    const release = vi.fn(async () => undefined);
    const reason = "Your credits don't cover this Orb.";
    const provider = withOrbBilling(
      {
        workspace: {
          create: vi.fn(async () => raw),
          connect: vi.fn(async () => raw),
          release,
        },
      },
      {
        admitOrbStart: async () => ({ outcome: "meter" }),
        recordUsage: async () => "stop",
        stopRefusal: {
          reason,
          action: { label: "Add credits", href: "/settings/billing" },
        },
      },
    );
    const context = {
      account: { scope: "deployment" },
      credentials: undefined,
      profile: { id: "a1.medium", adapter: "e2b" },
    } as unknown as ExecutionContext;
    for (const open of [provider.workspace.create, provider.workspace.connect])
      await expect(
        open(
          context,
          { threadId: billedThread.id },
          { authorize: async () => undefined },
        ),
      ).rejects.toEqual(
        expect.objectContaining({
          type: "orb_start_refused",
          message: reason,
          meta: expect.objectContaining({
            actionLabel: "Add credits",
            actionHref: "/settings/billing",
          }),
        }),
      );
    // Each Orb was stopped, keeping its files, and never extended.
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith(
      context,
      { threadId: billedThread.id },
      "archive",
    );
    expect(setIdleDeadline).not.toHaveBeenCalled();
  });

  it("tells the policy when a metered start's create fails, so it can refund", async () => {
    const failed: OrbStartRequest[] = [];
    const policy: OrbBillingPolicy = {
      admitOrbStart: async () => ({ outcome: "meter" }),
      recordUsage: async () => "continue",
      startFailed: async (request) => {
        failed.push(request);
      },
    };
    const refused = new Error("No machine.");
    const provider = withOrbBilling(
      {
        workspace: {
          create: vi.fn(async () => {
            throw refused;
          }),
          connect: vi.fn(),
          release: vi.fn(async () => undefined),
        },
      },
      policy,
    );
    const context = {
      account: { scope: "deployment" },
      credentials: undefined,
      profile: { id: "a1.medium", adapter: "e2b" },
    } as unknown as ExecutionContext;
    await expect(
      provider.workspace.create(
        context,
        { threadId: billedThread.id },
        { authorize: async () => undefined },
      ),
    ).rejects.toBe(refused);
    expect(failed).toEqual([
      expect.objectContaining({
        threadId: billedThread.id,
        operation: "create",
      }),
    ]);
  });

  it("tells the policy when dx could not make a started Orb usable, but not when the person's own setup failed", async () => {
    const outcomeFor = async (failure: Error) => {
      const failed: OrbStartRequest[] = [];
      const handle = {
        inactivityMs: 600_000,
        setIdleDeadline: vi.fn(async () => undefined),
        development: {
          source: async () => {
            throw failure;
          },
        },
      } as unknown as ExecutionWorkspaceHandle;
      const workspaces = composeExecutionWorkspaces(
        bindings,
        {
          e2b: {
            workspace: {
              create: vi.fn(async () => handle),
              connect: vi.fn(),
              release: vi.fn(),
            },
          },
        },
        makeExecutionActivation({
          orbBilling: {
            admitOrbStart: async () => ({ outcome: "meter" }),
            recordUsage: async () => "continue",
            startFailed: async (request) => {
              failed.push(request);
            },
          },
        }),
        [{ providerId: "e2b", capabilities: ["execution.workspace"] }],
      );
      await expect(
        workspaces.sandboxFactory.createSandbox({ id: billedThread.id }),
      ).rejects.toBe(failure);
      return failed;
    };
    // dx's side failed after the Orb started: the policy hears of it.
    expect(await outcomeFor(new Error("dxd did not start."))).toEqual([
      expect.objectContaining({ threadId: billedThread.id }),
    ]);
    // The person's own setup failed: the Orb ran their script; no refund.
    expect(
      await outcomeFor(
        new FlueError({
          type: "pre_clone_script_failed",
          message: "The project's pre-clone script failed.",
          details: "",
          dev: "",
          meta: { code: "PRE_CLONE_SCRIPT_FAILED" },
        }),
      ),
    ).toEqual([]);
  });

  it("carries a refusal's app link to the Thread, and drops one that leaves the app", async () => {
    const refusal = async (href: string) => {
      const start = orbStart({
        admitOrbStart: async () => ({
          outcome: "refuse",
          reason: "Out of credits.",
          action: { label: "Add credits", href },
        }),
        recordUsage: async () => "continue",
      });
      return start.run().catch((cause: unknown) => cause);
    };
    expect(await refusal("/settings/billing")).toEqual(
      expect.objectContaining({
        type: "orb_start_refused",
        meta: expect.objectContaining({
          actionLabel: "Add credits",
          actionHref: "/settings/billing",
        }),
      }),
    );
    const outside = (await refusal("https://example.test/pay")) as FlueError;
    expect(outside.meta).not.toHaveProperty("actionHref");
  });
});
