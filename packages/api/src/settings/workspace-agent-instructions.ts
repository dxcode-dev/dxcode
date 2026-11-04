import { WorkspaceAgentInstructionsContent } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "./field-error.js";

const Revision = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

/**
 * A workspace's AGENTS.md: `GET` and `PUT`
 * `/v1/settings/workspaces/:workspaceSlug/agent-instructions`. Every member
 * reads it; only admins change it.
 */
export const WorkspaceAgentInstructionsDataSchema = Schema.Struct({
  instructions: WorkspaceAgentInstructionsContent,
  /** 0 until the first save; each save adds one. */
  revision: Revision,
  canUpdate: Schema.Boolean,
  updatedAt: Schema.NullOr(Schema.String),
});
export type WorkspaceAgentInstructionsData =
  typeof WorkspaceAgentInstructionsDataSchema.Type;

/** The server enforces the length; `expectedRevision` refuses a stale save. */
export const UpdateWorkspaceAgentInstructionsRequestSchema = Schema.Struct({
  instructions: Schema.String,
  expectedRevision: Schema.Number,
});
export type UpdateWorkspaceAgentInstructionsRequest =
  typeof UpdateWorkspaceAgentInstructionsRequestSchema.Type;

export const WorkspaceAgentInstructionsResponseSchema = successResponse(
  WorkspaceAgentInstructionsDataSchema,
);

export const WorkspaceAgentInstructionsErrorResponseSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("error"),
    data: Schema.Struct({
      code: Schema.Literal("INVALID_WORKSPACE_AGENT_INSTRUCTIONS"),
      message: Schema.Literal("Workspace instructions validation failed."),
      requestId: Schema.String,
      fieldErrors: Schema.Array(SettingsFieldErrorSchema),
    }),
  }),
  Schema.Struct({
    status: Schema.Literal("error"),
    data: Schema.Struct({
      code: Schema.Literal("WORKSPACE_AGENT_INSTRUCTIONS_REVISION_CONFLICT"),
      message: Schema.Literal(
        "Workspace instructions changed in another session. Reload before saving.",
      ),
      requestId: Schema.String,
      currentRevision: Revision,
    }),
  }),
  errorResponse(
    "WORKSPACE_AGENT_INSTRUCTIONS_FORBIDDEN",
    "Only workspace admins can change the workspace instructions.",
  ),
  errorResponse(
    "WORKSPACE_AGENT_INSTRUCTIONS_UNAVAILABLE",
    "Workspace instructions are temporarily unavailable.",
  ),
]);
export type WorkspaceAgentInstructionsErrorResponse =
  typeof WorkspaceAgentInstructionsErrorResponseSchema.Type;
