import {
  BeginIntegrationAuthorizationResponseSchema,
  CheckIntegrationHealthResponseSchema,
  DisconnectIntegrationResponseSchema,
  GetIntegrationDisconnectImpactResponseSchema,
  type IntegrationConnectionData,
  IntegrationConnectionNotFoundResponseSchema,
  IntegrationConnectionParamsSchema,
  IntegrationOAuthStateInvalidResponseSchema,
  IntegrationProviderParamsSchema,
  IntegrationProviderUnavailableResponseSchema,
  type IntegrationRepositoryData,
  IntegrationRepositoryForbiddenResponseSchema,
  IntegrationsBrowserSessionRequiredResponseSchema,
  IntegrationsForbiddenResponseSchema,
  IntegrationsInvalidRequestResponseSchema,
  IntegrationsPolicyDeniedResponseSchema,
  IntegrationsUnavailableResponseSchema,
  ListPersonalIntegrationsResponseSchema,
  RefreshIntegrationResponseSchema,
  SelectIntegrationRepositoriesRequestSchema,
  SelectIntegrationRepositoriesResponseSchema,
} from "@dx/api";
import {
  type GitIntegrationProvider,
  IntegrationConnectionNotFound,
  IntegrationOAuthStateInvalid,
  type IntegrationOwner,
  IntegrationRepositoryStore,
  PersistenceUnavailable,
  SettingsScopeForbidden,
  WorkspacePermissionForbidden,
  WorkspacePolicyDenied,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import { createAuth } from "../../auth/better-auth.js";
import { loadAuthenticationRequirements } from "../../auth/requirements.js";
import {
  decodeJsonBody,
  decodeRequestInput,
} from "../../http/request-decoding.js";
import type { AppEnv } from "../../http/types.js";
import { authorizationLogger } from "../../logging.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { sourceControlProviderRegistry } from "../../source-control/provider-registry.js";
import { SettingsAudit } from "../audit.js";
import {
  ConfigEncryptionUnavailable,
  loadConfigEncryptionKeyring,
} from "../environment-variables/encryption.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../workspace-policy/service.js";
import {
  type IntegrationCredentialVault,
  IntegrationCredentialVaultD1,
} from "./credential-vault.js";
import {
  configuredGitProvider,
  type IntegrationProviderRegistration,
  IntegrationProviderRequestFailed,
  IntegrationProviderUnavailable,
  IntegrationRepositoryForbidden,
  loadIntegrationProviderRegistry,
} from "./provider-registry.js";
import { IntegrationRepositoryD1 } from "./repository-d1.js";
import { IntegrationService } from "./service.js";

class InvalidIntegrationsRequest extends Schema.TaggedError<InvalidIntegrationsRequest>()(
  "InvalidIntegrationsRequest",
  {},
) {}

class BrowserSessionRequired extends Schema.TaggedError<BrowserSessionRequired>()(
  "BrowserSessionRequired",
  {},
) {}

const servicesFor = (db: D1Database) => {
  const workspace = WorkspaceRepositoryD1(db).pipe(
    Layer.provide(D1Client.layer({ db })),
  );
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  const policy = WorkspacePolicyService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workspace,
        settings,
        WorkspacePolicyRepositoryD1(db),
        SettingsAudit.layer,
      ),
    ),
  );
  const integrationRepository = IntegrationRepositoryD1(db);
  const vault = IntegrationCredentialVaultD1(db);
  const integrations = IntegrationService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(integrationRepository, vault, policy, SettingsAudit.layer),
    ),
  );
  return Layer.mergeAll(
    workspace,
    settings,
    integrationRepository,
    vault,
    policy,
    integrations,
  );
};

const withServices = <A, E, R>(
  db: D1Database,
  effect: Effect.Effect<
    A,
    E,
    | R
    | SettingsService
    | IntegrationRepositoryStore
    | IntegrationCredentialVault
    | IntegrationService
  >,
) => effect.pipe(Effect.provide(servicesFor(db)));

const browser = Effect.fn("integrationBrowserSession")(function* (
  context: Context<AppEnv>,
  db: D1Database,
) {
  const principal = context.get("principal");
  if (principal.apiTokenScopes !== undefined) {
    return yield* new BrowserSessionRequired();
  }
  const requirements = yield* loadAuthenticationRequirements(context.env);
  const auth = createAuth(context.env, requirements);
  const session = yield* Effect.tryPromise({
    try: () =>
      auth.api.getSession({
        headers: context.req.raw.headers,
        query: { disableCookieCache: true },
      }),
    catch: () => new BrowserSessionRequired(),
  });
  if (session === null || session.user.id !== principal.userId) {
    return yield* new BrowserSessionRequired();
  }
  yield* withServices(
    db,
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      yield* settings.personal(principal);
    }),
  );
  return session.session.id;
});

const decode = <S extends Schema.Constraint>(schema: S, input: unknown) =>
  decodeRequestInput(schema, input, () => new InvalidIntegrationsRequest());

const providerData = (registration: IntegrationProviderRegistration) => {
  const descriptor =
    registration.kind === "git"
      ? sourceControlProviderRegistry.descriptorFor(
          registration.provider as GitIntegrationProvider,
        )
      : undefined;
  if (descriptor === undefined || descriptor.provider !== "github") {
    throw new IntegrationProviderUnavailable();
  }
  return {
    provider: descriptor.provider,
    kind: "source-control" as const,
    displayName: descriptor.displayName,
    availability: registration.available
      ? ("available" as const)
      : ("unavailable" as const),
    ...(!registration.available
      ? { unavailableReason: "deployment-not-configured" as const }
      : {}),
    capabilities: descriptor.capabilities,
  };
};

const repositoryData = (repository: {
  readonly providerRepositoryId: string;
  readonly fullName: string;
  readonly webUrl: string;
  readonly visibility: "public" | "private" | "internal";
  readonly selected: boolean;
}): IntegrationRepositoryData => ({
  id: repository.providerRepositoryId as IntegrationRepositoryData["id"],
  fullName: repository.fullName,
  webUrl: repository.webUrl,
  visibility: repository.visibility,
  selected: repository.selected,
});

const connectionData = (view: {
  readonly connection: {
    readonly id: IntegrationConnectionData["id"];
    readonly provider: IntegrationConnectionData["provider"];
    readonly status: IntegrationConnectionData["status"];
    readonly health: IntegrationConnectionData["health"];
    readonly providerAccountLogin: string;
    readonly grantedScopes: ReadonlyArray<string>;
    readonly expiresAt?: IntegrationConnectionData["expiresAt"];
    readonly refreshExpiresAt?: IntegrationConnectionData["refreshExpiresAt"];
    readonly lastHealthCheckAt?: IntegrationConnectionData["lastHealthCheckAt"];
    readonly revocationStatus: IntegrationConnectionData["revocationStatus"];
  };
  readonly repositories: ReadonlyArray<Parameters<typeof repositoryData>[0]>;
}): IntegrationConnectionData => ({
  id: view.connection.id,
  provider: view.connection.provider,
  status: view.connection.status,
  health: view.connection.health,
  providerAccountLogin: view.connection.providerAccountLogin,
  grantedScopes: view.connection.grantedScopes,
  ...(view.connection.expiresAt === undefined
    ? {}
    : { expiresAt: view.connection.expiresAt }),
  ...(view.connection.refreshExpiresAt === undefined
    ? {}
    : { refreshExpiresAt: view.connection.refreshExpiresAt }),
  ...(view.connection.lastHealthCheckAt === undefined
    ? {}
    : { lastHealthCheckAt: view.connection.lastHealthCheckAt }),
  revocationStatus: view.connection.revocationStatus,
  repositories: view.repositories.map(repositoryData),
});

const error = (
  context: Context<AppEnv>,
  schema: Schema.ConstraintEncoder<unknown>,
  status: 400 | 401 | 403 | 404 | 409 | 503,
  code: string,
  message: string,
) =>
  context.json(
    Schema.encodeUnknownSync(schema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );

const failureResponse = (context: Context<AppEnv>, failure: unknown) => {
  if (failure instanceof InvalidIntegrationsRequest) {
    return context.json(
      Schema.encodeUnknownSync(IntegrationsInvalidRequestResponseSchema)({
        status: "error",
        data: {
          code: "INVALID_INTEGRATIONS_REQUEST",
          message: "Integration request validation failed.",
          requestId: context.get("requestId"),
          fieldErrors: [],
        },
      }),
      400,
    );
  }
  if (
    failure instanceof SettingsScopeForbidden ||
    failure instanceof WorkspacePermissionForbidden
  ) {
    authorizationLogger.warn("Integration scope authorization failed.", {
      event: "integration_authorization_failed",
      requestId: context.get("requestId"),
    });
    return error(
      context,
      IntegrationsForbiddenResponseSchema,
      403,
      "SETTINGS_SCOPE_FORBIDDEN",
      "The settings scope is unavailable for this user.",
    );
  }
  if (failure instanceof BrowserSessionRequired) {
    return error(
      context,
      IntegrationsBrowserSessionRequiredResponseSchema,
      403,
      "BROWSER_SESSION_REQUIRED",
      "A browser session is required to manage integrations.",
    );
  }
  if (failure instanceof WorkspacePolicyDenied) {
    return context.json(
      Schema.encodeUnknownSync(IntegrationsPolicyDeniedResponseSchema)({
        status: "error",
        data: {
          code: "WORKSPACE_POLICY_DENIED",
          message:
            "Workspace policy does not allow personal integration credentials.",
          requestId: context.get("requestId"),
          reason: failure.reason,
        },
      }),
      403,
    );
  }
  if (failure instanceof IntegrationProviderUnavailable) {
    return error(
      context,
      IntegrationProviderUnavailableResponseSchema,
      409,
      "INTEGRATION_PROVIDER_UNAVAILABLE",
      "This integration provider is not safely configured.",
    );
  }
  if (failure instanceof IntegrationConnectionNotFound) {
    return error(
      context,
      IntegrationConnectionNotFoundResponseSchema,
      404,
      "INTEGRATION_CONNECTION_NOT_FOUND",
      "Integration connection not found.",
    );
  }
  if (failure instanceof IntegrationOAuthStateInvalid) {
    return error(
      context,
      IntegrationOAuthStateInvalidResponseSchema,
      409,
      "INTEGRATION_OAUTH_STATE_INVALID",
      "The integration authorization request is invalid or expired.",
    );
  }
  if (failure instanceof IntegrationRepositoryForbidden) {
    return error(
      context,
      IntegrationRepositoryForbiddenResponseSchema,
      403,
      "INTEGRATION_REPOSITORY_FORBIDDEN",
      "One or more repositories are not authorized by the provider.",
    );
  }
  if (
    failure instanceof IntegrationProviderRequestFailed ||
    failure instanceof PersistenceUnavailable ||
    failure instanceof ConfigEncryptionUnavailable ||
    Schema.isSchemaError(failure)
  ) {
    return error(
      context,
      IntegrationsUnavailableResponseSchema,
      503,
      "INTEGRATIONS_UNAVAILABLE",
      "Integrations are temporarily unavailable.",
    );
  }
  throw failure;
};

const run = async <A, E>(
  context: Context<AppEnv>,
  operation: Effect.Effect<A, E>,
  status: 200 | 201 = 200,
) => {
  const result = await Effect.runPromise(Effect.result(operation));
  return Result.isSuccess(result)
    ? context.json(result.success, status)
    : failureResponse(context, result.failure);
};

const dependencies = Effect.fn("integrationRouteDependencies")(function* (
  context: Context<AppEnv>,
) {
  const db = yield* decodeD1Binding(context.env.DB);
  const browserSessionId = yield* browser(context, db);
  return { db, browserSessionId };
});

const ownerFor = (context: Context<AppEnv>): IntegrationOwner => ({
  scope: "personal",
  id: context.get("principal").userId,
});

const auditFor = (context: Context<AppEnv>) => ({
  userId: context.get("principal").userId,
  requestId: context.get("requestId"),
});

const registryFor = (context: Context<AppEnv>) =>
  loadIntegrationProviderRegistry(context.env);

const clientForProvider = (
  registry: ReadonlyArray<IntegrationProviderRegistration>,
  provider: GitIntegrationProvider,
) =>
  Effect.try({
    try: () => configuredGitProvider(registry, provider),
    catch: () => new IntegrationProviderUnavailable(),
  });

const clientForConnection = Effect.fn("clientForConnection")(function* (
  db: D1Database,
  owner: IntegrationOwner,
  connectionId: IntegrationConnectionData["id"],
  registry: ReadonlyArray<IntegrationProviderRegistration>,
  required = true,
) {
  const connection = yield* withServices(
    db,
    Effect.gen(function* () {
      const repository = yield* IntegrationRepositoryStore;
      return yield* repository.findConnection(owner, connectionId);
    }),
  );
  const registration = registry.find(
    (item) => item.provider === connection.provider,
  );
  if (registration?.available === true && registration.client !== undefined) {
    return registration.client;
  }
  if (required) return yield* new IntegrationProviderUnavailable();
  return undefined;
});

export const personalIntegrationRoutes = new Hono<AppEnv>();

personalIntegrationRoutes.get("/", async (context) => {
  const operation = Effect.gen(function* () {
    const { db } = yield* dependencies(context);
    const views = yield* withServices(
      db,
      Effect.gen(function* () {
        const service = yield* IntegrationService;
        return yield* service.list(ownerFor(context));
      }),
    );
    return yield* Schema.encodeUnknownEffect(
      ListPersonalIntegrationsResponseSchema,
    )({
      status: "success",
      data: {
        providers: registryFor(context).map(providerData),
        connections: views.map(connectionData),
      },
    });
  });
  return run(context, operation);
});

personalIntegrationRoutes.post("/:provider/authorize", async (context) => {
  const operation = Effect.gen(function* () {
    const { provider } = yield* decode(IntegrationProviderParamsSchema, {
      provider: context.req.param("provider"),
    });
    const { db, browserSessionId } = yield* dependencies(context);
    const keyring = yield* loadConfigEncryptionKeyring(context.env);
    const client = yield* clientForProvider(registryFor(context), provider);
    const authorization = yield* withServices(
      db,
      Effect.gen(function* () {
        const service = yield* IntegrationService;
        return yield* service.beginAuthorization(
          keyring,
          ownerFor(context),
          browserSessionId,
          client,
        );
      }),
    );
    return yield* Schema.encodeUnknownEffect(
      BeginIntegrationAuthorizationResponseSchema,
    )({
      status: "success",
      data: { provider, ...authorization },
    });
  });
  return run(context, operation, 201);
});

personalIntegrationRoutes.get("/oauth/callback/:provider", async (context) => {
  const operation = Effect.gen(function* () {
    const { provider } = yield* decode(IntegrationProviderParamsSchema, {
      provider: context.req.param("provider"),
    });
    const state = context.req.query("state");
    const code = context.req.query("code");
    if (
      state === undefined ||
      code === undefined ||
      state.length < 43 ||
      state.length > 128 ||
      code.length < 1 ||
      code.length > 2_048
    ) {
      return yield* new InvalidIntegrationsRequest();
    }
    const { db, browserSessionId } = yield* dependencies(context);
    const keyring = yield* loadConfigEncryptionKeyring(context.env);
    const client = yield* clientForProvider(registryFor(context), provider);
    yield* withServices(
      db,
      Effect.gen(function* () {
        const service = yield* IntegrationService;
        yield* service.completeAuthorization(
          keyring,
          ownerFor(context),
          browserSessionId,
          provider,
          state,
          code,
          client,
          auditFor(context),
        );
      }),
    );
    const destination = new URL(context.env.DX_AUTH_URL as string);
    destination.pathname = "/settings/integrations";
    destination.search = new URLSearchParams({
      provider,
      status: "connected",
    }).toString();
    return destination.toString();
  });
  const result = await Effect.runPromise(Effect.result(operation));
  return Result.isSuccess(result)
    ? context.redirect(result.success, 303)
    : failureResponse(context, result.failure);
});

const connectionId = (context: Context<AppEnv>) =>
  decode(IntegrationConnectionParamsSchema, {
    connectionId: context.req.param("connectionId"),
  }).pipe(Effect.map((params) => params.connectionId));

personalIntegrationRoutes.put(
  "/connections/:connectionId/repositories",
  async (context) => {
    const operation = Effect.gen(function* () {
      const id = yield* connectionId(context);
      const body = yield* decodeJsonBody(
        context.req,
        SelectIntegrationRepositoriesRequestSchema,
        () => new InvalidIntegrationsRequest(),
      );
      const { db } = yield* dependencies(context);
      const keyring = yield* loadConfigEncryptionKeyring(context.env);
      const client = yield* clientForConnection(
        db,
        ownerFor(context),
        id,
        registryFor(context),
      );
      if (client === undefined) {
        return yield* new IntegrationProviderUnavailable();
      }
      const repositories = yield* withServices(
        db,
        Effect.gen(function* () {
          const service = yield* IntegrationService;
          return yield* service.selectRepositories(
            keyring,
            ownerFor(context),
            id,
            body.repositoryIds,
            client,
            auditFor(context),
          );
        }),
      );
      return yield* Schema.encodeUnknownEffect(
        SelectIntegrationRepositoriesResponseSchema,
      )({
        status: "success",
        data: { repositories: repositories.map(repositoryData) },
      });
    });
    return run(context, operation);
  },
);

personalIntegrationRoutes.get(
  "/connections/:connectionId/disconnect-impact",
  async (context) => {
    const operation = Effect.gen(function* () {
      const id = yield* connectionId(context);
      const { db } = yield* dependencies(context);
      const impact = yield* withServices(
        db,
        Effect.gen(function* () {
          const service = yield* IntegrationService;
          return yield* service.disconnectImpact(ownerFor(context), id);
        }),
      );
      return yield* Schema.encodeUnknownEffect(
        GetIntegrationDisconnectImpactResponseSchema,
      )({ status: "success", data: impact });
    });
    return run(context, operation);
  },
);

const connectionMutation =
  (
    schema:
      | typeof RefreshIntegrationResponseSchema
      | typeof CheckIntegrationHealthResponseSchema,
    operationName: "refresh" | "checkHealth",
  ) =>
  async (context: Context<AppEnv>) => {
    const operation = Effect.gen(function* () {
      const id = yield* connectionId(context);
      const { db } = yield* dependencies(context);
      const keyring = yield* loadConfigEncryptionKeyring(context.env);
      const client = yield* clientForConnection(
        db,
        ownerFor(context),
        id,
        registryFor(context),
      );
      if (client === undefined) {
        return yield* new IntegrationProviderUnavailable();
      }
      const view = yield* withServices(
        db,
        Effect.gen(function* () {
          const service = yield* IntegrationService;
          return yield* service[operationName](
            keyring,
            ownerFor(context),
            id,
            client,
            auditFor(context),
          );
        }),
      );
      return yield* Schema.encodeUnknownEffect(schema)({
        status: "success",
        data: connectionData(view),
      });
    });
    return run(context, operation);
  };

personalIntegrationRoutes.post(
  "/connections/:connectionId/refresh",
  connectionMutation(RefreshIntegrationResponseSchema, "refresh"),
);
personalIntegrationRoutes.post(
  "/connections/:connectionId/health",
  connectionMutation(CheckIntegrationHealthResponseSchema, "checkHealth"),
);

personalIntegrationRoutes.delete(
  "/connections/:connectionId",
  async (context) => {
    const operation = Effect.gen(function* () {
      const id = yield* connectionId(context);
      const { db } = yield* dependencies(context);
      const keyring = yield* loadConfigEncryptionKeyring(context.env);
      const client = yield* clientForConnection(
        db,
        ownerFor(context),
        id,
        registryFor(context),
        false,
      );
      const result = yield* withServices(
        db,
        Effect.gen(function* () {
          const service = yield* IntegrationService;
          return yield* service.disconnect(
            keyring,
            ownerFor(context),
            id,
            client,
            auditFor(context),
          );
        }),
      );
      return yield* Schema.encodeUnknownEffect(
        DisconnectIntegrationResponseSchema,
      )({
        status: "success",
        data: {
          disconnectedConnectionId: id,
          localAccessStopped: true,
          providerRevocation: result.providerRevocation,
          impact: result.impact,
        },
      });
    });
    return run(context, operation);
  },
);
