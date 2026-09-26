import { Context, type Effect, type Option, type Schema } from "effect";
import type { PageCursor } from "../pagination/cursor.js";
import type { Page } from "../pagination/page.js";
import type {
  InvalidPageCursor,
  PersistenceUnavailable,
} from "../persistence/errors.js";
import type { UserId } from "../users/user-id.js";
import type {
  ExternalApiApplication,
  ExternalApiApplicationAuditEvent,
  ExternalApiApplicationAuditEventId,
  ExternalApiApplicationClientId,
  ExternalApiApplicationCredentialId,
  ExternalApiApplicationId,
  ExternalApiApplicationName,
  ExternalApiApplicationNotFound,
  ExternalApiApplicationRateLimit,
  ExternalApiApplicationScope,
  ExternalApiApplicationScopes,
  ExternalApiApplicationSecretHash,
  ExternalApiApplicationStatus,
} from "./external-api-application.js";
import type { WorkspaceId } from "./workspace.js";

type RepositoryError = PersistenceUnavailable | Schema.SchemaError;

export interface CreateExternalApiApplicationRecord {
  readonly id: ExternalApiApplicationId;
  readonly workspaceId: WorkspaceId;
  readonly ownerUserId: UserId;
  readonly clientId: ExternalApiApplicationClientId;
  readonly name: ExternalApiApplicationName;
  readonly scopes: ExternalApiApplicationScopes;
  readonly rateLimitPerMinute: ExternalApiApplicationRateLimit;
  readonly credentialId: ExternalApiApplicationCredentialId;
  readonly secretHash: ExternalApiApplicationSecretHash;
  readonly credentialIdentifier: string;
  readonly now: number;
}

export interface UpdateExternalApiApplicationRecord {
  readonly name: ExternalApiApplicationName;
  readonly scopes: ExternalApiApplicationScopes;
  readonly rateLimitPerMinute: ExternalApiApplicationRateLimit;
  readonly now: number;
}

export interface RotateExternalApiApplicationCredentialRecord {
  readonly credentialId: ExternalApiApplicationCredentialId;
  readonly secretHash: ExternalApiApplicationSecretHash;
  readonly credentialIdentifier: string;
  readonly now: number;
  readonly previousExpiresAt: number;
}

export interface AuthenticatedExternalApiApplication {
  readonly applicationId: ExternalApiApplicationId;
  readonly workspaceId: WorkspaceId;
  readonly ownerUserId: UserId;
  readonly clientId: ExternalApiApplicationClientId;
  readonly credentialId: ExternalApiApplicationCredentialId;
  readonly scopes: ReadonlyArray<ExternalApiApplicationScope>;
  readonly rateLimitPerMinute: ExternalApiApplicationRateLimit;
}

export interface ExternalApiApplicationAuditRecord {
  readonly id: ExternalApiApplicationAuditEventId;
  readonly applicationId: ExternalApiApplicationId;
  readonly workspaceId: WorkspaceId;
  readonly actorType: "user" | "application";
  readonly actorId: string;
  readonly action: string;
  readonly outcome: "success" | "rejected" | "authorized";
  readonly requestId: string;
  readonly credentialId?: ExternalApiApplicationCredentialId;
  readonly scope?: ExternalApiApplicationScope;
  readonly method?: string;
  readonly path?: string;
  readonly createdAt: number;
}

export interface ExternalApiApplicationRepositoryShape {
  readonly list: (
    workspaceId: WorkspaceId,
    input: { readonly limit: number; readonly cursor?: PageCursor },
  ) => Effect.Effect<
    Page<ExternalApiApplication>,
    RepositoryError | InvalidPageCursor
  >;
  readonly findById: (
    workspaceId: WorkspaceId,
    applicationId: ExternalApiApplicationId,
  ) => Effect.Effect<
    ExternalApiApplication,
    RepositoryError | ExternalApiApplicationNotFound
  >;
  readonly create: (
    record: CreateExternalApiApplicationRecord,
  ) => Effect.Effect<
    ExternalApiApplication,
    RepositoryError | ExternalApiApplicationNotFound
  >;
  readonly update: (
    workspaceId: WorkspaceId,
    applicationId: ExternalApiApplicationId,
    record: UpdateExternalApiApplicationRecord,
  ) => Effect.Effect<
    ExternalApiApplication,
    RepositoryError | ExternalApiApplicationNotFound
  >;
  readonly rotateCredential: (
    workspaceId: WorkspaceId,
    applicationId: ExternalApiApplicationId,
    record: RotateExternalApiApplicationCredentialRecord,
  ) => Effect.Effect<
    ExternalApiApplication,
    RepositoryError | ExternalApiApplicationNotFound
  >;
  readonly setStatus: (
    workspaceId: WorkspaceId,
    applicationId: ExternalApiApplicationId,
    status: ExternalApiApplicationStatus,
    now: number,
  ) => Effect.Effect<
    ExternalApiApplication,
    RepositoryError | ExternalApiApplicationNotFound
  >;
  readonly authenticate: (
    clientId: ExternalApiApplicationClientId,
    secretHash: ExternalApiApplicationSecretHash,
    now: number,
  ) => Effect.Effect<
    Option.Option<AuthenticatedExternalApiApplication>,
    RepositoryError
  >;
  readonly claimRateLimit: (
    applicationId: ExternalApiApplicationId,
    maximum: ExternalApiApplicationRateLimit,
    windowStartedAt: number,
  ) => Effect.Effect<boolean, PersistenceUnavailable>;
  readonly touchLastUsed: (
    applicationId: ExternalApiApplicationId,
    now: number,
  ) => Effect.Effect<void, PersistenceUnavailable>;
  readonly recordAudit: (
    record: ExternalApiApplicationAuditRecord,
  ) => Effect.Effect<void, PersistenceUnavailable>;
  readonly listAudit: (
    workspaceId: WorkspaceId,
    applicationId: ExternalApiApplicationId,
    input: { readonly limit: number; readonly cursor?: PageCursor },
  ) => Effect.Effect<
    Page<ExternalApiApplicationAuditEvent>,
    RepositoryError | InvalidPageCursor | ExternalApiApplicationNotFound
  >;
}

export class ExternalApiApplicationRepository extends Context.Service<
  ExternalApiApplicationRepository,
  ExternalApiApplicationRepositoryShape
>()("@dx/domain/settings/ExternalApiApplicationRepository") {}
