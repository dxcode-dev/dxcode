import { Context, type Effect, Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import { Timestamp } from "../persistence/timestamp.js";
import { ProjectId } from "../projects/project-id.js";
import { WorkspaceId } from "../settings/workspace.js";
import { ThreadId } from "../threads/thread-id.js";
import { UserId } from "../users/user-id.js";

export const SOURCE_CONTROL_CONTRACT_VERSION = 1 as const;

export const SourceControlProviderId = Schema.Literals([
  "github",
  "bitbucket",
  "gitlab",
  "forgejo",
]);
export type SourceControlProviderId = typeof SourceControlProviderId.Type;

export const EnabledSourceControlProviderId = Schema.Literals([
  "github",
  "bitbucket",
]);
export type EnabledSourceControlProviderId =
  typeof EnabledSourceControlProviderId.Type;

export const SourceControlCapability = Schema.Literals([
  "personal-grant",
  "workspace-installation",
  "repository-discovery",
  "repository-selection",
  "runtime-read",
  "runtime-write",
  "provider-cli",
  "lifecycle-webhooks",
]);
export type SourceControlCapability = typeof SourceControlCapability.Type;

export const SourceOperation = Schema.Literals([
  "checkout",
  "fetch",
  "provider-auth-read",
  "repository-read",
  "contents-push",
  "pull-request-read",
  "pull-request-write",
  "issue-read",
  "issue-write",
  "actions-read",
  "actions-write",
  "workflow-write",
  "checks-status-read",
]);
export type SourceOperation = typeof SourceOperation.Type;

export const SourceOperationInvocationSource = Schema.Literals([
  "checkout",
  "agent-command",
  "git-helper",
  "setup-hook",
  "resume-hook",
  "system",
]);
export type SourceOperationInvocationSource =
  typeof SourceOperationInvocationSource.Type;

export const SourceOperationRequest = Schema.Struct({
  operation: SourceOperation,
  targetBranch: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  invocationSource: SourceOperationInvocationSource,
});
export type SourceOperationRequest = typeof SourceOperationRequest.Type;

export const SourceControlGrantId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/SourceControlGrantId"));
export type SourceControlGrantId = typeof SourceControlGrantId.Type;

export const SourceControlGrantOwner = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("personal"), id: UserId }),
  Schema.Struct({ scope: Schema.Literal("workspace"), id: WorkspaceId }),
]);
export type SourceControlGrantOwner = typeof SourceControlGrantOwner.Type;

export const SourceControlGrantIdentity = Schema.Struct({
  id: SourceControlGrantId,
  provider: SourceControlProviderId,
  owner: SourceControlGrantOwner,
  authorizationKind: Schema.Literals(["user-oauth", "app-installation"]),
  providerAccountId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
  installationId: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
});
export type SourceControlGrantIdentity = typeof SourceControlGrantIdentity.Type;

export const SourceControlHealthState = Schema.Literals([
  "available",
  "action-required",
  "unavailable",
  "unknown",
]);
export type SourceControlHealthState = typeof SourceControlHealthState.Type;

export const SourceControlHealthReason = Schema.Literals([
  "connection-reauthorization-required",
  "grant-missing",
  "installation-suspended",
  "installation-permissions-changed",
  "grant-disconnected",
  "installation-removed",
  "repository-access-removed",
  "repository-not-selected",
  "stale-authorization-epoch",
  "stale-binding",
  "stale-snapshot",
  "provider-disabled",
  "personal-grant-not-allowed-for-workspace",
  "provider-unreachable",
  "source-not-found",
  "unsupported-provider",
  "unsupported-capability",
  "policy-denied",
  "default-branch-write-denied",
  "provider-permission-denied",
  "provider-rate-limited",
  "invalid-ref",
]);
export type SourceControlHealthReason = typeof SourceControlHealthReason.Type;

export const SourceControlHealth = Schema.Struct({
  state: SourceControlHealthState,
  reason: Schema.optional(SourceControlHealthReason),
  lastCheckedAt: Schema.optional(Timestamp),
});
export type SourceControlHealth = typeof SourceControlHealth.Type;

export const ProjectSourceAuthority = Schema.Struct({
  provider: SourceControlProviderId,
  ownerScope: Schema.Literals(["personal", "workspace"]),
  ownerId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  grantId: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  ),
  installationId: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  providerWorkspaceId: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  providerRepositoryId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
  bindingRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  provenance: Schema.Literals(["live-grant", "legacy"]),
  defaultBranch: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  health: Schema.Struct({
    state: SourceControlHealthState,
    reason: Schema.optional(SourceControlHealthReason),
  }),
  authorizationEpoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  installationEpoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  policyRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ProjectSourceAuthority = typeof ProjectSourceAuthority.Type;

const ThreadSourceProviderId = Schema.Literals(["git", "github", "bitbucket"]);

export const ThreadSourceSnapshot = Schema.Struct({
  version: Schema.Literal(2),
  threadId: ThreadId,
  projectId: ProjectId,
  bindingRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  provider: ThreadSourceProviderId,
  repositoryName: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(512),
  ),
  cloneUrl: Schema.String,
  defaultBranch: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
  sourceRevision: Schema.String.check(
    Schema.isMinLength(40),
    Schema.isMaxLength(40),
    Schema.isPattern(/^[a-f0-9]{40}$/),
  ),
  initialRef: Schema.String,
  capturedAt: Timestamp,
});
export type ThreadSourceSnapshot = typeof ThreadSourceSnapshot.Type;

export const ThreadSourceIntent = Schema.Struct({
  version: Schema.Literal(1),
  threadId: ThreadId,
  projectId: ProjectId,
  bindingRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  provider: ThreadSourceProviderId,
  repositoryName: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(512),
  ),
  cloneUrl: Schema.String,
  createdAt: Timestamp,
});
export type ThreadSourceIntent = typeof ThreadSourceIntent.Type;

export const ThreadSourceAuthority = Schema.Struct({
  threadId: ThreadId,
  grantId: SourceControlGrantId,
  installationId: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  providerWorkspaceId: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  providerRepositoryId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
  authorizationEpoch: Schema.Int.check(Schema.isGreaterThan(0)),
  installationEpoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  policyRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  privateSubmoduleRepositoryIds: Schema.Array(Schema.String).check(
    Schema.isMaxLength(16),
  ),
});
export type ThreadSourceAuthority = typeof ThreadSourceAuthority.Type;

export type ThreadSourceAdmission =
  | {
      readonly kind: "finalized";
      readonly snapshot: ThreadSourceSnapshot;
      readonly authority: ThreadSourceAuthority;
    }
  | { readonly kind: "pending"; readonly intent: ThreadSourceIntent };

export interface SourceSubmoduleRepository {
  readonly providerRepositoryId: string;
  readonly repositoryName: string;
}

export interface SourceWorkspaceRecord {
  readonly actorUserId: string;
  readonly snapshot?: ThreadSourceSnapshot;
  readonly intent?: ThreadSourceIntent;
  readonly authority?: ThreadSourceAuthority;
  readonly privateSubmodules: ReadonlyArray<SourceSubmoduleRepository>;
}

export interface AnonymousSourceFinalization {
  readonly sourceRevision: string;
  readonly defaultBranch: string;
  readonly initialRef: string;
  readonly capturedAt: typeof Timestamp.Type;
}

export interface SourceWorkspaceRepositoryShape {
  readonly findByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<SourceWorkspaceRecord, PersistenceUnavailable>;
  readonly finalizeAnonymous: (
    intent: ThreadSourceIntent,
    finalization: AnonymousSourceFinalization,
  ) => Effect.Effect<
    ThreadSourceSnapshot,
    Schema.SchemaError | PersistenceUnavailable
  >;
}

export class SourceWorkspaceRepository extends Context.Service<
  SourceWorkspaceRepository,
  SourceWorkspaceRepositoryShape
>()("@dx/domain/source-control/SourceWorkspaceRepository") {}

export const SourceControlAuditMetadata = Schema.Struct({
  actorUserId: UserId,
  requestId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
  occurredAt: Timestamp,
  operation: Schema.Literals([
    "grant-connect",
    "grant-disconnect",
    "repository-bind",
    "source-admit",
    "runtime-lease",
    "provider-reconcile",
  ]),
});
export type SourceControlAuditMetadata = typeof SourceControlAuditMetadata.Type;

export const SourceControlAdapterDescriptor = Schema.Struct({
  contractVersion: Schema.Literal(SOURCE_CONTROL_CONTRACT_VERSION),
  provider: SourceControlProviderId,
  availability: Schema.Literals(["enabled", "unavailable"]),
  displayName: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
  capabilities: Schema.Array(SourceControlCapability),
});
export type SourceControlAdapterDescriptor =
  typeof SourceControlAdapterDescriptor.Type;

export class SourceControlProviderUnavailable extends Schema.TaggedError<SourceControlProviderUnavailable>()(
  "SourceControlProviderUnavailable",
  {
    provider: SourceControlProviderId,
    reason: Schema.Literals([
      "provider-disabled",
      "deployment-not-configured",
      "adapter-version-mismatch",
    ]),
  },
) {}

export class SourceControlAccessDenied extends Schema.TaggedError<SourceControlAccessDenied>()(
  "SourceControlAccessDenied",
  {
    reason: SourceControlHealthReason,
    action: Schema.Literals([
      "reconnect",
      "reconfigure",
      "rebind",
      "contact-workspace-admin",
      "retry",
    ]),
  },
) {}

export class SourceControlProviderFailure extends Schema.TaggedError<SourceControlProviderFailure>()(
  "SourceControlProviderFailure",
  {
    provider: SourceControlProviderId,
    retryable: Schema.Boolean,
  },
) {}

export class SourceControlLeaseFailure extends Schema.TaggedError<SourceControlLeaseFailure>()(
  "SourceControlLeaseFailure",
  {
    reason: Schema.Literals([
      "credential-expiry-invalid",
      "provider-authority-changed",
      "token-revoke-failed",
      "audit-unavailable",
    ]),
    retryable: Schema.Boolean,
  },
) {}

export const SourceControlFailure = Schema.Union([
  SourceControlProviderUnavailable,
  SourceControlAccessDenied,
  SourceControlProviderFailure,
  SourceControlLeaseFailure,
]);
export type SourceControlFailure = typeof SourceControlFailure.Type;
