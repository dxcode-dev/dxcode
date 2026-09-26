import {
  EnabledSourceControlProviderId,
  GitIntegrationProvider,
  IntegrationConnectionId,
  IntegrationConnectionStatus,
  IntegrationDisconnectImpact,
  IntegrationHealth,
  IntegrationRevocationStatus,
  ProviderRepositoryId,
  SourceControlCapability,
  WorkspacePolicyDenialReason,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "./field-error.js";

export const IntegrationProviderDataSchema = Schema.Struct({
  provider: EnabledSourceControlProviderId,
  kind: Schema.Literal("source-control"),
  displayName: Schema.String,
  availability: Schema.Literals(["available", "unavailable"]),
  unavailableReason: Schema.optional(
    Schema.Literal("deployment-not-configured"),
  ),
  capabilities: Schema.Array(SourceControlCapability),
});

export const IntegrationRepositoryDataSchema = Schema.Struct({
  id: ProviderRepositoryId,
  fullName: Schema.String,
  webUrl: Schema.String,
  visibility: Schema.Literals(["public", "private", "internal"]),
  selected: Schema.Boolean,
});

export const IntegrationConnectionDataSchema = Schema.Struct({
  id: IntegrationConnectionId,
  provider: GitIntegrationProvider,
  status: IntegrationConnectionStatus,
  health: IntegrationHealth,
  providerAccountLogin: Schema.String,
  grantedScopes: Schema.Array(Schema.String),
  expiresAt: Schema.optional(Schema.DateTimeUtcFromString),
  refreshExpiresAt: Schema.optional(Schema.DateTimeUtcFromString),
  lastHealthCheckAt: Schema.optional(Schema.DateTimeUtcFromString),
  revocationStatus: IntegrationRevocationStatus,
  repositories: Schema.Array(IntegrationRepositoryDataSchema),
});

export const ListPersonalIntegrationsResponseSchema = successResponse(
  Schema.Struct({
    providers: Schema.Array(IntegrationProviderDataSchema),
    connections: Schema.Array(IntegrationConnectionDataSchema),
  }),
);

export const IntegrationProviderParamsSchema = Schema.Struct({
  provider: GitIntegrationProvider,
});

export const IntegrationConnectionParamsSchema = Schema.Struct({
  connectionId: IntegrationConnectionId,
});

export const BeginIntegrationAuthorizationResponseSchema = successResponse(
  Schema.Struct({
    provider: GitIntegrationProvider,
    authorizationUrl: Schema.String,
    expiresAt: Schema.DateTimeUtcFromString,
  }),
);

export const SelectIntegrationRepositoriesRequestSchema = Schema.Struct({
  repositoryIds: Schema.Array(ProviderRepositoryId).check(
    Schema.isMaxLength(100),
  ),
});

export const SelectIntegrationRepositoriesResponseSchema = successResponse(
  Schema.Struct({
    repositories: Schema.Array(IntegrationRepositoryDataSchema),
  }),
);

export const GetIntegrationDisconnectImpactResponseSchema = successResponse(
  IntegrationDisconnectImpact,
);

export const DisconnectIntegrationResponseSchema = successResponse(
  Schema.Struct({
    disconnectedConnectionId: IntegrationConnectionId,
    localAccessStopped: Schema.Literal(true),
    providerRevocation: Schema.Literals(["completed", "pending"]),
    impact: IntegrationDisconnectImpact,
  }),
);

export const RefreshIntegrationResponseSchema = successResponse(
  IntegrationConnectionDataSchema,
);

export const CheckIntegrationHealthResponseSchema = successResponse(
  IntegrationConnectionDataSchema,
);

export const IntegrationsInvalidRequestResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("INVALID_INTEGRATIONS_REQUEST"),
    message: Schema.Literal("Integration request validation failed."),
    requestId: Schema.String,
    fieldErrors: Schema.Array(SettingsFieldErrorSchema),
  }),
});

export const IntegrationsForbiddenResponseSchema = errorResponse(
  "SETTINGS_SCOPE_FORBIDDEN",
  "The settings scope is unavailable for this user.",
);

export const IntegrationsPolicyDeniedResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("WORKSPACE_POLICY_DENIED"),
    message: Schema.Literal(
      "Workspace policy does not allow personal integration credentials.",
    ),
    requestId: Schema.String,
    reason: WorkspacePolicyDenialReason,
  }),
});

export const IntegrationsBrowserSessionRequiredResponseSchema = errorResponse(
  "BROWSER_SESSION_REQUIRED",
  "A browser session is required to manage integrations.",
);

export const IntegrationProviderUnavailableResponseSchema = errorResponse(
  "INTEGRATION_PROVIDER_UNAVAILABLE",
  "This integration provider is not safely configured.",
);

export const IntegrationConnectionNotFoundResponseSchema = errorResponse(
  "INTEGRATION_CONNECTION_NOT_FOUND",
  "Integration connection not found.",
);

export const IntegrationOAuthStateInvalidResponseSchema = errorResponse(
  "INTEGRATION_OAUTH_STATE_INVALID",
  "The integration authorization request is invalid or expired.",
);

export const IntegrationRepositoryForbiddenResponseSchema = errorResponse(
  "INTEGRATION_REPOSITORY_FORBIDDEN",
  "One or more repositories are not authorized by the provider.",
);

export const IntegrationsUnavailableResponseSchema = errorResponse(
  "INTEGRATIONS_UNAVAILABLE",
  "Integrations are temporarily unavailable.",
);

export const IntegrationsErrorResponseSchema = Schema.Union([
  IntegrationsInvalidRequestResponseSchema,
  IntegrationsForbiddenResponseSchema,
  IntegrationsPolicyDeniedResponseSchema,
  IntegrationsBrowserSessionRequiredResponseSchema,
  IntegrationProviderUnavailableResponseSchema,
  IntegrationConnectionNotFoundResponseSchema,
  IntegrationOAuthStateInvalidResponseSchema,
  IntegrationRepositoryForbiddenResponseSchema,
  IntegrationsUnavailableResponseSchema,
]);

export type IntegrationProviderData = typeof IntegrationProviderDataSchema.Type;
export type IntegrationConnectionData =
  typeof IntegrationConnectionDataSchema.Type;
export type IntegrationRepositoryData =
  typeof IntegrationRepositoryDataSchema.Type;
