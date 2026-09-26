import { WorkspacePolicyDenialReason } from "@dx/domain";
import { Schema } from "effect";

export const AgentWorkspacePolicyDeniedResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("WORKSPACE_POLICY_DENIED"),
    message: Schema.Literal("Workspace policy does not allow this action."),
    requestId: Schema.String,
    reason: WorkspacePolicyDenialReason,
  }),
});

export type AgentWorkspacePolicyDeniedResponse =
  typeof AgentWorkspacePolicyDeniedResponseSchema.Type;
