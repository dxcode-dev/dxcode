import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

export const GitHubOwnerScopeSchema = Schema.Literal("personal");

export const GitHubGrantDataSchema = Schema.Struct({
  id: Schema.String,
  ownerScope: GitHubOwnerScopeSchema,
  ownerId: Schema.String,
  installationId: Schema.String,
  status: Schema.Literals([
    "active",
    "reauthorization-required",
    "disconnected",
  ]),
  installationStatus: Schema.Literals([
    "active",
    "suspended",
    "removed",
    "permissions-pending",
  ]),
  account: Schema.Struct({
    id: Schema.String,
    login: Schema.String,
    type: Schema.Literals(["user", "organization"]),
  }),
  repositorySelection: Schema.Literals(["all", "selected"]),
  repositories: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      fullName: Schema.String,
      webUrl: Schema.String,
      visibility: Schema.Literals(["public", "private", "internal"]),
    }),
  ),
});
export type GitHubGrantData = typeof GitHubGrantDataSchema.Type;

export const BeginGitHubCeremonyResponseSchema = successResponse(
  Schema.Struct({
    authorizationUrl: Schema.String,
    expiresAt: Schema.String,
  }),
);

export const BeginGitHubInstallationResponseSchema = successResponse(
  Schema.Struct({
    installationUrl: Schema.String,
    expiresAt: Schema.String,
  }),
);

export const ListGitHubGrantsResponseSchema = successResponse(
  Schema.Struct({
    configured: Schema.Boolean,
    grants: Schema.Array(GitHubGrantDataSchema),
  }),
);

export const GitHubGrantResponseSchema = successResponse(GitHubGrantDataSchema);

export const GitHubDisconnectResponseSchema = successResponse(
  Schema.Struct({
    grantId: Schema.String,
    localAccessStopped: Schema.Literal(true),
    installationUninstalled: Schema.Literal(true),
  }),
);

export const GitHubWebhookResponseSchema = successResponse(
  Schema.Struct({ duplicate: Schema.Boolean }),
);

export const GitHubControlPlaneInvalidResponseSchema = errorResponse(
  "GITHUB_CONTROL_PLANE_INVALID",
  "The GitHub control-plane request is invalid or expired.",
);
export const GitHubControlPlaneForbiddenResponseSchema = errorResponse(
  "GITHUB_CONTROL_PLANE_FORBIDDEN",
  "GitHub control-plane access is forbidden.",
);
export const GitHubControlPlaneUnavailableResponseSchema = errorResponse(
  "GITHUB_CONTROL_PLANE_UNAVAILABLE",
  "The GitHub control plane is temporarily unavailable.",
);
