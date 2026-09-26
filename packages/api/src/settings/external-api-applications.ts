import {
  ExternalApiApplicationAuditEventId,
  ExternalApiApplicationClientId,
  ExternalApiApplicationClientSecret,
  ExternalApiApplicationCredentialId,
  ExternalApiApplicationId,
  ExternalApiApplicationName,
  ExternalApiApplicationRateLimit,
  ExternalApiApplicationRotationOverlapSeconds,
  ExternalApiApplicationScope,
  ExternalApiApplicationScopes,
  ExternalApiApplicationStatus,
  PageCursor,
  UserId,
  WorkspacePermission,
  WorkspaceShortName,
} from "@dx/domain";
import { Schema } from "effect";
import { PageLimitQuerySchema } from "../http/page-limit-query.js";
import { errorResponse, successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "./field-error.js";

export const ExternalApiApplicationOwnerDataSchema = Schema.Struct({
  userId: UserId,
  name: Schema.String,
  email: Schema.String,
  activeMember: Schema.Boolean,
});

export const ExternalApiApplicationCredentialDataSchema = Schema.Struct({
  id: ExternalApiApplicationCredentialId,
  identifier: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.optional(Schema.DateTimeUtcFromString),
});

export const ExternalApiApplicationDataSchema = Schema.Struct({
  id: ExternalApiApplicationId,
  clientId: ExternalApiApplicationClientId,
  name: ExternalApiApplicationName,
  owner: ExternalApiApplicationOwnerDataSchema,
  status: ExternalApiApplicationStatus,
  scopes: ExternalApiApplicationScopes,
  rateLimitPerMinute: ExternalApiApplicationRateLimit,
  credential: ExternalApiApplicationCredentialDataSchema,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  lastUsedAt: Schema.optional(Schema.DateTimeUtcFromString),
});

export const ExternalApiApplicationSecretDataSchema = Schema.Struct({
  application: ExternalApiApplicationDataSchema,
  clientSecret: ExternalApiApplicationClientSecret,
});

export const ExternalApiApplicationAuditEventDataSchema = Schema.Struct({
  id: ExternalApiApplicationAuditEventId,
  applicationId: ExternalApiApplicationId,
  actorType: Schema.Literals(["user", "application"]),
  actorId: Schema.String,
  action: Schema.String,
  outcome: Schema.Literals(["success", "rejected", "authorized"]),
  requestId: Schema.String,
  credentialId: Schema.optional(ExternalApiApplicationCredentialId),
  scope: Schema.optional(ExternalApiApplicationScope),
  method: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
});

export const ExternalApiApplicationsParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceShortName,
});

export const ExternalApiApplicationParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceShortName,
  applicationId: ExternalApiApplicationId,
});

export const ListExternalApiApplicationsQuerySchema = Schema.Struct({
  limit: Schema.optional(PageLimitQuerySchema),
  cursor: Schema.optional(PageCursor),
});

export const ListExternalApiApplicationsResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(ExternalApiApplicationDataSchema),
    nextCursor: Schema.optional(PageCursor),
    permissions: Schema.Array(WorkspacePermission),
  }),
);

export const CreateExternalApiApplicationRequestSchema = Schema.Struct({
  name: Schema.String,
  scopes: Schema.Array(Schema.String),
  rateLimitPerMinute: Schema.Number,
});

export const CreateExternalApiApplicationResponseSchema = successResponse(
  ExternalApiApplicationSecretDataSchema,
);

export const UpdateExternalApiApplicationRequestSchema = Schema.Struct({
  name: Schema.String,
  scopes: Schema.Array(Schema.String),
  rateLimitPerMinute: Schema.Number,
});

export const UpdateExternalApiApplicationResponseSchema = successResponse(
  ExternalApiApplicationDataSchema,
);

export const RotateExternalApiApplicationRequestSchema = Schema.Struct({
  overlapSeconds: ExternalApiApplicationRotationOverlapSeconds,
});

export const RotateExternalApiApplicationResponseSchema = successResponse(
  ExternalApiApplicationSecretDataSchema,
);

export const SetExternalApiApplicationStatusResponseSchema = successResponse(
  ExternalApiApplicationDataSchema,
);

export const RevokeExternalApiApplicationResponseSchema = successResponse(
  Schema.Struct({ revokedApplicationId: ExternalApiApplicationId }),
);

export const ListExternalApiApplicationAuditQuerySchema = Schema.Struct({
  limit: Schema.optional(PageLimitQuerySchema),
  cursor: Schema.optional(PageCursor),
});

export const ListExternalApiApplicationAuditResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(ExternalApiApplicationAuditEventDataSchema),
    nextCursor: Schema.optional(PageCursor),
  }),
);

export const ExternalApiApplicationsInvalidRequestResponseSchema =
  Schema.Struct({
    status: Schema.Literal("error"),
    data: Schema.Struct({
      code: Schema.Literal("INVALID_EXTERNAL_API_APPLICATION_REQUEST"),
      message: Schema.Literal(
        "External API application request validation failed.",
      ),
      requestId: Schema.String,
      fieldErrors: Schema.Array(SettingsFieldErrorSchema),
    }),
  });

export const ExternalApiApplicationUnsupportedScopeResponseSchema =
  errorResponse(
    "UNSUPPORTED_EXTERNAL_API_APPLICATION_SCOPE",
    "The requested scope is not supported for external applications.",
  );

export const ExternalApiApplicationsScopeForbiddenResponseSchema =
  errorResponse(
    "SETTINGS_SCOPE_FORBIDDEN",
    "The settings scope is unavailable for this user.",
  );

export const ExternalApiApplicationsPermissionForbiddenResponseSchema =
  errorResponse(
    "WORKSPACE_PERMISSION_FORBIDDEN",
    "This workspace action is not permitted.",
  );

export const ExternalApiApplicationNotFoundResponseSchema = errorResponse(
  "EXTERNAL_API_APPLICATION_NOT_FOUND",
  "External API application not found.",
);

export const ExternalApiApplicationRateLimitedResponseSchema = errorResponse(
  "RATE_LIMITED",
  "The application rate limit has been exceeded.",
);

export const ExternalApiApplicationsPersistenceUnavailableResponseSchema =
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "External API applications are temporarily unavailable.",
  );

export const ExternalApiApplicationsErrorResponseSchema = Schema.Union([
  ExternalApiApplicationsInvalidRequestResponseSchema,
  ExternalApiApplicationUnsupportedScopeResponseSchema,
  ExternalApiApplicationsScopeForbiddenResponseSchema,
  ExternalApiApplicationsPermissionForbiddenResponseSchema,
  ExternalApiApplicationNotFoundResponseSchema,
  ExternalApiApplicationsPersistenceUnavailableResponseSchema,
]);

export type ExternalApiApplicationData =
  typeof ExternalApiApplicationDataSchema.Type;
export type ExternalApiApplicationSecretData =
  typeof ExternalApiApplicationSecretDataSchema.Type;
export type ExternalApiApplicationAuditEventData =
  typeof ExternalApiApplicationAuditEventDataSchema.Type;
export type CreateExternalApiApplicationRequest =
  typeof CreateExternalApiApplicationRequestSchema.Type;
export type UpdateExternalApiApplicationRequest =
  typeof UpdateExternalApiApplicationRequestSchema.Type;
