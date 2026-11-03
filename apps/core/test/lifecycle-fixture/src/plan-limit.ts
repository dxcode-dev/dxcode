import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import { sweepClaudePlanWaits } from "../../../src/claude-code/plan-wait.js";
import type { AppEnv } from "../../../src/http/types.js";
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
