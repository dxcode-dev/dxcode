import { env } from "cloudflare:test";
import { claudePlanLimitText, type ThreadId, type UserId } from "@dx/domain";
import type { FlueObservation, ToolDefinition } from "@flue/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sweepAutomations } from "../../src/automations/sweep.js";
import type { Bindings } from "../../src/http/types.js";
import { recordFlueThreadActivity } from "../../src/threads/activity.js";
import { createThreadTools } from "../../src/threads/agent-tools.js";

/**
 * #1578: a Thread whose wake failed on its Claude plan's limit tells the
 * Thread that asks that it waits for the reset, and the Worker cron resumes
 * it through the owner's agent route once the reset passes.
 */

// DxAgent's routes need a Flue-built server entry; this one records what
// the cron sends and admits it as Flue would.
const agentRequests = vi.hoisted(
  () => [] as Array<{ threadId: string; body: unknown }>,
);
vi.mock("../../src/agents/routes.js", async () => {
  const { Hono } = await import("hono");
  return {
    dxAgentRoutes: new Hono()
      .post("/:threadId", async (context) => {
        agentRequests.push({
          threadId: context.req.param("threadId"),
          body: await context.req.json(),
        });
        return context.json({ submissionId: "sub-resumed" }, 202);
      })
      .all("*", (context) => context.notFound()),
  };
});

const owner = "usr_00000000-0000-4000-8000-000000000b01" as UserId;
const projectId = "prj_00000000-0000-4000-8000-000000000b01";
const caller = "thr_00000000-0000-4000-8000-000000000b01" as ThreadId;
const child = "thr_00000000-0000-4000-8000-000000000b02" as ThreadId;

const observe = (
  type: string,
  submissionId: string,
  timestamp: string,
  settled?: { outcome: string; error?: { message: string } },
) =>
  recordFlueThreadActivity(
    {
      type,
      instanceId: child,
      submissionId,
      timestamp,
      ...settled,
    } as unknown as FlueObservation,
    {
      id: "fixture",
      agentName: "dx",
      env: { DB: env.DB, REALTIME_HUB: env.REALTIME_HUB },
    } as never,
  );

const tool = (name: string) => {
  const found = createThreadTools(caller, () => ({
    db: env.DB,
    bindings: env as unknown as Bindings,
  })).find((candidate: ToolDefinition) => candidate.name === name) as unknown as
    | {
        run: (input: {
          data: Record<string, unknown>;
          toolCallId: string;
        }) => Promise<{ output: Record<string, unknown> }>;
      }
    | undefined;
  if (found === undefined) throw new Error(`No ${name} tool.`);
  return (data: Record<string, unknown>) =>
    found
      .run({ data, toolCallId: `call-${crypto.randomUUID()}` })
      .then(({ output }) => output);
};

const statusOf = async () =>
  (await tool("get_thread_status")({ thread: child })) as {
    state: string;
    waitingForPlanReset?: string;
  };

beforeEach(async () => {
  agentRequests.length = 0;
  const at = "2026-11-02T23:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
    ).bind(owner, "Plan Owner", "plan-wait@example.test"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, 'Plan wait', ?, ?)",
    ).bind(projectId, owner, at, at),
    ...[caller, child].map((id) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO threads (id, project_id, owner_user_id, parent_thread_id,
           title, lifecycle_state, created_at, updated_at, last_activity_at)
         VALUES (?, ?, ?, ?, 'Plan wait', 'active', ?, ?, ?)`,
      ).bind(id, projectId, owner, id === child ? caller : null, at, at, at),
    ),
  ]);
});

describe("A Thread waiting for its Claude plan's reset", () => {
  it("tells the asking Thread it is queued, and the cron resumes it once the reset passes", async () => {
    // The owner's PR comment woke the child at 23:47; its plan was used up
    // until 00:20:30.
    const resetsAt = Date.parse("2026-11-03T00:20:30Z") / 1000;
    await observe("submission_running", "sub-wake", "2026-11-02T23:47:00Z");
    await observe("submission_settled", "sub-wake", "2026-11-02T23:47:01Z", {
      outcome: "failed",
      error: {
        message: claudePlanLimitText({
          window: "five_hour",
          resetsAt,
          cause: "not-started",
        }),
      },
    });

    // The Thread that sent it sees the wake is queued, not lost.
    expect(await statusOf()).toMatchObject({
      state: "idle",
      waitingForPlanReset: "2026-11-03T00:20:30.000Z",
    });
    expect(
      await tool("wait_for_threads")({ threads: [child], timeout_seconds: 5 }),
    ).toMatchObject({
      settled: true,
      threads: [
        { threadId: child, waitingForPlanReset: "2026-11-03T00:20:30.000Z" },
      ],
    });

    // Before the reset the cron leaves it; after it, the cron resumes it.
    await sweepAutomations(
      env as unknown as Bindings,
      new Date("2026-11-03T00:20:29Z"),
    );
    expect(agentRequests).toEqual([]);
    const tick = await sweepAutomations(
      env as unknown as Bindings,
      new Date("2026-11-03T00:21:00Z"),
    );
    expect(tick.resumed).toBe(1);
    expect(agentRequests).toEqual([
      {
        threadId: child,
        body: { kind: "resume", idempotencyKey: expect.any(String) },
      },
    ]);
    // A tick before the resumed turn shows sends the same key, which Flue
    // admits once.
    await sweepAutomations(
      env as unknown as Bindings,
      new Date("2026-11-03T00:22:00Z"),
    );
    expect(agentRequests[1]).toEqual(agentRequests[0]);

    // The resumed turn starts: the wait is over, and no tick resumes again.
    await observe("submission_running", "sub-resumed", "2026-11-03T00:22:01Z");
    expect((await statusOf()).waitingForPlanReset).toBeUndefined();
    agentRequests.length = 0;
    await sweepAutomations(
      env as unknown as Bindings,
      new Date("2026-11-03T00:23:00Z"),
    );
    expect(agentRequests).toEqual([]);
  });

  it("does not wait on a failure that is not the plan's limit", async () => {
    await observe("submission_running", "sub-other", "2026-11-02T23:50:00Z");
    await observe("submission_settled", "sub-other", "2026-11-02T23:50:01Z", {
      outcome: "failed",
      error: { message: "The model provider is temporarily unavailable." },
    });
    expect((await statusOf()).waitingForPlanReset).toBeUndefined();
    await sweepAutomations(
      env as unknown as Bindings,
      new Date("2026-11-04T00:00:00Z"),
    );
    expect(agentRequests).toEqual([]);
  });
});
