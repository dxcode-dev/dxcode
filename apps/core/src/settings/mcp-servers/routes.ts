import {
  BeginMcpOAuthResponseSchema,
  CreateMcpServerRequestSchema,
  CreateMcpServerResponseSchema,
  DeleteMcpServerResponseSchema,
  DiscoverMcpServerResponseSchema,
  ListMcpServersResponseSchema,
  type McpServerData,
  McpServerDiscoveryFailedResponseSchema,
  McpServerLimitResponseSchema,
  McpServerNotFoundResponseSchema,
  McpServerOAuthFailedResponseSchema,
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
  SignOutMcpOAuthResponseSchema,
  UpdateMcpServerRequestSchema,
  UpdateMcpServerResponseSchema,
  UpdateMcpWorkspacePolicyRequestSchema,
  UpdateMcpWorkspacePolicyResponseSchema,
} from "@dx/api";
import {
  DEFAULT_MCP_CLIENT_NAME,
  EnvironmentVariableRepository,
  type McpClientName,
  type McpServerAuthType,
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
import { createAuth } from "../../auth/better-auth.js";
import { loadAuthenticationRequirements } from "../../auth/requirements.js";
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
import {
  createOAuthProof,
  hashOAuthState,
} from "../integrations/provider-registry.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../workspace-policy/service.js";
import {
  putMcpServerCredential,
  readMcpServerCredential,
  removeMcpServerCredential,
} from "./credential.js";
import { resolveMcpHeaders } from "./execution.js";
import {
  beginMcpOAuth,
  createMcpOAuthFetch,
  finishMcpOAuth,
  McpOAuthFailed,
  mcpOAuthAccessToken,
  mcpServerAdvertisesOAuth,
} from "./oauth.js";
import { McpServerRepositoryD1 } from "./repository-d1.js";
import {
  consumeMcpOAuthTransaction,
  insertMcpOAuthTransaction,
  listMcpServerSecretNames,
  type McpServerSecretName,
  putMcpOAuthGrant,
  putMcpServerSecret,
  readMcpServerSecrets,
  removeMcpOAuthGrants,
  removeMcpServerSecrets,
  signedInMcpServerIds,
} from "./secrets.js";
import {
  checkMcpClientName,
  checkMcpModuleId,
  planMcpHeaders,
} from "./server-input.js";
import {
  effectiveMcpModuleId,
  enforcePersonalMcpOverride,
  McpAuthReferenceInvalid,
  McpModuleIdTaken,
  McpServerService,
} from "./service.js";
import {
  discoverMcpTools,
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

const data = (
  { server, tools }: McpServerWithTools,
  signedIn: boolean,
): McpServerData => ({
  id: server.id,
  scope: server.target.scope,
  name: server.name,
  moduleId: effectiveMcpModuleId(server) as McpServerData["moduleId"],
  endpoint: server.endpoint,
  transport: server.transport,
  authType: server.authType,
  authReference: server.authReference,
  hasStoredToken: server.hasStoredCredential === true,
  clientName: server.clientName,
  oauthClientId: server.oauthClientId,
  hasOAuthClientSecret: server.hasOAuthClientSecret === true,
  signedIn: server.authType === "oauth" && signedIn,
  headers: server.headers.map(({ name, secret, value }) =>
    secret ? { name, secret } : { name, secret, value: value ?? "" },
  ),
  timeoutMs: server.timeoutMs,
  enabled: server.enabled,
  projectIds: server.projectIds,
  roles: server.roles,
  healthStatus: server.healthStatus,
  healthCheckedAt: server.healthCheckedAt,
  healthErrorCode: server.healthErrorCode,
  tools: tools.map((tool) => {
    const approved =
      tool.approvedSchemaHash !== undefined &&
      tool.approvedSchemaHash === tool.schemaHash;
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: JSON.parse(tool.inputSchemaJson) as unknown,
      schemaHash: tool.schemaHash,
      approved,
      reviewRequired: tool.approvedSchemaHash !== tool.schemaHash,
      policy: approved
        ? "allow"
        : tool.approvedSchemaHash === undefined && tool.reviewedAt !== undefined
          ? "disabled"
          : "review",
      discoveredAt: tool.discoveredAt,
      reviewedAt: tool.reviewedAt,
    } as const;
  }),
  createdAt: server.createdAt,
  updatedAt: server.updatedAt,
});

/** A checked input or its field error. */
const checked = <A>(
  result:
    | { readonly ok: true; readonly value: A }
    | { readonly ok: false; readonly error: SettingsFieldError },
) =>
  result.ok ? Effect.succeed(result.value) : Effect.fail(invalid(result.error));

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

/**
 * Automatic detection: a server that answers without credentials needs none;
 * one that refuses and advertises an authorization server uses OAuth; any
 * other refusal needs a bearer token.
 */
const detectAuth = Effect.fn("detectMcpAuth")(function* (
  endpoint: typeof McpServerEndpoint.Type,
  headers: Readonly<Record<string, string>>,
  clientName: McpClientName | undefined,
) {
  const probe = yield* Effect.result(
    discoverMcpTools(
      { endpoint, timeoutMs: 10_000 as never, clientName },
      undefined,
      {},
      headers,
    ),
  );
  if (Result.isSuccess(probe)) return "none" as const;
  if (
    probe.failure instanceof McpDiscoveryFailed &&
    probe.failure.code === "AUTHENTICATION_REQUIRED"
  ) {
    const oauth = yield* Effect.promise(() =>
      mcpServerAdvertisesOAuth(endpoint, createMcpOAuthFetch()),
    );
    if (oauth) return "oauth" as const;
    return yield* invalid(
      fieldError(
        "authType",
        "This server needs a bearer token. Choose Bearer token under Authentication.",
      ),
    );
  }
  return yield* invalid(
    fieldError(
      "endpoint",
      "dx could not connect to this MCP server. Check the URL, or choose the authentication yourself.",
    ),
  );
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
  userId: string,
) {
  const found = yield* Effect.gen(function* () {
    const repository = yield* McpServerRepository;
    return yield* repository.find(target, serverId);
  }).pipe(Effect.provide(layers(db)));
  const server = found.server;
  const keyring =
    server.authType === "none" && !server.headers.some(({ secret }) => secret)
      ? undefined
      : yield* loadConfigEncryptionKeyring(context.env);
  const headers = yield* credentialEffect(
    "settings.mcpServers.readHeaders",
    () => resolveMcpHeaders(db, keyring, server),
  );
  if (server.authType === "none" || keyring === undefined)
    return { credential: undefined, headers };
  if (server.authType === "oauth") {
    const token = yield* Effect.tryPromise({
      try: () => mcpOAuthAccessToken(db, keyring, server, userId),
      catch: (cause) =>
        cause instanceof McpOAuthFailed
          ? cause
          : new McpOAuthFailed({ reason: "Sign in again." }),
    });
    if (token === undefined)
      return yield* new McpOAuthFailed({
        reason: "Sign in to this server to discover its tools.",
      });
    return { credential: token, headers };
  }
  if (server.hasStoredCredential === true) {
    const credential = yield* credentialEffect(
      "settings.mcpServers.readCredential",
      () => readMcpServerCredential(db, keyring, server),
    );
    return { credential, headers };
  }
  const reference = server.authReference;
  if (reference === undefined) return { credential: undefined, headers };
  const variable = yield* Effect.gen(function* () {
    const repository = yield* EnvironmentVariableRepository;
    return yield* repository.find(target, reference.id);
  }).pipe(Effect.provide(layers(db)));
  if (variable.kind !== "secret" || !variable.enabled) {
    return yield* new McpAuthReferenceInvalid();
  }
  const credential = yield* decryptEnvironmentVariable(
    keyring,
    {
      id: variable.id,
      target: variable.target,
      name: variable.name,
      kind: variable.kind,
    },
    variable.envelope,
  );
  return { credential, headers };
});

/** Lists or finds servers and marks the ones the person has signed in to. */
const withSignIns = (
  db: D1Database,
  userId: string,
  servers: ReadonlyArray<McpServerWithTools>,
) =>
  credentialEffect("settings.mcpServers.signIns", () =>
    signedInMcpServerIds(
      db,
      userId,
      servers
        .filter(({ server }) => server.authType === "oauth")
        .map(({ server }) => server.id),
    ),
  ).pipe(
    Effect.map((signedIn) =>
      servers.map((found) => data(found, signedIn.has(found.server.id))),
    ),
  );

/** The callback every MCP sign-in returns to, on Core's own origin. */
const oauthRedirectUrl = (context: Context<AppEnv>) => {
  const url = new URL(context.env.DX_AUTH_URL as string);
  url.pathname = "/v1/settings/personal/mcp-servers/oauth/callback";
  url.search = "";
  url.hash = "";
  return url.toString();
};

class BrowserSessionMissing extends Schema.TaggedError<BrowserSessionMissing>()(
  "BrowserSessionMissing",
  {},
) {}

/** Sign-ins are bound to the browser session that started them. */
const browserSession = Effect.fn("mcpBrowserSession")(function* (
  context: Context<AppEnv>,
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
    catch: () => new BrowserSessionMissing(),
  });
  if (session === null || session.user.id !== principal.userId) {
    return yield* new BrowserSessionRequired();
  }
  return session.session.id;
});

/** Stores the server's secret header values and drops header secrets no longer listed. */
const storeHeaderSecrets = (
  db: D1Database,
  context: Context<AppEnv>,
  server: {
    readonly id: typeof McpServerParamsSchema.Type.mcpServerId;
    readonly target: McpServerTarget;
  },
  writes: ReadonlyArray<{
    readonly name: McpServerSecretName;
    readonly value: string;
  }>,
  keep: ReadonlyArray<McpServerSecretName>,
  stored: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    if (writes.length > 0) {
      const keyring = yield* loadConfigEncryptionKeyring(context.env);
      const now = new Date().toISOString();
      for (const write of writes)
        yield* credentialEffect("settings.mcpServers.putSecret", () =>
          putMcpServerSecret(db, keyring, server, write.name, write.value, now),
        );
    }
    const stale = stored.filter(
      (name) =>
        name.startsWith("header:") &&
        !keep.includes(name as McpServerSecretName),
    ) as Array<McpServerSecretName>;
    if (stale.length > 0)
      yield* credentialEffect("settings.mcpServers.removeSecrets", () =>
        removeMcpServerSecrets(db, server, { names: stale }),
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
  if (failure instanceof McpModuleIdTaken) {
    return context.json(
      Schema.encodeUnknownSync(McpServersInvalidRequestResponseSchema)({
        status: "error",
        data: {
          code: "INVALID_MCP_SERVER_REQUEST",
          message: "MCP server validation failed.",
          requestId,
          fieldErrors: [
            fieldError(
              "moduleId",
              "Another server in these settings uses this ID.",
            ),
          ],
        },
      }),
      400,
    );
  }
  if (failure instanceof McpOAuthFailed) {
    return context.json(
      Schema.encodeUnknownSync(McpServerOAuthFailedResponseSchema)({
        status: "error",
        data: {
          code: "MCP_SERVER_OAUTH_FAILED",
          message: failure.reason,
          requestId,
        },
      }),
      502,
    );
  }
  if (failure instanceof BrowserSessionMissing) {
    return response(
      McpServersBrowserSessionRequiredResponseSchema,
      403,
      "BROWSER_SESSION_REQUIRED",
      "A browser session is required to manage MCP servers.",
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
  /** Only the personal router serves the fixed OAuth callback. */
  withOAuthCallback = false,
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
  const findServer = (
    db: D1Database,
    target: McpServerTarget,
    id: typeof McpServerParamsSchema.Type.mcpServerId,
  ) =>
    withService(
      db,
      Effect.gen(function* () {
        const repository = yield* McpServerRepository;
        return yield* repository.find(target, id);
      }),
    );
  /** The server as the person sees it, with their own sign-in state. */
  const present = (
    context: Context<AppEnv>,
    db: D1Database,
    target: McpServerTarget,
    id: typeof McpServerParamsSchema.Type.mcpServerId,
  ) =>
    findServer(db, target, id).pipe(
      Effect.flatMap((found) =>
        withSignIns(db, context.get("principal").userId, [found]),
      ),
      Effect.map((items) => items[0] as McpServerData),
    );
  /**
   * Discovers the server's tools with the person's credential. Connecting
   * and refreshing allow tools not seen before; changed ones need review.
   */
  const discover = (
    context: Context<AppEnv>,
    db: D1Database,
    target: McpServerTarget,
    id: typeof McpServerParamsSchema.Type.mcpServerId,
  ) =>
    Effect.gen(function* () {
      const { credential, headers } = yield* credentialFor(
        context,
        db,
        target,
        id,
        context.get("principal").userId,
      );
      return yield* withService(
        db,
        Effect.gen(function* () {
          const service = yield* McpServerService;
          return yield* service.discover(
            target,
            id,
            credential,
            audit(context),
            undefined,
            { headers, approveNew: true },
          );
        }),
      );
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
      const listed = yield* withSignIns(
        db,
        context.get("principal").userId,
        items,
      );
      return yield* Schema.encodeUnknownEffect(ListMcpServersResponseSchema)({
        status: "success",
        data: {
          items: listed,
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
      const moduleId =
        body.moduleId === undefined || body.moduleId.trim() === ""
          ? undefined
          : yield* checked(checkMcpModuleId(body.moduleId));
      const clientName =
        body.clientName === undefined
          ? undefined
          : yield* checked(checkMcpClientName(body.clientName));
      const oauthClientId = body.oauthClientId?.trim() || undefined;
      if (body.oauthClientSecret !== undefined && oauthClientId === undefined) {
        return yield* invalid(
          fieldError("oauthClientId", "Enter the OAuth app's client ID."),
        );
      }
      const hasBearer =
        body.authToken !== undefined || body.authReference !== undefined;
      const requested = body.authType ?? (hasBearer ? "bearer" : "none");
      // Header values typed in the form, for probing before anything is stored.
      const typedHeaders = Object.fromEntries(
        (body.headers ?? []).flatMap(({ name: header, value }) =>
          value === undefined ? [] : [[header.trim(), value]],
        ),
      );
      const authType: McpServerAuthType =
        requested !== "auto"
          ? requested
          : hasBearer
            ? "bearer"
            : yield* detectAuth(endpoint, typedHeaders, clientName);
      if (authType === "bearer" && !hasBearer) {
        return yield* invalid(
          fieldError("authToken", "Enter the bearer token."),
        );
      }
      if (authType !== "bearer" && hasBearer) {
        return yield* invalid(
          fieldError("authToken", "A token only applies to bearer auth."),
        );
      }
      const plan = yield* checked(
        planMcpHeaders(body.headers ?? [], authType, new Set()),
      );
      const grants = yield* validateGrants(
        body.projectIds,
        body.roles,
        context.get("principal"),
      ).pipe(Effect.provide(layers(db)));
      const keyring =
        body.authToken === undefined &&
        plan.writes.length === 0 &&
        body.oauthClientSecret === undefined
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
              authType,
              authReference: body.authReference,
              timeoutMs,
              headers: plan.headers,
              ...(moduleId === undefined ? {} : { moduleId }),
              ...(clientName === undefined ? {} : { clientName }),
              ...(oauthClientId === undefined ? {} : { oauthClientId }),
              ...grants,
            },
            audit(context),
          );
        }),
      );
      // A server whose secrets could not be stored is removed again rather
      // than left calling its endpoint without them.
      const removeCreated = withService(
        db,
        Effect.gen(function* () {
          const repository = yield* McpServerRepository;
          yield* repository.remove(authorized.target, created.id);
        }),
      ).pipe(Effect.ignore);
      const now = new Date().toISOString();
      const authToken = body.authToken;
      const oauthClientSecret = body.oauthClientSecret;
      if (keyring !== undefined) {
        yield* Effect.gen(function* () {
          if (authToken !== undefined)
            yield* credentialEffect("settings.mcpServers.putCredential", () =>
              putMcpServerCredential(db, keyring, created, authToken, now),
            );
          if (oauthClientSecret !== undefined)
            yield* credentialEffect("settings.mcpServers.putSecret", () =>
              putMcpServerSecret(
                db,
                keyring,
                created,
                "oauth-client-secret",
                oauthClientSecret,
                now,
              ),
            );
          yield* storeHeaderSecrets(db, context, created, plan.writes, [], []);
        }).pipe(Effect.tapError(() => removeCreated));
      }
      // Connecting a server that needs no sign-in discovers its tools right
      // away; a failure leaves it saved and marked unreachable.
      if (authType !== "oauth") {
        yield* discover(context, db, authorized.target, created.id).pipe(
          Effect.ignore,
        );
      }
      const server = yield* present(context, db, authorized.target, created.id);
      return yield* Schema.encodeUnknownEffect(CreateMcpServerResponseSchema)({
        status: "success",
        data: server,
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
      const moduleId =
        body.moduleId === undefined
          ? undefined
          : body.moduleId.trim() === ""
            ? null
            : yield* checked(checkMcpModuleId(body.moduleId));
      const clientName =
        body.clientName === undefined
          ? undefined
          : ((yield* checked(checkMcpClientName(body.clientName))) ?? null);
      const oauthClientId =
        body.oauthClientId === undefined
          ? undefined
          : body.oauthClientId.trim() || null;
      const current = (yield* findServer(db, authorized.target, id)).server;
      // Legacy clients change auth through authToken and authReference only.
      const authType: McpServerAuthType =
        body.authType ??
        (body.authToken !== undefined
          ? "bearer"
          : body.authReference === null
            ? "none"
            : body.authReference !== undefined
              ? "bearer"
              : current.authType);
      if (
        authType === "bearer" &&
        body.authToken === undefined &&
        (body.authReference === undefined
          ? current.hasStoredCredential !== true &&
            current.authReference === undefined
          : body.authReference === null)
      ) {
        return yield* invalid(
          fieldError("authToken", "Enter the bearer token."),
        );
      }
      if (
        authType !== "bearer" &&
        (body.authToken !== undefined ||
          (body.authReference !== undefined && body.authReference !== null))
      ) {
        return yield* invalid(
          fieldError("authToken", "A token only applies to bearer auth."),
        );
      }
      const nextClientId =
        oauthClientId === undefined
          ? current.oauthClientId
          : (oauthClientId ?? undefined);
      if (body.oauthClientSecret !== undefined && nextClientId === undefined) {
        return yield* invalid(
          fieldError("oauthClientId", "Enter the OAuth app's client ID."),
        );
      }
      const storedSecrets = yield* credentialEffect(
        "settings.mcpServers.listSecrets",
        () => listMcpServerSecretNames(db, { id, target: authorized.target }),
      );
      const plan =
        body.headers === undefined
          ? authType !== current.authType
            ? yield* checked(
                planMcpHeaders(
                  current.headers.map((header) => ({
                    name: header.name,
                    secret: header.secret,
                    value: header.value,
                  })),
                  authType,
                  new Set(storedSecrets),
                ),
              )
            : undefined
          : yield* checked(
              planMcpHeaders(body.headers, authType, new Set(storedSecrets)),
            );
      const grants =
        body.projectIds === undefined && body.roles === undefined
          ? undefined
          : yield* validateGrants(
              body.projectIds ?? current.projectIds,
              body.roles ?? current.roles,
              context.get("principal"),
            ).pipe(Effect.provide(layers(db)));
      const owner = { id, target: authorized.target };
      const hadToken = current.hasStoredCredential === true;
      const authToken = body.authToken;
      const now = new Date().toISOString();
      if (authToken !== undefined) {
        // Store the new token before dropping any secret reference, so the
        // server never switches to an unauthenticated state in between.
        const keyring = yield* loadConfigEncryptionKeyring(context.env);
        yield* credentialEffect("settings.mcpServers.putCredential", () =>
          putMcpServerCredential(db, keyring, owner, authToken, now),
        );
      } else if (
        hadToken &&
        (authType !== "bearer" || body.authReference !== undefined)
      ) {
        // Leaving bearer auth, or replacing the token with a reference.
        yield* credentialEffect("settings.mcpServers.removeCredential", () =>
          removeMcpServerCredential(db, owner),
        );
      }
      const oauthClientSecret = body.oauthClientSecret;
      if (oauthClientSecret !== undefined) {
        const keyring = yield* loadConfigEncryptionKeyring(context.env);
        yield* credentialEffect("settings.mcpServers.putSecret", () =>
          putMcpServerSecret(
            db,
            keyring,
            owner,
            "oauth-client-secret",
            oauthClientSecret,
            now,
          ),
        );
      } else if (oauthClientId === null) {
        yield* credentialEffect("settings.mcpServers.removeSecrets", () =>
          removeMcpServerSecrets(db, owner, {
            names: ["oauth-client-secret"],
          }),
        );
      }
      if (plan !== undefined)
        yield* storeHeaderSecrets(
          db,
          context,
          owner,
          plan.writes,
          plan.keep,
          storedSecrets,
        );
      const endpointChanged =
        endpoint !== undefined && endpoint !== current.endpoint;
      // Sign-ins belong to an endpoint and a client; they end with either.
      if (
        current.authType === "oauth" &&
        (authType !== "oauth" ||
          endpointChanged ||
          (oauthClientId !== undefined &&
            (oauthClientId ?? undefined) !== current.oauthClientId))
      ) {
        yield* credentialEffect("settings.mcpServers.removeGrants", () =>
          removeMcpOAuthGrants(db, id),
        );
      }
      const leavingReference =
        current.authReference !== undefined &&
        (authToken !== undefined ||
          authType !== "bearer" ||
          body.authReference === null);
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
              authType,
              ...(plan === undefined ? {} : { headers: plan.headers }),
              ...(moduleId === undefined ? {} : { moduleId }),
              ...(clientName === undefined ? {} : { clientName }),
              ...(oauthClientId === undefined ? {} : { oauthClientId }),
              ...(leavingReference ? { clearAuthReference: true } : {}),
              ...(body.authReference !== undefined &&
              body.authReference !== null
                ? { authReference: body.authReference }
                : {}),
              // Switching between a stored token and a reference is a new
              // credential source; rotating a stored token is not.
              ...(authType === "bearer" &&
              current.authType === "bearer" &&
              ((authToken !== undefined && !hadToken) ||
                (body.authReference !== undefined && hadToken))
                ? { authModeChanged: true }
                : {}),
            },
            audit(context),
          );
        }),
      );
      return yield* Schema.encodeUnknownEffect(UpdateMcpServerResponseSchema)({
        status: "success",
        data: yield* present(context, db, authorized.target, server.id),
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
      yield* discover(context, db, authorized.target, id);
      return yield* Schema.encodeUnknownEffect(DiscoverMcpServerResponseSchema)(
        {
          status: "success",
          data: yield* present(context, db, authorized.target, id),
        },
      );
    });
    return run(context, operation);
  });

  router.post("/:mcpServerId/oauth/authorize", async (context) => {
    const operation = Effect.gen(function* () {
      const id = yield* parseServerId(context);
      const db = yield* decodeD1Binding(context.env.DB);
      const browserSessionId = yield* browserSession(context);
      // Members sign in to workspace servers they cannot edit: grants are
      // always their own.
      const authorized = yield* access(context, db);
      yield* enforcePersonalMcpOverride(
        authorized.target,
        context.get("principal").userId,
      ).pipe(Effect.provide(layers(db)));
      const { server } = yield* findServer(db, authorized.target, id);
      if (server.authType !== "oauth") {
        return yield* new McpOAuthFailed({
          reason: "This server does not use OAuth.",
        });
      }
      const keyring = yield* loadConfigEncryptionKeyring(context.env);
      const clientSecret =
        server.oauthClientId === undefined ||
        server.hasOAuthClientSecret !== true
          ? undefined
          : (yield* credentialEffect("settings.mcpServers.readSecrets", () =>
              readMcpServerSecrets(db, keyring, server),
            )).get("oauth-client-secret");
      const proof = yield* Effect.promise(() => createOAuthProof());
      const started = yield* Effect.tryPromise({
        try: () =>
          beginMcpOAuth({
            endpoint: server.endpoint,
            redirectUrl: oauthRedirectUrl(context),
            state: proof.state,
            client: {
              clientName: server.clientName ?? DEFAULT_MCP_CLIENT_NAME,
              ...(server.oauthClientId === undefined
                ? {}
                : { clientId: server.oauthClientId }),
              ...(clientSecret === undefined ? {} : { clientSecret }),
            },
            fetchFn: createMcpOAuthFetch(),
          }),
        catch: (cause) =>
          cause instanceof McpOAuthFailed
            ? cause
            : new McpOAuthFailed({
                reason: "The server's OAuth sign-in is unavailable.",
              }),
      });
      const route = routeFor(context);
      yield* credentialEffect("settings.mcpServers.beginOAuth", async () =>
        insertMcpOAuthTransaction(db, keyring, {
          stateHash: await hashOAuthState(proof.state),
          serverId: server.id,
          userId: context.get("principal").userId,
          browserSessionId,
          endpoint: server.endpoint,
          returnTo:
            route.mode === "personal"
              ? "personal"
              : `workspace:${route.workspaceSlug}`,
          payload: started.transaction,
          now: new Date(),
        }),
      );
      return yield* Schema.encodeUnknownEffect(BeginMcpOAuthResponseSchema)({
        status: "success",
        data: { authorizationUrl: started.authorizationUrl },
      });
    });
    return run(context, operation, 201);
  });

  router.delete("/:mcpServerId/oauth", async (context) => {
    const operation = Effect.gen(function* () {
      const id = yield* parseServerId(context);
      const db = yield* decodeD1Binding(context.env.DB);
      const authorized = yield* access(context, db);
      yield* findServer(db, authorized.target, id);
      yield* credentialEffect("settings.mcpServers.signOut", () =>
        removeMcpOAuthGrants(db, id, context.get("principal").userId),
      );
      return yield* Schema.encodeUnknownEffect(SignOutMcpOAuthResponseSchema)({
        status: "success",
        data: yield* present(context, db, authorized.target, id),
      });
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
      return yield* Schema.encodeUnknownEffect(ReviewMcpToolResponseSchema)({
        status: "success",
        data: yield* present(
          context,
          db,
          authorized.target,
          params.mcpServerId,
        ),
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

  if (withOAuthCallback) {
    router.get("/oauth/callback", async (context) => {
      let returnTo = "personal";
      let serverId: string | undefined;
      const operation = Effect.gen(function* () {
        const state = context.req.query("state");
        const code = context.req.query("code");
        const iss = context.req.query("iss");
        const providerError = context.req.query("error");
        if (state === undefined || state.length < 32 || state.length > 128) {
          return yield* new McpOAuthFailed({
            reason: "The sign-in link is invalid. Try again.",
          });
        }
        const db = yield* decodeD1Binding(context.env.DB);
        const browserSessionId = yield* browserSession(context);
        const keyring = yield* loadConfigEncryptionKeyring(context.env);
        const userId = context.get("principal").userId;
        const transaction = yield* credentialEffect(
          "settings.mcpServers.finishOAuth",
          async () =>
            consumeMcpOAuthTransaction(
              db,
              keyring,
              await hashOAuthState(state),
              userId,
              browserSessionId,
              new Date(),
            ),
        );
        if (transaction === undefined) {
          return yield* new McpOAuthFailed({
            reason: "The sign-in expired. Try again.",
          });
        }
        returnTo = transaction.returnTo;
        serverId = transaction.serverId;
        if (providerError !== undefined) {
          return yield* new McpOAuthFailed({
            reason: `The server declined the sign-in (${providerError.replace(/[^a-z_]/gi, "").slice(0, 64)}).`,
          });
        }
        if (code === undefined || code.length === 0 || code.length > 4_096) {
          return yield* new McpOAuthFailed({
            reason: "The server returned no authorization code.",
          });
        }
        const route: RouteScope = returnTo.startsWith("workspace:")
          ? {
              mode: "workspace",
              workspaceSlug: returnTo.slice("workspace:".length),
            }
          : { mode: "personal" };
        const authorized = yield* authorize(
          route,
          context.get("principal"),
        ).pipe(Effect.provide(layers(db)));
        const found = yield* findServer(
          db,
          authorized.target,
          transaction.serverId,
        );
        if (
          found.server.authType !== "oauth" ||
          found.server.endpoint !== transaction.endpoint
        ) {
          return yield* new McpOAuthFailed({
            reason: "The server changed during sign-in. Try again.",
          });
        }
        const payload = yield* Effect.tryPromise({
          try: () =>
            finishMcpOAuth(
              transaction.payload,
              code,
              iss,
              createMcpOAuthFetch(),
            ),
          catch: (cause) =>
            cause instanceof McpOAuthFailed
              ? cause
              : new McpOAuthFailed({
                  reason: "The sign-in failed. Try again.",
                }),
        });
        yield* credentialEffect("settings.mcpServers.putGrant", () =>
          putMcpOAuthGrant(
            db,
            keyring,
            found.server,
            userId,
            found.server.endpoint,
            payload,
            new Date(),
          ),
        );
        // Whoever can edit the server refreshes its tools; a member signing
        // in first discovers them so the server becomes usable.
        if (authorized.canMutate || found.tools.length === 0) {
          yield* discover(context, db, authorized.target, found.server.id).pipe(
            Effect.ignore,
          );
        }
      });
      const result = await Effect.runPromise(Effect.result(operation));
      const destination = new URL(context.env.DX_AUTH_URL as string);
      destination.pathname = returnTo.startsWith("workspace:")
        ? `/workspaces/${encodeURIComponent(returnTo.slice("workspace:".length))}/integrations`
        : "/settings/integrations";
      destination.hash = "";
      destination.search = new URLSearchParams({
        ...(serverId === undefined ? {} : { mcp: serverId }),
        ...(Result.isSuccess(result)
          ? { mcpStatus: "connected" }
          : {
              mcpStatus: "failed",
              mcpMessage:
                result.failure instanceof McpOAuthFailed
                  ? result.failure.reason
                  : "The sign-in failed. Try again.",
            }),
      }).toString();
      return context.redirect(destination.toString(), 303);
    });
  }
};

export const personalMcpServerRoutes = new Hono<AppEnv>();
registerRoutes(personalMcpServerRoutes, () => ({ mode: "personal" }), true);

export const workspaceMcpServerRoutes = new Hono<AppEnv>();
registerRoutes(workspaceMcpServerRoutes, (context) => ({
  mode: "workspace",
  workspaceSlug: context.req.param("workspaceSlug") ?? "",
}));
