import { Context, type Effect, Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import type { UserId } from "../users/user-id.js";
import type { IntegrationCredentialConfigReference } from "./environment-variable.js";
import type {
  GitIntegrationProvider,
  IntegrationConnection,
  IntegrationConnectionId,
  IntegrationDisconnectImpact,
  IntegrationOAuthTransactionId,
  IntegrationOwner,
  IntegrationRepository,
  ProviderRepositoryId,
} from "./integration.js";

export class IntegrationConnectionNotFound extends Schema.TaggedError<IntegrationConnectionNotFound>()(
  "IntegrationConnectionNotFound",
  {},
) {}

export class IntegrationOAuthStateInvalid extends Schema.TaggedError<IntegrationOAuthStateInvalid>()(
  "IntegrationOAuthStateInvalid",
  {},
) {}

export interface StoredIntegrationOAuthTransaction {
  readonly id: IntegrationOAuthTransactionId;
  readonly stateHash: string;
  readonly userId: UserId;
  readonly browserSessionId: string;
  readonly provider: GitIntegrationProvider;
  readonly verifierReference: IntegrationCredentialConfigReference;
  readonly callbackUrl: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface IntegrationRepositoryShape {
  readonly listConnections: (
    owner: IntegrationOwner,
  ) => Effect.Effect<ReadonlyArray<IntegrationConnection>, unknown>;
  readonly findConnection: (
    owner: IntegrationOwner,
    id: IntegrationConnectionId,
  ) => Effect.Effect<IntegrationConnection, unknown>;
  readonly findConnectionByProvider: (
    owner: IntegrationOwner,
    provider: GitIntegrationProvider,
  ) => Effect.Effect<IntegrationConnection | undefined, unknown>;
  readonly saveConnection: (
    connection: IntegrationConnection,
    repositories: ReadonlyArray<IntegrationRepository>,
    previousConnection?: IntegrationConnection,
  ) => Effect.Effect<boolean, unknown>;
  readonly replaceConnection: (
    connection: IntegrationConnection,
  ) => Effect.Effect<void, unknown>;
  readonly listRepositories: (
    connectionId: IntegrationConnectionId,
  ) => Effect.Effect<ReadonlyArray<IntegrationRepository>, unknown>;
  readonly replaceRepositories: (
    connectionId: IntegrationConnectionId,
    repositories: ReadonlyArray<IntegrationRepository>,
  ) => Effect.Effect<void, unknown>;
  readonly selectRepositories: (
    connectionId: IntegrationConnectionId,
    ids: ReadonlyArray<ProviderRepositoryId>,
  ) => Effect.Effect<void, unknown>;
  readonly disconnectImpact: (
    connectionId: IntegrationConnectionId,
  ) => Effect.Effect<IntegrationDisconnectImpact, unknown>;
  readonly insertOAuthTransaction: (
    transaction: StoredIntegrationOAuthTransaction,
  ) => Effect.Effect<void, unknown>;
  readonly consumeOAuthTransaction: (
    stateHash: string,
    userId: UserId,
    browserSessionId: string,
    now: string,
  ) => Effect.Effect<StoredIntegrationOAuthTransaction, unknown>;
  readonly removeOAuthTransaction: (
    id: IntegrationOAuthTransactionId,
  ) => Effect.Effect<void, unknown>;
  readonly workspaceCoverage: (workspaceId: string) => Effect.Effect<
    ReadonlyArray<{
      readonly provider: GitIntegrationProvider;
      readonly connectedMembers: number;
      readonly totalMembers: number;
    }>,
    PersistenceUnavailable
  >;
}

export class IntegrationRepositoryStore extends Context.Service<
  IntegrationRepositoryStore,
  IntegrationRepositoryShape
>()("@dx/domain/settings/IntegrationRepositoryStore") {}
