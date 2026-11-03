"use agent";

import type { AgentProps, ModelResolutionContext } from "@flue/runtime";
import { useModel } from "@flue/runtime";
import { AGENT_RUN_LIMIT_MS } from "../../../../src/runtime/agent-run-limit.js";
import { refuseUsedUpPlan } from "../plan-state.js";

/**
 * A Claude Code Thread's agent as far as its plan goes: each submission
 * resolves its prompt data first, which refuses it while the plan is used up.
 */
export function FixturePlanAgent(_props: AgentProps) {
  useModel("faux-plan/faux-plan-1");
  return "Answer every message since your last answer.";
}

FixturePlanAgent.agentName = "fixture-plan-agent";
FixturePlanAgent.durability = { timeoutMs: AGENT_RUN_LIMIT_MS };
FixturePlanAgent.resolvePromptData = async (
  _initialData: unknown,
  context: ModelResolutionContext,
) => {
  refuseUsedUpPlan(context.instanceId);
  return undefined;
};
