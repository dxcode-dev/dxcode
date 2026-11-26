import { WorkspaceAgentInstructionsContent } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { errorResponse, successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "./field-error.js";
import { WorkspaceSettingsParamsSchema } from "./workspace-params.js";

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

export const WorkspaceAgentInstructionsInvalidResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("INVALID_WORKSPACE_AGENT_INSTRUCTIONS"),
    message: Schema.Literal("Workspace instructions validation failed."),
    requestId: Schema.String,
    fieldErrors: Schema.Array(SettingsFieldErrorSchema),
  }),
});

export const WorkspaceAgentInstructionsConflictResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("WORKSPACE_AGENT_INSTRUCTIONS_REVISION_CONFLICT"),
    message: Schema.Literal(
      "Workspace instructions changed in another session. Reload before saving.",
    ),
    requestId: Schema.String,
    currentRevision: Revision,
  }),
});

export const WorkspaceAgentInstructionsForbiddenResponseSchema = errorResponse(
  "WORKSPACE_AGENT_INSTRUCTIONS_FORBIDDEN",
  "Only workspace admins can change the workspace instructions.",
);

export const WorkspaceAgentInstructionsUnavailableResponseSchema =
  errorResponse(
    "WORKSPACE_AGENT_INSTRUCTIONS_UNAVAILABLE",
    "Workspace instructions are temporarily unavailable.",
  );

export const WorkspaceAgentInstructionsErrorResponseSchema = Schema.Union([
  WorkspaceAgentInstructionsInvalidResponseSchema,
  WorkspaceAgentInstructionsConflictResponseSchema,
  WorkspaceAgentInstructionsForbiddenResponseSchema,
  WorkspaceAgentInstructionsUnavailableResponseSchema,
]);
export type WorkspaceAgentInstructionsErrorResponse =
  typeof WorkspaceAgentInstructionsErrorResponseSchema.Type;

export const GetWorkspaceAgentInstructionsEndpoint = defineEndpoint({
  id: "settings.workspaceAgentInstructions.get",
  method: "GET",
  path: "/v1/settings/workspaces/:workspaceSlug/agent-instructions",
  params: WorkspaceSettingsParamsSchema,
  success: WorkspaceAgentInstructionsResponseSchema,
  refusals: [
    { status: 403, schema: WorkspaceAgentInstructionsForbiddenResponseSchema },
    {
      status: 503,
      schema: WorkspaceAgentInstructionsUnavailableResponseSchema,
    },
  ],
});

export const UpdateWorkspaceAgentInstructionsEndpoint = defineEndpoint({
  id: "settings.workspaceAgentInstructions.update",
  method: "PUT",
  path: "/v1/settings/workspaces/:workspaceSlug/agent-instructions",
  params: WorkspaceSettingsParamsSchema,
  body: UpdateWorkspaceAgentInstructionsRequestSchema,
  success: WorkspaceAgentInstructionsResponseSchema,
  refusals: [
    { status: 400, schema: WorkspaceAgentInstructionsInvalidResponseSchema },
    { status: 409, schema: WorkspaceAgentInstructionsConflictResponseSchema },
    { status: 403, schema: WorkspaceAgentInstructionsForbiddenResponseSchema },
    {
      status: 503,
      schema: WorkspaceAgentInstructionsUnavailableResponseSchema,
    },
  ],
});
