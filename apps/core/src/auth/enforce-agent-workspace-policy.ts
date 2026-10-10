import { AgentWorkspacePolicyDeniedResponseSchema } from "@dx/api";
import { WorkspacePolicyDenied } from "@dx/domain";
import { Effect, Result, Schema } from "effect";
import type { MiddlewareHandler } from "hono";
import { resolveExecutionRunnerProfile } from "../execution/runner-profiles/execution.js";
import type { AppEnv } from "../http/types.js";
import { authorizationLogger } from "../logging.js";

export const enforceAgentWorkspacePolicy: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  // Chat between members runs nothing.
  if (context.get("chatDelivery")) return next();
  const operation = resolveExecutionRunnerProfile(
    context.env,
    context.req.param("threadId") ?? "",
  );

  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isFailure(result)) {
    if (result.failure instanceof WorkspacePolicyDenied) {
      authorizationLogger.warn("Native agent admission denied by policy.", {
        event: "agent_workspace_policy_denied",
        requestId: context.get("requestId"),
        reason: result.failure.reason,
      });
      return context.json(
        Schema.encodeUnknownSync(AgentWorkspacePolicyDeniedResponseSchema)({
          status: "error",
          data: {
            code: "WORKSPACE_POLICY_DENIED",
            message: "Workspace policy does not allow this action.",
            requestId: context.get("requestId"),
            reason: result.failure.reason,
          },
        }),
        403,
      );
    }
    throw result.failure;
  }
  await next();
};
