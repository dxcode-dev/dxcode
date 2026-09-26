import {
  EnvironmentVariableAuditAction,
  EnvironmentVariableAuditId,
  EnvironmentVariableConfigReference,
  EnvironmentVariableId,
  EnvironmentVariableKind,
  EnvironmentVariableName,
  EnvironmentVariableScope,
  MASKED_SECRET_VALUE,
  PageCursor,
  ProjectId,
  UserId,
} from "@dx/domain";
import { Schema } from "effect";
import { PageLimitQuerySchema } from "../http/page-limit-query.js";
import { errorResponse, successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "./field-error.js";

export const EnvironmentVariablePrecedenceSchema = Schema.Tuple([
  Schema.Literal("personal"),
  Schema.Literal("project"),
  Schema.Literal("workspace"),
]);

export const EnvironmentVariableDataSchema = Schema.Struct({
  reference: EnvironmentVariableConfigReference,
  name: EnvironmentVariableName,
  kind: EnvironmentVariableKind,
  scope: EnvironmentVariableScope,
  projectId: Schema.optional(ProjectId),
  enabled: Schema.Boolean,
  source: EnvironmentVariableScope,
  value: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  rotatedAt: Schema.DateTimeUtcFromString,
}).check(
  Schema.makeFilter(
    (item) => item.kind === "variable" || item.value === MASKED_SECRET_VALUE,
  ),
);

export const ListEnvironmentVariablesResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(EnvironmentVariableDataSchema),
    precedence: EnvironmentVariablePrecedenceSchema,
  }),
);

export const EnvironmentVariableScopeRequestSchema = Schema.Struct({
  scope: Schema.String,
  projectId: Schema.optional(Schema.String),
});

export const CreateEnvironmentVariableRequestSchema = Schema.Struct({
  ...EnvironmentVariableScopeRequestSchema.fields,
  name: Schema.String,
  kind: Schema.String,
  value: Schema.String,
});

export const CreateEnvironmentVariableResponseSchema = successResponse(
  EnvironmentVariableDataSchema,
);

export const EnvironmentVariableParamsSchema = Schema.Struct({
  environmentVariableId: EnvironmentVariableId,
});

export const UpdateEnvironmentVariableRequestSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
});

export const UpdateEnvironmentVariableResponseSchema = successResponse(
  EnvironmentVariableDataSchema,
);

export const RotateEnvironmentVariableRequestSchema = Schema.Struct({
  value: Schema.String,
});

export const RotateEnvironmentVariableResponseSchema = successResponse(
  EnvironmentVariableDataSchema,
);

export const DeleteEnvironmentVariableResponseSchema = successResponse(
  Schema.Struct({ deletedEnvironmentVariableId: EnvironmentVariableId }),
);

export const BulkEnvironmentVariablesRequestSchema = Schema.Struct({
  ...EnvironmentVariableScopeRequestSchema.fields,
  kind: Schema.String,
  contents: Schema.String,
});

export const EnvironmentVariableHistoryQuerySchema = Schema.Struct({
  ...EnvironmentVariableScopeRequestSchema.fields,
  cursor: Schema.optional(PageCursor),
  limit: Schema.optional(PageLimitQuerySchema),
});

export const EnvironmentVariableAuditEventDataSchema = Schema.Struct({
  id: EnvironmentVariableAuditId,
  variableId: EnvironmentVariableId,
  name: EnvironmentVariableName,
  kind: EnvironmentVariableKind,
  action: EnvironmentVariableAuditAction,
  actorUserId: UserId,
  actorName: Schema.String,
  requestId: Schema.String,
  occurredAt: Schema.DateTimeUtcFromString,
});

export const ListEnvironmentVariableHistoryResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(EnvironmentVariableAuditEventDataSchema),
    nextCursor: Schema.optional(PageCursor),
  }),
);

export const BulkEnvironmentVariablePreviewItemSchema = Schema.Struct({
  line: Schema.Int,
  name: Schema.String,
  status: Schema.Literals(["ready", "conflict", "invalid"]),
  message: Schema.optional(Schema.String),
});

export const PreviewBulkEnvironmentVariablesResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(BulkEnvironmentVariablePreviewItemSchema),
    canApply: Schema.Boolean,
  }),
);

export const ApplyBulkEnvironmentVariablesRequestSchema = Schema.Struct({
  ...BulkEnvironmentVariablesRequestSchema.fields,
  conflictBehavior: Schema.Literals(["reject", "replace"]),
});

export const ApplyBulkEnvironmentVariablesResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(EnvironmentVariableDataSchema),
    conflictBehavior: Schema.Literals(["reject", "replace"]),
  }),
);

export const EnvironmentVariablesInvalidRequestResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("INVALID_ENVIRONMENT_VARIABLES_REQUEST"),
    message: Schema.Literal("Environment variable validation failed."),
    requestId: Schema.String,
    fieldErrors: Schema.Array(SettingsFieldErrorSchema),
  }),
});

export const EnvironmentVariablesForbiddenResponseSchema = errorResponse(
  "SETTINGS_SCOPE_FORBIDDEN",
  "The settings scope is unavailable for this user.",
);

export const EnvironmentVariablesBrowserSessionRequiredResponseSchema =
  errorResponse(
    "BROWSER_SESSION_REQUIRED",
    "A browser session is required to manage environment variables.",
  );

export const EnvironmentVariableNotFoundResponseSchema = errorResponse(
  "ENVIRONMENT_VARIABLE_NOT_FOUND",
  "Environment variable not found.",
);

export const EnvironmentVariableConflictResponseSchema = errorResponse(
  "ENVIRONMENT_VARIABLE_CONFLICT",
  "An environment variable with that name already exists in this scope.",
);

export const EnvironmentVariableLimitResponseSchema = errorResponse(
  "ENVIRONMENT_VARIABLE_LIMIT_EXCEEDED",
  "This scope has reached its environment variable limit.",
);

export const EnvironmentVariablesUnavailableResponseSchema = errorResponse(
  "ENVIRONMENT_VARIABLES_UNAVAILABLE",
  "Environment variables are temporarily unavailable.",
);

export const EnvironmentVariablesErrorResponseSchema = Schema.Union([
  EnvironmentVariablesInvalidRequestResponseSchema,
  EnvironmentVariablesForbiddenResponseSchema,
  EnvironmentVariablesBrowserSessionRequiredResponseSchema,
  EnvironmentVariableNotFoundResponseSchema,
  EnvironmentVariableConflictResponseSchema,
  EnvironmentVariableLimitResponseSchema,
  EnvironmentVariablesUnavailableResponseSchema,
]);

export type EnvironmentVariableData = typeof EnvironmentVariableDataSchema.Type;
export type EnvironmentVariableAuditEventData =
  typeof EnvironmentVariableAuditEventDataSchema.Type;
export type BulkEnvironmentVariablePreviewItem =
  typeof BulkEnvironmentVariablePreviewItemSchema.Type;
export type CreateEnvironmentVariableRequest =
  typeof CreateEnvironmentVariableRequestSchema.Type;

export { MASKED_SECRET_VALUE };
