import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import { sweepClaudePlanWaits } from "../../../src/claude-code/plan-wait.js";
import type { AppEnv } from "../../../src/http/types.js";
import {
  artifactCommented,
  artifactSaved,
  type DeliverArtifactWake,
} from "../../../src/thread-artifacts/ask-effects.js";
import { FixturePlanAgent } from "./agents/fixture-plan-agent.js";
import { reportPlanLimit } from "./plan-state.js";

const agentRoutes = createAgentRouter(FixturePlanAgent);

/**
 * Fixture routes: the runner's report, and one Worker cron tick of the
 * plan-reset sweep, which resumes each due Thread as its owner's Retry does.
 */
export const planLimitRoutes = new Hono<AppEnv>();
planLimitRoutes.post("/report-limit/:threadId", async (context) => {
  const { resetsAt } = await context.req.json<{ resetsAt: number }>();
  reportPlanLimit(context.req.param("threadId"), resetsAt);
  return context.body(null, 204);
});
planLimitRoutes.post("/tick", async (context) => {
  const db = context.env.DB;
  if (db === undefined) throw new Error("Fixture D1 binding is missing.");
  const resumed: Array<{ threadId: string; submissionId: string }> = [];
  await sweepClaudePlanWaits(db, new Date(), async (wait) => {
    const response = await agentRoutes.request(
      `/${encodeURIComponent(wait.threadId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "resume", idempotencyKey: wait.key }),
      },
      context.env,
    );
    const body = await response.json<{ submissionId?: string }>();
    if (response.status !== 202 || body.submissionId === undefined)
      throw new Error(`Resume failed: ${response.status}`);
    resumed.push({ threadId: wait.threadId, submissionId: body.submissionId });
  });
  return context.json({ resumed });
});

/**
 * A person's tick, or their comment that mentions the agent, through the
 * real artifact after-save and comment effects. A tick wakes nothing
 * (#1765); each comment's wake reaches the plan agent the way a production
 * wake reaches its agent: one user message, keyed so a repeat admits nothing
 * new. `now` spaces two comments past the agent wake window, and `comment`
 * numbers each one.
 */
planLimitRoutes.post("/artifact-wake/:threadId", async (context) => {
  const threadId = context.req.param("threadId");
  const {
    kind,
    now,
    comment = 1,
  } = await context.req.json<{
    kind: "tick" | "comment";
    now: number;
    comment?: number;
  }>();
  const deliver: DeliverArtifactWake = async (wake) => {
    const response = await agentRoutes.request(
      `/${encodeURIComponent(wake.threadId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "user",
          body: wake.body,
          idempotencyKey: wake.key,
        }),
      },
      context.env,
    );
    if (response.status !== 202)
      throw new Error(`Wake delivery failed: ${response.status}`);
    delivered.push(
      (await response.json<{ submissionId: string }>()).submissionId,
    );
  };
  const delivered: string[] = [];
  const person = { kind: "user" as const, userId: "plan-fixture-person" };
  if (kind === "tick")
    await artifactSaved(
      context.env,
      {
        threadId,
        artifactId: "art_00000000000000000000000000000001",
        title: "Plan",
        revision: 2,
        before: "- [ ] @[Owner](user:plan-fixture-owner) Approve the release\n",
        after: "- [x] @[Owner](user:plan-fixture-owner) Approve the release\n",
        writer: person,
      },
      { now },
    );
  else
    await artifactCommented(
      context.env,
      {
        threadId,
        artifactId: "art_00000000000000000000000000000001",
        commentId: `cmt_${String(comment).padStart(32, "0")}`,
        quote: "Approve the release",
        body: "@[dx](agent) add the changelog link",
        writer: person,
      },
      { deliver, now },
    );
  return context.json({ delivered });
});
