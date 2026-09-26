import { Schema } from "effect";
import { Timestamp } from "../persistence/timestamp.js";
import { UserId } from "../users/user-id.js";
import { IntegrationCredentialConfigReference } from "./environment-variable.js";
import { WorkspaceId } from "./workspace.js";

export const GitIntegrationProvider = Schema.Literals([
  "github",
  "gitlab",
  "forgejo",
]);

export type GitIntegrationProvider = typeof GitIntegrationProvider.Type;

export const CollaborationIntegrationProvider = Schema.Literals([
  "slack",
  "mattermost",
  "teams",
]);

export type CollaborationIntegrationProvider =
  typeof CollaborationIntegrationProvider.Type;

export const IntegrationProvider = Schema.Union([
  GitIntegrationProvider,
  CollaborationIntegrationProvider,
]);

export type IntegrationProvider = typeof IntegrationProvider.Type;

export const IntegrationConnectionId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/IntegrationConnectionId"));

export type IntegrationConnectionId = typeof IntegrationConnectionId.Type;

export const IntegrationOAuthTransactionId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/IntegrationOAuthTransactionId"));

export type IntegrationOAuthTransactionId =
  typeof IntegrationOAuthTransactionId.Type;

export const ProviderRepositoryId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
).pipe(Schema.brand("@dx/ProviderRepositoryId"));

export type ProviderRepositoryId = typeof ProviderRepositoryId.Type;

export const IntegrationOwner = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("personal"), id: UserId }),
  Schema.Struct({ scope: Schema.Literal("workspace"), id: WorkspaceId }),
]);

export type IntegrationOwner = typeof IntegrationOwner.Type;

export const IntegrationConnectionStatus = Schema.Literals([
  "connected",
  "needs-reauthorization",
  "disconnected",
]);

export type IntegrationConnectionStatus =
  typeof IntegrationConnectionStatus.Type;

export const IntegrationHealth = Schema.Literals([
  "healthy",
  "expired",
  "degraded",
  "revoked",
]);

export type IntegrationHealth = typeof IntegrationHealth.Type;

export const IntegrationRevocationStatus = Schema.Literals([
  "not-requested",
  "pending",
  "completed",
]);

export type IntegrationRevocationStatus =
  typeof IntegrationRevocationStatus.Type;

export const IntegrationConnection = Schema.Struct({
  id: IntegrationConnectionId,
  owner: IntegrationOwner,
  provider: GitIntegrationProvider,
  status: IntegrationConnectionStatus,
  health: IntegrationHealth,
  providerAccountId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
  providerAccountLogin: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
  grantedScopes: Schema.Array(Schema.String),
  accessTokenReference: Schema.optional(IntegrationCredentialConfigReference),
  refreshTokenReference: Schema.optional(IntegrationCredentialConfigReference),
  expiresAt: Schema.optional(Timestamp),
  refreshExpiresAt: Schema.optional(Timestamp),
  lastHealthCheckAt: Schema.optional(Timestamp),
  revokedAt: Schema.optional(Timestamp),
  revocationStatus: IntegrationRevocationStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}).check(
  Schema.makeFilter(
    (value) =>
      value.accessTokenReference === undefined ||
      value.accessTokenReference.kind === "integration-credential",
  ),
  Schema.makeFilter(
    (value) =>
      value.refreshTokenReference === undefined ||
      value.refreshTokenReference.kind === "integration-credential",
  ),
);

export type IntegrationConnection = typeof IntegrationConnection.Type;

export const IntegrationRepository = Schema.Struct({
  connectionId: IntegrationConnectionId,
  providerRepositoryId: ProviderRepositoryId,
  fullName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  webUrl: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  cloneUrl: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2048),
  ),
  visibility: Schema.Literals(["public", "private", "internal"]),
  selected: Schema.Boolean,
  lastAuthorizedAt: Timestamp,
});

export type IntegrationRepository = typeof IntegrationRepository.Type;

export const IntegrationResourceKind = Schema.Literals([
  "project",
  "job",
  "preview",
]);

export type IntegrationResourceKind = typeof IntegrationResourceKind.Type;

export const IntegrationDisconnectImpact = Schema.Struct({
  projects: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  jobs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  previews: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type IntegrationDisconnectImpact =
  typeof IntegrationDisconnectImpact.Type;

export const CollaborationEvent = Schema.Literals([
  "job.completed",
  "job.failed",
  "preview.shared",
]);

export type CollaborationEvent = typeof CollaborationEvent.Type;

export const CollaborationDestination = Schema.Struct({
  provider: CollaborationIntegrationProvider,
  externalId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
  displayName: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
});

export type CollaborationDestination = typeof CollaborationDestination.Type;

export const CollaborationDelivery = Schema.Struct({
  workspaceId: WorkspaceId,
  event: CollaborationEvent,
  destination: CollaborationDestination,
  audit: Schema.Struct({
    actorUserId: UserId,
    requestId: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(128),
    ),
    resourceId: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(256),
    ),
  }),
  preview: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000))),
});

export type CollaborationDelivery = typeof CollaborationDelivery.Type;
