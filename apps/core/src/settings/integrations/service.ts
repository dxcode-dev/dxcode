import {
  IntegrationConnection,
  IntegrationConnectionId,
  IntegrationOAuthStateInvalid,
  IntegrationOAuthTransactionId,
  IntegrationRepository,
  IntegrationRepositoryStore,
  type GitIntegrationProvider,
  type IntegrationDisconnectImpact,
  type IntegrationOwner,
  type ProviderRepositoryId,
  Timestamp,
  type UserId,
} from "@dx/domain";
import { Context, Effect, Layer, Result, Schema } from "effect";
import { SettingsAudit } from "../audit.js";
import type { ConfigEncryptionKeyring } from "../environment-variables/encryption.js";
import { WorkspacePolicyService } from "../workspace-policy/service.js";
import { IntegrationCredentialVault } from "./credential-vault.js";
import {
  createOAuthProof,
  hashOAuthState,
  IntegrationProviderRequestFailed,
  IntegrationRepositoryForbidden,
  oauthTransactionExpiresAt,
  type GitProviderClient,
  type ProviderRepository,
  type ProviderTokenSet,
} from "./provider-registry.js";

interface ConnectionView {
  readonly connection: typeof IntegrationConnection.Type;
  readonly repositories: ReadonlyArray<typeof IntegrationRepository.Type>;
}

interface IntegrationAuditContext {
  readonly userId: UserId;
  readonly requestId: string;
}

interface IntegrationServiceShape {
  readonly list: (
    owner: IntegrationOwner,
  ) => Effect.Effect<ReadonlyArray<ConnectionView>, unknown>;
  readonly beginAuthorization: (
    keyring: ConfigEncryptionKeyring,
    owner: IntegrationOwner,
    browserSessionId: string,
    client: GitProviderClient,
  ) => Effect.Effect<
    {
      readonly authorizationUrl: string;
      readonly expiresAt: typeof Timestamp.Type;
    },
    unknown
  >;
  readonly completeAuthorization: (
    keyring: ConfigEncryptionKeyring,
    owner: IntegrationOwner,
    browserSessionId: string,
    expectedProvider: GitIntegrationProvider,
    state: string,
    code: string,
    client: GitProviderClient,
    audit: IntegrationAuditContext,
  ) => Effect.Effect<typeof IntegrationConnection.Type, unknown>;
  readonly selectRepositories: (
    keyring: ConfigEncryptionKeyring,
    owner: IntegrationOwner,
    connectionId: typeof IntegrationConnectionId.Type,
    repositoryIds: ReadonlyArray<ProviderRepositoryId>,
    client: GitProviderClient,
    audit: IntegrationAuditContext,
  ) => Effect.Effect<ReadonlyArray<typeof IntegrationRepository.Type>, unknown>;
  readonly refresh: (
    keyring: ConfigEncryptionKeyring,
    owner: IntegrationOwner,
    connectionId: typeof IntegrationConnectionId.Type,
    client: GitProviderClient,
    audit: IntegrationAuditContext,
  ) => Effect.Effect<ConnectionView, unknown>;
  readonly checkHealth: (
    keyring: ConfigEncryptionKeyring,
    owner: IntegrationOwner,
    connectionId: typeof IntegrationConnectionId.Type,
    client: GitProviderClient,
    audit: IntegrationAuditContext,
  ) => Effect.Effect<ConnectionView, unknown>;
  readonly disconnectImpact: (
    owner: IntegrationOwner,
    connectionId: typeof IntegrationConnectionId.Type,
  ) => Effect.Effect<IntegrationDisconnectImpact, unknown>;
  readonly disconnect: (
    keyring: ConfigEncryptionKeyring,
    owner: IntegrationOwner,
    connectionId: typeof IntegrationConnectionId.Type,
    client: GitProviderClient | undefined,
    audit: IntegrationAuditContext,
  ) => Effect.Effect<
    {
      readonly impact: IntegrationDisconnectImpact;
      readonly providerRevocation: "completed" | "pending";
    },
    unknown
  >;
  readonly authorizeRepository: (
    keyring: ConfigEncryptionKeyring,
    owner: IntegrationOwner,
    connectionId: typeof IntegrationConnectionId.Type,
    repositoryId: ProviderRepositoryId,
    client: GitProviderClient,
  ) => Effect.Effect<void, unknown>;
}

const providerCall = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      cause instanceof IntegrationProviderRequestFailed
        ? cause
        : new IntegrationProviderRequestFailed(),
  });

const repositoryRecord = (
  connectionId: typeof IntegrationConnectionId.Type,
  repository: ProviderRepository,
  selected: boolean,
  now: string,
) =>
  Schema.decodeUnknownEffect(IntegrationRepository)({
    connectionId,
    providerRepositoryId: repository.id,
    fullName: repository.fullName,
    webUrl: repository.webUrl,
    cloneUrl: repository.cloneUrl,
    visibility: repository.visibility,
    selected,
    lastAuthorizedAt: now,
  });

export class IntegrationService extends Context.Service<
  IntegrationService,
  IntegrationServiceShape
>()("@dx/core/settings/integrations/IntegrationService") {
  static readonly layer = Layer.effect(
    IntegrationService,
    Effect.gen(function* () {
      const repository = yield* IntegrationRepositoryStore;
      const vault = yield* IntegrationCredentialVault;
      const auditLog = yield* SettingsAudit;
      const workspacePolicies = yield* WorkspacePolicyService;

      const enforcePersonalOverride = Effect.fn(
        "IntegrationService.enforcePersonalOverride",
      )(function* (owner: IntegrationOwner) {
        if (owner.scope === "workspace") return;
        yield* workspacePolicies.evaluateForUser(owner.id, {
          kind: "secret.use-personal-override",
        });
      });

      const recordAudit = (
        action: string,
        owner: IntegrationOwner,
        provider: GitIntegrationProvider,
        connectionId: string | undefined,
        audit: IntegrationAuditContext,
      ) =>
        auditLog.record({
          action,
          scope: owner.scope,
          outcome: "success",
          requestId: audit.requestId,
          userId: audit.userId,
          integrationProvider: provider,
          ...(connectionId === undefined
            ? {}
            : { integrationConnectionId: connectionId }),
        });

      const connectionView = Effect.fn("IntegrationService.connectionView")(
        function* (connection: typeof IntegrationConnection.Type) {
          return {
            connection,
            repositories: yield* repository.listRepositories(connection.id),
          };
        },
      );

      const accessToken = Effect.fn("IntegrationService.accessToken")(
        function* (
          keyring: ConfigEncryptionKeyring,
          connection: typeof IntegrationConnection.Type,
        ) {
          if (
            connection.status !== "connected" ||
            connection.accessTokenReference === undefined
          ) {
            return yield* new IntegrationRepositoryForbidden();
          }
          return yield* vault.read(
            keyring,
            connection.owner,
            "access-token",
            connection.accessTokenReference,
          );
        },
      );

      const tokensForRevocation = Effect.fn(
        "IntegrationService.tokensForRevocation",
      )(function* (
        keyring: ConfigEncryptionKeyring,
        connection: typeof IntegrationConnection.Type,
      ) {
        if (connection.accessTokenReference === undefined) return undefined;
        const accessToken = yield* vault.read(
          keyring,
          connection.owner,
          "access-token",
          connection.accessTokenReference,
        );
        const refreshToken =
          connection.refreshTokenReference === undefined
            ? undefined
            : yield* vault.read(
                keyring,
                connection.owner,
                "refresh-token",
                connection.refreshTokenReference,
              );
        return {
          accessToken,
          ...(refreshToken === undefined ? {} : { refreshToken }),
        };
      });

      const storeTokenSet = Effect.fn("IntegrationService.storeTokenSet")(
        function* (
          keyring: ConfigEncryptionKeyring,
          owner: IntegrationOwner,
          tokens: ProviderTokenSet,
        ) {
          const accessTokenReference = yield* vault.put(
            keyring,
            owner,
            "access-token",
            tokens.accessToken,
          );
          const refreshResult =
            tokens.refreshToken === undefined
              ? Result.succeed(undefined)
              : yield* Effect.result(
                  vault.put(
                    keyring,
                    owner,
                    "refresh-token",
                    tokens.refreshToken,
                  ),
                );
          if (Result.isFailure(refreshResult)) {
            yield* Effect.ignore(vault.remove(owner, accessTokenReference));
            return yield* Effect.fail(refreshResult.failure);
          }
          return {
            accessTokenReference,
            ...(refreshResult.success === undefined
              ? {}
              : { refreshTokenReference: refreshResult.success }),
          };
        },
      );

      const removeCredentials = Effect.fn(
        "IntegrationService.removeCredentials",
      )(function* (connection: typeof IntegrationConnection.Type) {
        if (connection.accessTokenReference !== undefined) {
          yield* Effect.ignore(
            vault.remove(connection.owner, connection.accessTokenReference),
          );
        }
        if (connection.refreshTokenReference !== undefined) {
          yield* Effect.ignore(
            vault.remove(connection.owner, connection.refreshTokenReference),
          );
        }
      });

      const refreshConnection = Effect.fn(
        "IntegrationService.refreshConnection",
      )(function* (
        keyring: ConfigEncryptionKeyring,
        connection: typeof IntegrationConnection.Type,
        client: GitProviderClient,
      ) {
        if (
          connection.status !== "connected" ||
          connection.refreshTokenReference === undefined
        ) {
          return yield* new IntegrationProviderRequestFailed();
        }
        const refreshToken = yield* vault.read(
          keyring,
          connection.owner,
          "refresh-token",
          connection.refreshTokenReference,
        );
        const tokens = yield* providerCall(() => client.refresh(refreshToken));
        const identity = yield* providerCall(() =>
          client.identity(tokens.accessToken),
        );
        const available = yield* providerCall(() =>
          client.repositories(tokens.accessToken),
        );
        const references = yield* storeTokenSet(
          keyring,
          connection.owner,
          tokens,
        );
        const now = new Date().toISOString();
        const selected = new Set(
          (yield* repository.listRepositories(connection.id))
            .filter((item) => item.selected)
            .map((item) => item.providerRepositoryId),
        );
        const updated = yield* Schema.decodeUnknownEffect(
          IntegrationConnection,
        )({
          ...Schema.encodeSync(IntegrationConnection)(connection),
          providerAccountId: identity.id,
          providerAccountLogin: identity.login,
          grantedScopes: tokens.grantedScopes,
          ...references,
          expiresAt: tokens.expiresAt,
          refreshExpiresAt: tokens.refreshExpiresAt,
          health: "healthy",
          lastHealthCheckAt: now,
          updatedAt: now,
        });
        const nextRepositories = yield* Effect.all(
          available.map((item) =>
            repositoryRecord(connection.id, item, selected.has(item.id), now),
          ),
        );
        const written = yield* Effect.result(
          Effect.gen(function* () {
            const saved = yield* repository.saveConnection(
              updated,
              nextRepositories,
              connection,
            );
            if (!saved) return yield* new IntegrationRepositoryForbidden();
          }),
        );
        if (Result.isFailure(written)) {
          yield* removeCredentials({ ...connection, ...references });
          return yield* Effect.fail(written.failure);
        }
        yield* removeCredentials(connection);
        return { connection: updated, repositories: nextRepositories };
      });

      return IntegrationService.of({
        list: Effect.fn("IntegrationService.list")(function* (owner) {
          const connections = yield* repository.listConnections(owner);
          return yield* Effect.all(connections.map(connectionView));
        }),
        beginAuthorization: Effect.fn("IntegrationService.beginAuthorization")(
          function* (keyring, owner, browserSessionId, client) {
            if (owner.scope !== "personal") {
              return yield* new IntegrationOAuthStateInvalid();
            }
            yield* enforcePersonalOverride(owner);
            const proof = yield* Effect.promise(() => createOAuthProof());
            const stateHash = yield* Effect.promise(() =>
              hashOAuthState(proof.state),
            );
            const verifierReference = yield* vault.put(
              keyring,
              owner,
              "pkce-verifier",
              proof.codeVerifier,
            );
            const now = new Date();
            const id = yield* Schema.decodeUnknownEffect(
              IntegrationOAuthTransactionId,
            )(`iot_${crypto.randomUUID()}`);
            const expiresAt = oauthTransactionExpiresAt(now);
            const inserted = yield* Effect.result(
              repository.insertOAuthTransaction({
                id,
                stateHash,
                userId: owner.id,
                browserSessionId,
                provider: client.provider,
                verifierReference,
                callbackUrl: client.callbackUrl,
                expiresAt,
                createdAt: now.toISOString(),
              }),
            );
            if (Result.isFailure(inserted)) {
              yield* Effect.ignore(vault.remove(owner, verifierReference));
              return yield* Effect.fail(inserted.failure);
            }
            return {
              authorizationUrl: client.authorizationUrl({
                state: proof.state,
                codeChallenge: proof.codeChallenge,
              }),
              expiresAt:
                yield* Schema.decodeUnknownEffect(Timestamp)(expiresAt),
            };
          },
        ),
        completeAuthorization: Effect.fn(
          "IntegrationService.completeAuthorization",
        )(
          function* (
            keyring,
            owner,
            browserSessionId,
            expectedProvider,
            state,
            code,
            client,
            audit,
          ) {
            if (owner.scope !== "personal") {
              return yield* new IntegrationOAuthStateInvalid();
            }
            yield* enforcePersonalOverride(owner);
            const now = new Date().toISOString();
            const stateHash = yield* Effect.promise(() =>
              hashOAuthState(state),
            );
            const transaction = yield* repository.consumeOAuthTransaction(
              stateHash,
              owner.id,
              browserSessionId,
              now,
            );
            if (
              transaction.provider !== expectedProvider ||
              client.provider !== expectedProvider ||
              transaction.callbackUrl !== client.callbackUrl
            ) {
              yield* repository.removeOAuthTransaction(transaction.id);
              yield* Effect.ignore(
                vault.remove(owner, transaction.verifierReference),
              );
              return yield* new IntegrationOAuthStateInvalid();
            }
            const codeVerifier = yield* vault.read(
              keyring,
              owner,
              "pkce-verifier",
              transaction.verifierReference,
            );
            yield* repository.removeOAuthTransaction(transaction.id);
            yield* Effect.ignore(
              vault.remove(owner, transaction.verifierReference),
            );
            const tokens = yield* providerCall(() =>
              client.exchangeCode({ code, codeVerifier }),
            );
            const identity = yield* providerCall(() =>
              client.identity(tokens.accessToken),
            );
            const available = yield* providerCall(() =>
              client.repositories(tokens.accessToken),
            );
            const existing = yield* repository.findConnectionByProvider(
              owner,
              expectedProvider,
            );
            const connectionId =
              existing?.id ??
              (yield* Schema.decodeUnknownEffect(IntegrationConnectionId)(
                `int_${crypto.randomUUID()}`,
              ));
            const references = yield* storeTokenSet(keyring, owner, tokens);
            const connection = yield* Schema.decodeUnknownEffect(
              IntegrationConnection,
            )({
              id: connectionId,
              owner,
              provider: expectedProvider,
              status: "connected",
              health: "healthy",
              providerAccountId: identity.id,
              providerAccountLogin: identity.login,
              grantedScopes: tokens.grantedScopes,
              ...references,
              expiresAt: tokens.expiresAt,
              refreshExpiresAt: tokens.refreshExpiresAt,
              lastHealthCheckAt: now,
              revocationStatus: "not-requested",
              createdAt:
                existing === undefined
                  ? now
                  : Schema.encodeSync(Timestamp)(existing.createdAt),
              updatedAt: now,
            });
            const previouslySelected = new Set(
              existing === undefined
                ? []
                : (yield* repository.listRepositories(existing.id))
                    .filter((item) => item.selected)
                    .map((item) => item.providerRepositoryId),
            );
            const repositories = yield* Effect.all(
              available.map((item) =>
                repositoryRecord(
                  connectionId,
                  item,
                  previouslySelected.has(item.id),
                  now,
                ),
              ),
            );
            const written = yield* Effect.result(
              Effect.gen(function* () {
                const saved = yield* repository.saveConnection(
                  connection,
                  repositories,
                  existing,
                );
                if (!saved) return yield* new IntegrationRepositoryForbidden();
              }),
            );
            if (Result.isFailure(written)) {
              yield* removeCredentials(connection);
              return yield* Effect.fail(written.failure);
            }
            if (existing !== undefined) yield* removeCredentials(existing);
            yield* recordAudit(
              "integration.connect",
              owner,
              expectedProvider,
              connectionId,
              audit,
            );
            return connection;
          },
        ),
        selectRepositories: Effect.fn("IntegrationService.selectRepositories")(
          function* (
            keyring,
            owner,
            connectionId,
            repositoryIds,
            client,
            audit,
          ) {
            yield* enforcePersonalOverride(owner);
            const connection = yield* repository.findConnection(
              owner,
              connectionId,
            );
            if (connection.provider !== client.provider) {
              return yield* new IntegrationRepositoryForbidden();
            }
            const token = yield* accessToken(keyring, connection);
            const available = yield* providerCall(() =>
              client.repositories(token),
            );
            const availableIds = new Set(available.map((item) => item.id));
            if (
              new Set(repositoryIds).size !== repositoryIds.length ||
              repositoryIds.some((id) => !availableIds.has(id))
            ) {
              return yield* new IntegrationRepositoryForbidden();
            }
            const selected = new Set(repositoryIds);
            const now = new Date().toISOString();
            const records = yield* Effect.all(
              available.map((item) =>
                repositoryRecord(
                  connectionId,
                  item,
                  selected.has(item.id),
                  now,
                ),
              ),
            );
            yield* repository.replaceRepositories(connectionId, records);
            yield* recordAudit(
              "integration.repositories.select",
              owner,
              connection.provider,
              connectionId,
              audit,
            );
            return records;
          },
        ),
        refresh: Effect.fn("IntegrationService.refresh")(
          function* (keyring, owner, connectionId, client, audit) {
            yield* enforcePersonalOverride(owner);
            const connection = yield* repository.findConnection(
              owner,
              connectionId,
            );
            if (connection.provider !== client.provider) {
              return yield* new IntegrationRepositoryForbidden();
            }
            const refreshed = yield* refreshConnection(
              keyring,
              connection,
              client,
            );
            yield* recordAudit(
              "integration.refresh",
              owner,
              connection.provider,
              connectionId,
              audit,
            );
            return refreshed;
          },
        ),
        checkHealth: Effect.fn("IntegrationService.checkHealth")(
          function* (keyring, owner, connectionId, client, audit) {
            yield* enforcePersonalOverride(owner);
            const connection = yield* repository.findConnection(
              owner,
              connectionId,
            );
            if (connection.provider !== client.provider) {
              return yield* new IntegrationRepositoryForbidden();
            }
            const tokenResult = yield* Effect.result(
              accessToken(keyring, connection),
            );
            const providerResult: Result.Result<
              readonly [
                Awaited<ReturnType<GitProviderClient["identity"]>>,
                Awaited<ReturnType<GitProviderClient["repositories"]>>,
              ],
              unknown
            > = Result.isFailure(tokenResult)
              ? Result.fail(tokenResult.failure)
              : yield* Effect.result(
                  Effect.all([
                    providerCall(() => client.identity(tokenResult.success)),
                    providerCall(() =>
                      client.repositories(tokenResult.success),
                    ),
                  ]),
                );
            if (Result.isFailure(providerResult)) {
              if (connection.refreshTokenReference !== undefined) {
                return yield* refreshConnection(keyring, connection, client);
              }
              const now = new Date().toISOString();
              const failed = yield* Schema.decodeUnknownEffect(
                IntegrationConnection,
              )({
                ...Schema.encodeSync(IntegrationConnection)(connection),
                status: "needs-reauthorization",
                health: "expired",
                lastHealthCheckAt: now,
                updatedAt: now,
              });
              yield* repository.replaceConnection(failed);
              return yield* connectionView(failed);
            }
            const [identity, available] = providerResult.success;
            const selected = new Set(
              (yield* repository.listRepositories(connection.id))
                .filter((item) => item.selected)
                .map((item) => item.providerRepositoryId),
            );
            const now = new Date().toISOString();
            const healthy = yield* Schema.decodeUnknownEffect(
              IntegrationConnection,
            )({
              ...Schema.encodeSync(IntegrationConnection)(connection),
              providerAccountId: identity.id,
              providerAccountLogin: identity.login,
              health: "healthy",
              lastHealthCheckAt: now,
              updatedAt: now,
            });
            const records = yield* Effect.all(
              available.map((item) =>
                repositoryRecord(
                  connection.id,
                  item,
                  selected.has(item.id),
                  now,
                ),
              ),
            );
            const saved = yield* repository.saveConnection(
              healthy,
              records,
              connection,
            );
            if (!saved) return yield* new IntegrationRepositoryForbidden();
            yield* recordAudit(
              "integration.health.check",
              owner,
              connection.provider,
              connectionId,
              audit,
            );
            return { connection: healthy, repositories: records };
          },
        ),
        disconnectImpact: Effect.fn("IntegrationService.disconnectImpact")(
          function* (owner, connectionId) {
            yield* repository.findConnection(owner, connectionId);
            return yield* repository.disconnectImpact(connectionId);
          },
        ),
        disconnect: Effect.fn("IntegrationService.disconnect")(
          function* (keyring, owner, connectionId, client, audit) {
            yield* enforcePersonalOverride(owner);
            const connection = yield* repository.findConnection(
              owner,
              connectionId,
            );
            if (
              client !== undefined &&
              connection.provider !== client.provider
            ) {
              return yield* new IntegrationRepositoryForbidden();
            }
            const impact = yield* repository.disconnectImpact(connectionId);
            if (
              connection.status === "disconnected" &&
              connection.revocationStatus === "completed"
            ) {
              return { impact, providerRevocation: "completed" as const };
            }
            const tokens = yield* Effect.result(
              tokensForRevocation(keyring, connection),
            );
            const now = new Date().toISOString();
            const disconnected = yield* Schema.decodeUnknownEffect(
              IntegrationConnection,
            )({
              ...Schema.encodeSync(IntegrationConnection)(connection),
              status: "disconnected",
              health: "revoked",
              revocationStatus: "pending",
              revokedAt: now,
              updatedAt: now,
            });
            yield* repository.replaceConnection(disconnected);
            const revocationTokens = Result.isSuccess(tokens)
              ? tokens.success
              : undefined;
            const revocation =
              revocationTokens === undefined || client === undefined
                ? Result.fail(new IntegrationProviderRequestFailed())
                : yield* Effect.result(
                    providerCall(() => client.revoke(revocationTokens)),
                  );
            if (Result.isFailure(revocation)) {
              yield* recordAudit(
                "integration.disconnect",
                owner,
                connection.provider,
                connectionId,
                audit,
              );
              return { impact, providerRevocation: "pending" as const };
            }
            const completed = yield* Schema.decodeUnknownEffect(
              IntegrationConnection,
            )({
              ...Schema.encodeSync(IntegrationConnection)(disconnected),
              accessTokenReference: undefined,
              refreshTokenReference: undefined,
              revocationStatus: "completed",
              updatedAt: new Date().toISOString(),
            });
            yield* repository.replaceConnection(completed);
            yield* removeCredentials(connection);
            yield* recordAudit(
              "integration.disconnect",
              owner,
              connection.provider,
              connectionId,
              audit,
            );
            return { impact, providerRevocation: "completed" as const };
          },
        ),
        authorizeRepository: Effect.fn(
          "IntegrationService.authorizeRepository",
        )(function* (keyring, owner, connectionId, repositoryId, client) {
          yield* enforcePersonalOverride(owner);
          const connection = yield* repository.findConnection(
            owner,
            connectionId,
          );
          if (connection.provider !== client.provider) {
            return yield* new IntegrationRepositoryForbidden();
          }
          const selected = (yield* repository.listRepositories(
            connectionId,
          )).some(
            (item) =>
              item.selected && item.providerRepositoryId === repositoryId,
          );
          if (!selected) return yield* new IntegrationRepositoryForbidden();
          const token = yield* accessToken(keyring, connection);
          const providerAuthorized = (yield* providerCall(() =>
            client.repositories(token),
          )).some((item) => item.id === repositoryId);
          if (!providerAuthorized)
            return yield* new IntegrationRepositoryForbidden();
        }),
      });
    }),
  );
}
