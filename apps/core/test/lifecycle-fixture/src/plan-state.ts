import {
  type ClaudePlanUsage,
  claudePlanLimitText,
  mergeClaudePlanUsage,
} from "@dx/domain";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { FlueError, setProvider } from "@flue/runtime";
import {
  claudePlanAccess,
  claudePlanBlockedCause,
} from "../../../src/claude-code/plan.js";
import { ClaudeCodeStream } from "../../../src/claude-code/stream.js";

/**
 * A Claude Code Thread whose plan Anthropic reports used up. The Claude Code
 * runner prints a `rate_limit_event`; dx reads it the way a run's stream
 * does and refuses each submission while the plan is used up, with the same
 * limit text the credential coordinator answers `/resolve` with.
 */

const MODEL = "claude-opus-5-5";
const plans = new Map<string, ClaudePlanUsage>();

export const reportPlanLimit = (threadId: string, resetsAt: number) => {
  const stream = new ClaudeCodeStream();
  stream.push(
    JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt,
        utilization: 1,
        overageStatus: "rejected",
        overageDisabledReason: "out_of_credits",
      },
    }),
  );
  if (stream.planReading === undefined)
    throw new Error("The runner's rate_limit_event did not parse.");
  plans.set(
    threadId,
    mergeClaudePlanUsage(
      plans.get(threadId),
      stream.planReading,
      stream.planReadingAt,
    ),
  );
};

/** DxAgent's `/resolve` refusal for a plan used up for the Thread's model. */
export const refuseUsedUpPlan = (threadId: string) => {
  const usage = plans.get(threadId);
  const plan = claudePlanAccess(
    { allowExtraUsage: false, ...(usage === undefined ? {} : { usage }) },
    MODEL,
  );
  if (plan.blockedUntil === undefined) return;
  throw new FlueError({
    type: "claude_plan_limit",
    message: claudePlanLimitText({
      ...(plan.limitWindow === undefined ? {} : { window: plan.limitWindow }),
      resetsAt: plan.blockedUntil,
      cause: claudePlanBlockedCause(plan),
    }),
    details: "",
    dev: "",
    meta: { code: "CLAUDE_PLAN_LIMIT" },
  });
};

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((block: { type?: string; text?: string }) =>
            block.type === "text" && typeof block.text === "string"
              ? [block.text]
              : [],
          )
          .join("")
      : "";

// Each answer names every message since the previous answer, in order.
const faux = fauxProvider({
  provider: "faux-plan",
  models: [{ id: "faux-plan-1", contextWindow: 1_000_000 }],
});
const answer = (context: {
  readonly messages: ReadonlyArray<{ role: string; content: unknown }>;
}) => {
  const last = context.messages.findLastIndex(
    ({ role }) => role === "assistant",
  );
  return fauxAssistantMessage(
    `Answered: ${context.messages
      .slice(last + 1)
      .filter(({ role }) => role === "user")
      .map(({ content }) => textOf(content))
      .join(" | ")}`,
  );
};
faux.setResponses(Array.from({ length: 50 }, () => answer));
setProvider(faux.provider);
