import {
  RunnerProfileCatalog,
  WorkspacePolicyRestrictions,
  WorkspaceRole,
  WorkspaceSlug,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

export const WorkspacePolicyParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceSlug,
});

export const WorkspacePolicyDataSchema = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  restrictions: WorkspacePolicyRestrictions,
  runnerProfileCatalog: RunnerProfileCatalog,
  canUpdate: Schema.Boolean,
  workspaceRole: WorkspaceRole,
});

export type WorkspacePolicyData = typeof WorkspacePolicyDataSchema.Type;

export const GetWorkspacePolicyResponseSchema = successResponse(
  WorkspacePolicyDataSchema,
);

export const UpdateWorkspacePolicyRequestSchema = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  restrictions: WorkspacePolicyRestrictions,
});

export const UpdateWorkspacePolicyResponseSchema =
  GetWorkspacePolicyResponseSchema;

export const WorkspacePolicyInvalidRequestResponseSchema = errorResponse(
  "INVALID_WORKSPACE_POLICY",
  "Workspace policy validation failed.",
);

export const WorkspacePolicyForbiddenResponseSchema = errorResponse(
  "WORKSPACE_POLICY_FORBIDDEN",
  "This workspace policy action is not permitted.",
);

export const WorkspacePolicyConflictResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("WORKSPACE_POLICY_CONFLICT"),
    message: Schema.Literal("Workspace policy changed in another session."),
    requestId: Schema.String,
    currentRevision: Schema.Int,
  }),
});

export const WorkspacePolicyPersistenceUnavailableResponseSchema =
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Workspace policy is temporarily unavailable.",
  );

export const WorkspacePolicyErrorResponseSchema = Schema.Union([
  WorkspacePolicyInvalidRequestResponseSchema,
  WorkspacePolicyForbiddenResponseSchema,
  WorkspacePolicyConflictResponseSchema,
  WorkspacePolicyPersistenceUnavailableResponseSchema,
]);

export type UpdateWorkspacePolicyRequest =
  typeof UpdateWorkspacePolicyRequestSchema.Type;
