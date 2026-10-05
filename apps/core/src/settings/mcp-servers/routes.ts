import {
  CreateMcpServerRequestSchema,
  CreateMcpServerResponseSchema,
  DeleteMcpServerResponseSchema,
  DiscoverMcpServerResponseSchema,
  ListMcpServersResponseSchema,
  type McpServerData,
  McpServerDiscoveryFailedResponseSchema,
  McpServerLimitResponseSchema,
  McpServerNotFoundResponseSchema,
  McpServerParamsSchema,
  McpServersBrowserSessionRequiredResponseSchema,
  McpServersForbiddenResponseSchema,
  McpServersInvalidRequestResponseSchema,
  McpServersPolicyDeniedResponseSchema,
  McpServersUnavailableResponseSchema,
  McpToolParamsSchema,
  ReviewMcpToolRequestSchema,
  ReviewMcpToolResponseSchema,
  type SettingsFieldError,
  UpdateMcpServerRequestSchema,
  UpdateMcpServerResponseSchema,
  UpdateMcpWorkspacePolicyRequestSchema,
  UpdateMcpWorkspacePolicyResponseSchema,
} from "@dx/api";
import {
  EnvironmentVariableRepository,
  McpServerEndpoint,
  McpServerLimitExceeded,
  McpServerName,
  McpServerNotFound,
  McpServerProjectGrants,
  McpServerRepository,
  McpServerRoleGrants,
  type McpServerTarget,
  McpServerTimeoutMs,
  type McpServerWithTools,
  normalizeMcpServerName,
  PersistenceUnavailable,
  type Principal,
  ProjectRepository,
  SettingsMembershipInvariantViolation,
  SettingsScopeForbidden,
  WorkspacePolicyDenied,
  WorkspaceSlug,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Option, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import {
  decodeJsonBody,
  decodeRequestInput,
} from "../../http/request-decoding.js";
import type { AppEnv } from "../../http/types.js";
import { authorizationLogger } from "../../logging.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { ProjectRepositoryD1 } from "../../projects/repository-d1.js";
import { SettingsAudit } from "../audit.js";
import {
  decryptEnvironmentVariable,
  loadConfigEncryptionKeyring,
} from "../environment-variables/encryption.js";
import { EnvironmentVariableRepositoryD1 } from "../environment-variables/repository-d1.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../workspace-policy/service.js";
import {
  putMcpServerCredential,
  readMcpServerCredential,
  removeMcpServerCredential,
} from "./credential.js";
import { McpServerRepositoryD1 } from "./repository-d1.js";
import {
  enforcePersonalMcpOverride,
  McpAuthReferenceInvalid,
  McpServerService,
} from "./service.js";
import {
  McpDiscoveryFailed,
  McpNetworkRejected,
  validateMcpEndpoint,
} from "./transport.js";

class InvalidMcpServerRequest extends Schema.TaggedError<InvalidMcpServerRequest>()(
  "InvalidMcpServerRequest",
  {
    fieldErrors: Schema.Array(
      Schema.Struct({ field: Schema.String, message: Schema.String }),
    ),
  },
) {}

class BrowserSessionRequired extends Schema.TaggedError<BrowserSessionRequired>()(
  "BrowserSessionRequired",
  {},
) {}

type RouteScope =
  | { readonly mode: "personal" }
  | { readonly mode: "workspace"; readonly workspaceSlug: string };

interface McpAccess {
  readonly target: McpServerTarget;
  readonly canMutate: boolean;
}

const fieldError = (field: string, message: string): SettingsFieldError => ({
  field,
  message,
});

const invalid = (...fieldErrors: ReadonlyArray<SettingsFieldError>) =>
  new InvalidMcpServerRequest({ fieldErrors: [...fieldErrors] });

const layers = (db: D1Database) => {
  const d1 = D1Client.layer({ db });
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const environment = EnvironmentVariableRepositoryD1(db);
  const mcp = McpServerRepositoryD1(db);
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
  const service = McpServerService.layer.pipe(
    Layer.provide(Layer.mergeAll(environment, mcp, SettingsAudit.layer)),
  );
  const projects = ProjectRepositoryD1.pipe(Layer.provide(d1));
  return Layer.mergeAll(
    workspace,
    environment,
    mcp,
    settings,
    policy,
    service,
    projects,
  );
};

const authorize = Effect.fn("authorizeMcpServers")(function* (
  route: RouteScope,
  principal: Principal,
) {
  const settings = yield* SettingsService;
  if (route.mode === "personal") {
    yield* settings.personal(principal);
    return {
      target: { scope: "personal", id: principal.userId },
      canMutate: true,
    } satisfies McpAccess;
  }
  const slug = Schema.decodeOption(WorkspaceSlug)(route.workspaceSlug);
  if (Option.isNone(slug)) {
    return yield* new SettingsScopeForbidden({ scope: "workspace" });
  }
  const access = yield* settings.workspace(principal, slug.value);
  return {
    target: {
      scope: "workspace",
      id: access.workspace.workspace.id,
    },
    canMutate: access.workspace.role !== "member",
  } satisfies McpAccess;
});

const parseServerId = (context: Context<AppEnv>) =>
  decodeRequestInput(
    McpServerParamsSchema,
    { mcpServerId: context.req.param("mcpServerId") },
    () => invalid(fieldError("mcpServerId", "Use a valid server identifier.")),
  ).pipe(Effect.map(({ mcpServerId }) => mcpServerId));

const data = ({ server, tools }: McpServerWithTools): McpServerData => ({
  id: server.id,
  scope: server.target.scope,
  name: server.name,
  endpoint: server.endpoint,
  transport: server.transport,
  authReference: server.authReference,
  hasStoredToken: server.hasStoredCredential === true,
  timeoutMs: server.timeoutMs,
  enabled: server.enabled,
  projectIds: server.projectIds,
  roles: server.roles,
  healthStatus: server.healthStatus,
  healthCheckedAt: server.healthCheckedAt,
  healthErrorCode: server.healthErrorCode,
  tools: tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: JSON.parse(tool.inputSchemaJson) as unknown,
    schemaHash: tool.schemaHash,
    approved:
      tool.approvedSchemaHash !== undefined &&
      tool.approvedSchemaHash === tool.schemaHash,
    reviewRequired: tool.approvedSchemaHash !== tool.schemaHash,
    discoveredAt: tool.discoveredAt,
    reviewedAt: tool.reviewedAt,
  })),
  createdAt: server.createdAt,
  updatedAt: server.updatedAt,
});

const validateName = (value: string) => {
  const decoded = Schema.decodeOption(McpServerName)(
    normalizeMcpServerName(value),
  );
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(
        invalid(fieldError("name", "Enter a name up to 80 characters.")),
      );
};

const validateEndpoint = (value: string) => {
  const decoded = Schema.decodeOption(McpServerEndpoint)(value);
  return Option.isSome(decoded)
    ? Effect.tryPromise({
        try: () => validateMcpEndpoint(decoded.value),
        catch: () =>
          invalid(
            fieldError(
              "endpoint",
              "Use a public HTTPS Streamable HTTP endpoint without redirects.",
            ),
          ),
      }).pipe(Effect.as(decoded.value))
    : Effect.fail(
        invalid(fieldError("endpoint", "Use a public HTTPS endpoint.")),
      );
};

const validateTimeout = (value: number) =>
  Schema.decodeEffect(McpServerTimeoutMs)(value).pipe(
    Effect.mapError(() =>
      invalid(fieldError("timeoutMs", "Choose 1,000–30,000 milliseconds.")),
    ),
  );

const validateGrants = Effect.fn("validateMcpGrants")(function* (
  projectIds: ReadonlyArray<string> | undefined,
  roles: ReadonlyArray<string> | undefined,
  principal: Principal,
) {
  const projects = yield* Schema.decodeEffect(McpServerProjectGrants)(
    projectIds ?? [],
  ).pipe(
    Effect.mapError(() =>
      invalid(fieldError("projectIds", "Choose up to 100 owned projects.")),
    ),
  );
  const roleGrants = yield* Schema.decodeUnknownEffect(McpServerRoleGrants)(
    roles ?? ["owner", "admin", "member"],
  ).pipe(
    Effect.mapError(() =>
      invalid(fieldError("roles", "Choose at least one supported role.")),
    ),
  );
  const repository = yield* ProjectRepository;
  yield* Effect.all(
    projects.map((projectId) =>
      repository
        .findOwnedById(projectId, principal.userId)
        .pipe(
          Effect.catchTag("ProjectNotFound", () =>
            Effect.fail(
              invalid(
                fieldError("projectIds", "Every project grant must be owned."),
              ),
            ),
          ),
        ),
    ),
    { concurrency: 4 },
  );
  return { projectIds: projects, roles: roleGrants };
});

const credentialEffect = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => PersistenceUnavailable.new({ operation }, cause),
  });

const credentialFor = Effect.fn("mcpCredentialForDiscovery")(function* (
  context: Context<AppEnv>,
  db: D1Database,
  target: McpServerTarget,
  serverId: typeof McpServerParamsSchema.Type.mcpServerId,
) {
  const found = yield* Effect.gen(function* () {
    const repository = yield* McpServerRepository;
    return yield* repository.find(target, serverId);
  }).pipe(Effect.provide(layers(db)));
  if (found.server.hasStoredCredential === true) {
    const keyring = yield* loadConfigEncryptionKeyring(context.env);
    return yield* credentialEffect("settings.mcpServers.readCredential", () =>
      readMcpServerCredential(db, keyring, found.server),
    );
  }
  const reference = found.server.authReference;
  if (reference === undefined) return undefined;
  const variable = yield* Effect.gen(function* () {
    const repository = yield* EnvironmentVariableRepository;
    return yield* repository.find(target, reference.id);
  }).pipe(Effect.provide(layers(db)));
  if (variable.kind !== "secret" || !variable.enabled) {
    return yield* new McpAuthReferenceInvalid();
  }
  const keyring = yield* loadConfigEncryptionKeyring(context.env);
  return yield* decryptEnvironmentVariable(
    keyring,
    {
      id: variable.id,
      target: variable.target,
      name: variable.name,
      kind: variable.kind,
    },
    variable.envelope,
  );
});

const failureResponse = (context: Context<AppEnv>, failure: unknown) => {
  const requestId = context.get("requestId");
  if (failure instanceof InvalidMcpServerRequest) {
    return context.json(
      Schema.encodeUnknownSync(McpServersInvalidRequestResponseSchema)({
        status: "error",
        data: {
          code: "INVALID_MCP_SERVER_REQUEST",
          message: "MCP server validation failed.",
          requestId,
          fieldErrors: failure.fieldErrors,
        },
      }),
      400,
    );
  }
  const response = (
    schema: Schema.ConstraintEncoder<unknown>,
    status: 401 | 403 | 404 | 409 | 502 | 503,
    code: string,
    message: string,
  ) =>
    context.json(
      Schema.encodeUnknownSync(schema)({
        status: "error",
        data: { code, message, requestId },
      }),
      status,
    );
  if (failure instanceof SettingsScopeForbidden) {
    authorizationLogger.warn("MCP server scope authorization failed.", {
      event: "mcp_server_scope_authorization_failed",
      requestId,
    });
    return response(
      McpServersForbiddenResponseSchema,
      403,
      "SETTINGS_SCOPE_FORBIDDEN",
      "The settings scope is unavailable for this user.",
    );
  }
  if (failure instanceof BrowserSessionRequired) {
    return response(
      McpServersBrowserSessionRequiredResponseSchema,
      403,
      "BROWSER_SESSION_REQUIRED",
      "A browser session is required to manage MCP servers.",
    );
  }
  if (failure instanceof McpServerNotFound) {
    return response(
      McpServerNotFoundResponseSchema,
      404,
      "MCP_SERVER_NOT_FOUND",
      "MCP server not found.",
    );
  }
  if (failure instanceof McpServerLimitExceeded) {
    return response(
      McpServerLimitResponseSchema,
      409,
      "MCP_SERVER_LIMIT_EXCEEDED",
      "This scope has reached its MCP server limit.",
    );
  }
  if (failure instanceof WorkspacePolicyDenied) {
    return context.json(
      Schema.encodeUnknownSync(McpServersPolicyDeniedResponseSchema)({
        status: "error",
        data: {
          code: "WORKSPACE_POLICY_DENIED",
          message: "Workspace policy does not allow this MCP action.",
          requestId,
          reason: failure.reason,
        },
      }),
      403,
    );
  }
  if (
    failure instanceof McpDiscoveryFailed ||
    failure instanceof McpNetworkRejected
  ) {
    return response(
      McpServerDiscoveryFailedResponseSchema,
      502,
      "MCP_SERVER_DISCOVERY_FAILED",
      "MCP server discovery failed.",
    );
  }
  if (
    failure instanceof PersistenceUnavailable ||
    failure instanceof McpAuthReferenceInvalid ||
    failure instanceof SettingsMembershipInvariantViolation ||
    Schema.isSchemaError(failure)
  ) {
    return response(
      McpServersUnavailableResponseSchema,
      503,
      "MCP_SERVERS_UNAVAILABLE",
      "MCP servers are temporarily unavailable.",
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

const registerRoutes = (
  router: Hono<AppEnv>,
  routeFor: (context: Context<AppEnv>) => RouteScope,
) => {
  const access = (context: Context<AppEnv>, db: D1Database) =>
    authorize(routeFor(context), context.get("principal")).pipe(
      Effect.provide(layers(db)),
    );
  const withService = <A, E, R>(
    db: D1Database,
    effect: Effect.Effect<A, E, R | McpServerService>,
  ) => effect.pipe(Effect.provide(layers(db)));
  const audit = (context: Context<AppEnv>) => ({
    userId: context.get("principal").userId,
    requestId: context.get("requestId"),
  });

  router.get("/", async (context) => {
    const operation = Effect.gen(function* () {
      const db = yield* decodeD1Binding(context.env.DB);
      const authorized = yield* access(context, db);
      const items = yield* withService(
        db,
        Effect.gen(function* () {
          const service = yield* McpServerService;
          return yield* service.list(authorized.target);
        }),
      );
      const workspaceId =
        authorized.target.scope === "workspace"
          ? authorized.target.id
          : undefined;
      const allowPersonalServers =
        workspaceId !== undefined
          ? yield* withService(
              db,
              Effect.gen(function* () {
                const service = yield* McpServerService;
                return yield* service.getWorkspacePolicy(workspaceId);
              }),
            )
          : undefined;
      return yield* Schema.encodeUnknownEffect(ListMcpServersResponseSchema)({
        status: "success",
        data: {
          items: items.map(data),
          canMutate: authorized.canMutate,
          ...(allowPersonalServers === undefined
            ? {}
            : { allowPersonalServers }),
        },
      });
    });
    return run(context, operation);
  });

  router.post("/", async (context) => {
    const operation = Effect.gen(function* () {
      const body = yield* decodeJsonBody(
        context.req,
        CreateMcpServerRequestSchema,
        () => invalid(fieldError("request", "Use only supported MCP fields.")),
      );
      const db = yield* decodeD1Binding(context.env.DB);
      const authorized = yield* access(context, db);
      if (!authorized.canMutate) {
        return yield* new SettingsScopeForbidden({ scope: "workspace" });
      }
      yield* enforcePersonalMcpOverride(
        authorized.target,
        context.get("principal").userId,
      ).pipe(Effect.provide(layers(db)));
      const name = yield* validateName(body.name);
      const endpoint = yield* validateEndpoint(body.endpoint);
      const timeoutMs = yield* validateTimeout(body.timeoutMs);
      if (body.authToken !== undefined && body.authReference !== undefined) {
        return yield* invalid(
          fieldError(
            "authToken",
            "Use a token or a secret reference, not both.",
          ),
        );
      }
      const grants = yield* validateGrants(
        body.projectIds,
        body.roles,
        context.get("principal"),
      ).pipe(Effect.provide(layers(db)));
      const keyring =
        body.authToken === undefined
          ? undefined
          : yield* loadConfigEncryptionKeyring(context.env);
      const created = yield* withService(
        db,
        Effect.gen(function* () {
          const service = yield* McpServerService;
          return yield* service.create(
            authorized.target,
            {
              name,
              endpoint,
              authReference: body.authReference,
              timeoutMs,
              ...grants,
            },
            audit(context),
          );
        }),
      );
      const authToken = body.authToken;
      if (authToken !== undefined && keyring !== undefined) {
        // A server whose token could not be stored is removed again rather
        // than left calling its endpoint unauthenticated.
        yield* credentialEffect("settings.mcpServers.putCredential", () =>
          putMcpServerCredential(
            db,
            keyring,
            created,
            authToken,
            new Date().toISOString(),
          ),
        ).pipe(
          Effect.tapError(() =>
            withService(
              db,
              Effect.gen(function* () {
                const repository = yield* McpServerRepository;
                yield* repository.remove(authorized.target, created.id);
              }),
            ).pipe(Effect.ignore),
          ),
        );
      }
      const server = {
        ...created,
        ...(authToken === undefined ? {} : { hasStoredCredential: true }),
      };
      return yield* Schema.encodeUnknownEffect(CreateMcpServerResponseSchema)({
        status: "success",
        data: data({ server, tools: [] }),
      });
    });
    return run(context, operation, 201);
  });

  router.patch("/policy", async (context) => {
    const operation = Effect.gen(function* () {
      const body = yield* decodeJsonBody(
        context.req,
        UpdateMcpWorkspacePolicyRequestSchema,
        () => invalid(fieldError("request", "Use allowPersonalServers.")),
      );
      const db = yield* decodeD1Binding(context.env.DB);
      const authorized = yield* access(context, db);
      if (authorized.target.scope !== "workspace" || !authorized.canMutate) {
        return yield* new SettingsScopeForbidden({ scope: "workspace" });
      }
      const workspaceId = authorized.target.id;
      yield* withService(
        db,
        Effect.gen(function* () {
          const service = yield* McpServerService;
          yield* service.setWorkspacePolicy(
            workspaceId,
            body.allowPersonalServers,
            audit(context),
          );
        }),
      );
      return yield* Schema.encodeUnknownEffect(
        UpdateMcpWorkspacePolicyResponseSchema,
      )({ status: "success", data: body });
    });
    return run(context, operation);
  });

  router.patch("/:mcpServerId", async (context) => {
    const operation = Effect.gen(function* () {
      const id = yield* parseServerId(context);
      const body = yield* decodeJsonBody(
        context.req,
        UpdateMcpServerRequestSchema,
        () => invalid(fieldError("request", "Use only supported MCP fields.")),
      );
      if (Object.keys(body).length === 0) {
        return yield* invalid(
          fieldError("request", "Change at least one field."),
        );
      }
      const db = yield* decodeD1Binding(context.env.DB);
      const authorized = yield* access(context, db);
      if (!authorized.canMutate) {
        return yield* new SettingsScopeForbidden({ scope: "workspace" });
      }
      yield* enforcePersonalMcpOverride(
        authorized.target,
        context.get("principal").userId,
      ).pipe(Effect.provide(layers(db)));
      const name =
        body.name === undefined ? undefined : yield* validateName(body.name);
      const endpoint =
        body.endpoint === undefined
          ? undefined
          : yield* validateEndpoint(body.endpoint);
      const timeoutMs =
        body.timeoutMs === undefined
          ? undefined
          : yield* validateTimeout(body.timeoutMs);
      if (body.authToken !== undefined && body.authReference !== undefined) {
        return yield* invalid(
          fieldError(
            "authToken",
            "Use a token or a secret reference, not both.",
          ),
        );
      }
      const authChanging =
        body.authToken !== undefined || body.authReference !== undefined;
      const current =
        body.projectIds === undefined &&
        body.roles === undefined &&
        !authChanging
          ? undefined
          : yield* withService(
              db,
              Effect.gen(function* () {
                const repository = yield* McpServerRepository;
                return yield* repository.find(authorized.target, id);
              }),
            );
      const grants =
        body.projectIds === undefined && body.roles === undefined
          ? undefined
          : yield* validateGrants(
              body.projectIds ?? current?.server.projectIds,
              body.roles ?? current?.server.roles,
              context.get("principal"),
            ).pipe(Effect.provide(layers(db)));
      const hadToken = current?.server.hasStoredCredential === true;
      const authToken = body.authToken;
      if (authToken !== undefined) {
        // Store the new token before dropping any secret reference, so the
        // server never switches to an unauthenticated state in between.
        const keyring = yield* loadConfigEncryptionKeyring(context.env);
        yield* credentialEffect("settings.mcpServers.putCredential", () =>
          putMcpServerCredential(
            db,
            keyring,
            { id, target: authorized.target },
            authToken,
            new Date().toISOString(),
          ),
        );
      } else if (body.authReference !== undefined && hadToken) {
        // `null` clears all auth; a secret reference replaces the token.
        yield* credentialEffect("settings.mcpServers.removeCredential", () =>
          removeMcpServerCredential(db, { id, target: authorized.target }),
        );
      }
      const server = yield* withService(
        db,
        Effect.gen(function* () {
          const service = yield* McpServerService;
          return yield* service.update(
            authorized.target,
            id,
            {
              ...(name === undefined ? {} : { name }),
              ...(endpoint === undefined ? {} : { endpoint }),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
              ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
              ...(grants ?? {}),
              ...(authToken !== undefined
                ? {
                    ...(current?.server.authReference === undefined
                      ? {}
                      : { clearAuthReference: true }),
                    authModeChanged: !hadToken,
                  }
                : body.authReference === undefined
                  ? {}
                  : body.authReference === null
                    ? { clearAuthReference: true, authModeChanged: hadToken }
                    : {
                        authReference: body.authReference,
                        authModeChanged: hadToken,
                      }),
            },
            audit(context),
          );
        }),
      );
      const found = yield* withService(
        db,
        Effect.gen(function* () {
          const repository = yield* McpServerRepository;
          return yield* repository.find(authorized.target, server.id);
        }),
      );
      return yield* Schema.encodeUnknownEffect(UpdateMcpServerResponseSchema)({
        status: "success",
        data: data(found),
      });
    });
    return run(context, operation);
  });

  router.post("/:mcpServerId/discover", async (context) => {
    const operation = Effect.gen(function* () {
      const id = yield* parseServerId(context);
      const db = yield* decodeD1Binding(context.env.DB);
      const authorized = yield* access(context, db);
      if (!authorized.canMutate) {
        return yield* new SettingsScopeForbidden({ scope: "workspace" });
      }
      yield* enforcePersonalMcpOverride(
        authorized.target,
        context.get("principal").userId,
      ).pipe(Effect.provide(layers(db)));
      const credential = yield* credentialFor(
        context,
        db,
        authorized.target,
        id,
      );
      const found = yield* withService(
        db,
        Effect.gen(function* () {
          const service = yield* McpServerService;
          return yield* service.discover(
            authorized.target,
            id,
            credential,
            audit(context),
          );
        }),
      );
      return yield* Schema.encodeUnknownEffect(DiscoverMcpServerResponseSchema)(
        { status: "success", data: data(found) },
      );
    });
    return run(context, operation);
  });

  router.post("/:mcpServerId/tools/:toolName/review", async (context) => {
    const operation = Effect.gen(function* () {
      const params = yield* decodeRequestInput(
        McpToolParamsSchema,
        {
          mcpServerId: context.req.param("mcpServerId"),
          toolName: context.req.param("toolName"),
        },
        () => invalid(fieldError("toolName", "Use a discovered tool name.")),
      );
      const body = yield* decodeJsonBody(
        context.req,
        ReviewMcpToolRequestSchema,
        () => invalid(fieldError("request", "Use schemaHash and approved.")),
      );
      const db = yield* decodeD1Binding(context.env.DB);
      const authorized = yield* access(context, db);
      if (!authorized.canMutate) {
        return yield* new SettingsScopeForbidden({ scope: "workspace" });
      }
      yield* enforcePersonalMcpOverride(
        authorized.target,
        context.get("principal").userId,
      ).pipe(Effect.provide(layers(db)));
      yield* withService(
        db,
        Effect.gen(function* () {
          const service = yield* McpServerService;
          yield* service.reviewTool(
            authorized.target,
            params.mcpServerId,
            params.toolName,
            body.schemaHash,
            body.approved,
            audit(context),
          );
        }),
      );
      const found = yield* withService(
        db,
        Effect.gen(function* () {
          const repository = yield* McpServerRepository;
          return yield* repository.find(authorized.target, params.mcpServerId);
        }),
      );
      return yield* Schema.encodeUnknownEffect(ReviewMcpToolResponseSchema)({
        status: "success",
        data: data(found),
      });
    });
    return run(context, operation);
  });

  router.delete("/:mcpServerId", async (context) => {
    const operation = Effect.gen(function* () {
      const id = yield* parseServerId(context);
      const db = yield* decodeD1Binding(context.env.DB);
      const authorized = yield* access(context, db);
      if (!authorized.canMutate) {
        return yield* new SettingsScopeForbidden({ scope: "workspace" });
      }
      yield* enforcePersonalMcpOverride(
        authorized.target,
        context.get("principal").userId,
      ).pipe(Effect.provide(layers(db)));
      yield* withService(
        db,
        Effect.gen(function* () {
          const service = yield* McpServerService;
          yield* service.remove(authorized.target, id, audit(context));
        }),
      );
      return yield* Schema.encodeUnknownEffect(DeleteMcpServerResponseSchema)({
        status: "success",
        data: { deletedMcpServerId: id },
      });
    });
    return run(context, operation);
  });
};

export const personalMcpServerRoutes = new Hono<AppEnv>();
registerRoutes(personalMcpServerRoutes, () => ({ mode: "personal" }));

export const workspaceMcpServerRoutes = new Hono<AppEnv>();
registerRoutes(workspaceMcpServerRoutes, (context) => ({
  mode: "workspace",
  workspaceSlug: context.req.param("workspaceSlug") ?? "",
}));
