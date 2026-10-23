import {
  ApplyBulkEnvironmentVariablesRequestSchema,
  ApplyBulkEnvironmentVariablesResponseSchema,
  BulkEnvironmentVariablesRequestSchema,
  CreateEnvironmentVariableRequestSchema,
  CreateEnvironmentVariableResponseSchema,
  DeleteEnvironmentVariableResponseSchema,
  EnvironmentVariableConflictResponseSchema,
  type EnvironmentVariableData,
  EnvironmentVariableHistoryQuerySchema,
  EnvironmentVariableLimitResponseSchema,
  EnvironmentVariableNotFoundResponseSchema,
  EnvironmentVariableParamsSchema,
  EnvironmentVariableScopeRequestSchema,
  EnvironmentVariablesBrowserSessionRequiredResponseSchema,
  EnvironmentVariablesForbiddenResponseSchema,
  EnvironmentVariablesInvalidRequestResponseSchema,
  EnvironmentVariablesUnavailableResponseSchema,
  ListEnvironmentVariableHistoryResponseSchema,
  ListEnvironmentVariablesResponseSchema,
  PreviewBulkEnvironmentVariablesResponseSchema,
  RotateEnvironmentVariableRequestSchema,
  RotateEnvironmentVariableResponseSchema,
  type SettingsFieldError,
  UpdateEnvironmentVariableRequestSchema,
  UpdateEnvironmentVariableResponseSchema,
} from "@dx/api";
import {
  configReferenceFor,
  EMPTY_SECRET_PROBLEM,
  EnvironmentVariableConflict,
  EnvironmentVariableKind,
  EnvironmentVariableName,
  EnvironmentVariableNotFound,
  EnvironmentVariableRepository,
  type EnvironmentVariableTarget,
  EnvironmentVariableValue,
  environmentVariableNameProblem,
  InvalidPageCursor,
  isHiddenEnvironmentValue,
  looksLikeSecretEnvironmentVariable,
  MASKED_SECRET_VALUE,
  MAX_ENVIRONMENT_VARIABLE_BULK_ITEMS,
  MAX_ENVIRONMENT_VARIABLE_VALUE_BYTES,
  normalizeEnvironmentVariableName,
  PersistenceUnavailable,
  type Principal,
  ProjectId,
  ProjectNotFound,
  ProjectRepository,
  parseEnvironmentVariableAssignments,
  SettingsMembershipInvariantViolation,
  SettingsScopeForbidden,
  type StoredEnvironmentVariable,
  WorkspaceSlug,
  workspaceRoleHasPermission,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Option, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import { createAuth } from "../../auth/better-auth.js";
import {
  BrowserSessionRequired,
  requireBrowserSession,
} from "../../auth/browser-session.js";
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
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import {
  type ConfigEncryptionKeyring,
  ConfigEncryptionUnavailable,
  decryptEnvironmentVariable,
  loadConfigEncryptionKeyring,
} from "./encryption.js";
import { refreshActiveThreadEnvironments } from "./refresh.js";
import { EnvironmentVariableRepositoryD1 } from "./repository-d1.js";
import {
  type BulkEnvironmentVariableInput,
  ENVIRONMENT_VARIABLE_PRECEDENCE,
  EnvironmentVariableEmptySecret,
  EnvironmentVariableLimitExceeded,
  EnvironmentVariableService,
} from "./service.js";

class InvalidEnvironmentVariablesRequest extends Schema.TaggedError<InvalidEnvironmentVariablesRequest>()(
  "InvalidEnvironmentVariablesRequest",
  {
    fieldErrors: Schema.Array(
      Schema.Struct({ field: Schema.String, message: Schema.String }),
    ),
  },
) {}

type RouteScope =
  | { readonly mode: "personal" }
  | { readonly mode: "workspace"; readonly workspaceSlug: string };

const fieldError = (field: string, message: string): SettingsFieldError => ({
  field,
  message,
});

const invalid = (...fieldErrors: ReadonlyArray<SettingsFieldError>) =>
  new InvalidEnvironmentVariablesRequest({ fieldErrors: [...fieldErrors] });

const validateName = (value: string) => {
  const problem = environmentVariableNameProblem(value);
  const name = Schema.decodeOption(EnvironmentVariableName)(
    normalizeEnvironmentVariableName(value),
  );
  return problem === undefined && Option.isSome(name)
    ? Effect.succeed(name.value)
    : Effect.fail(invalid(fieldError("name", problem ?? "Invalid name.")));
};

const validateValue = (value: string, kind: EnvironmentVariableKind) => {
  const decoded = Schema.decodeOption(EnvironmentVariableValue)(value);
  if (Option.isNone(decoded)) {
    return Effect.fail(
      invalid(
        fieldError(
          "value",
          `Enter at most ${MAX_ENVIRONMENT_VARIABLE_VALUE_BYTES.toLocaleString("en-US")} UTF-8 bytes.`,
        ),
      ),
    );
  }
  return kind === "secret" && decoded.value.length === 0
    ? Effect.fail(invalid(fieldError("value", EMPTY_SECRET_PROBLEM)))
    : Effect.succeed(decoded.value);
};

const validateKind = (value: string) => {
  const kind = Schema.decodeUnknownOption(EnvironmentVariableKind)(value);
  return Option.isNone(kind)
    ? Effect.fail(
        invalid(fieldError("kind", "Choose Secret or plain Variable.")),
      )
    : Effect.succeed(kind.value);
};

/** Bulk Add also takes `auto`, which picks each line's kind from its name. */
const validateBulkKind = (value: string) =>
  value === "auto" ? Effect.succeed("auto" as const) : validateKind(value);

const bulkItemKind = (
  kind: EnvironmentVariableKind | "auto",
  name: string,
  value: string,
): EnvironmentVariableKind =>
  kind !== "auto"
    ? kind
    : looksLikeSecretEnvironmentVariable(name, value)
      ? "secret"
      : "variable";

const parseBulk = parseEnvironmentVariableAssignments;

const environmentLayers = (db: D1Database) => {
  const d1 = D1Client.layer({ db });
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const project = ProjectRepositoryD1.pipe(Layer.provide(d1));
  const environment = EnvironmentVariableRepositoryD1(db);
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  const variables = EnvironmentVariableService.layer.pipe(
    Layer.provide(Layer.mergeAll(environment, workspace, SettingsAudit.layer)),
  );
  return Layer.mergeAll(environment, workspace, project, settings, variables);
};

const authorizeTarget = Effect.fn("authorizeEnvironmentVariableTarget")(
  function* (
    route: RouteScope,
    input: { readonly scope?: string; readonly projectId?: string },
    principal: Principal,
  ) {
    const settings = yield* SettingsService;
    if (route.mode === "workspace") {
      const slug = Schema.decodeOption(WorkspaceSlug)(route.workspaceSlug);
      if (Option.isNone(slug)) {
        return yield* new SettingsScopeForbidden({ scope: "workspace" });
      }
      const access = yield* settings.workspace(principal, slug.value);
      if (input.scope !== undefined && input.scope !== "workspace") {
        return yield* new SettingsScopeForbidden({ scope: "workspace" });
      }
      return {
        target: {
          scope: "workspace",
          id: access.workspace.workspace.id,
        } satisfies EnvironmentVariableTarget,
        canMutate: workspaceRoleHasPermission(
          access.workspace.role,
          "workspace:update",
        ),
      };
    }
    const personal = yield* settings.personal(principal);
    if (input.scope === undefined || input.scope === "personal") {
      if (input.projectId !== undefined) {
        return yield* new SettingsScopeForbidden({ scope: "personal" });
      }
      return {
        target: {
          scope: "personal",
          id: principal.userId,
        } satisfies EnvironmentVariableTarget,
        canMutate: true,
      };
    }
    if (input.scope !== "project" || input.projectId === undefined) {
      return yield* new SettingsScopeForbidden({ scope: "personal" });
    }
    const projectId = Schema.decodeOption(ProjectId)(input.projectId);
    if (Option.isNone(projectId)) {
      return yield* new SettingsScopeForbidden({ scope: "personal" });
    }
    const projects = yield* ProjectRepository;
    const project = yield* projects
      .findOwnedById(projectId.value, principal.userId)
      .pipe(
        Effect.catchTag("ProjectNotFound", () =>
          Effect.fail(new SettingsScopeForbidden({ scope: "personal" })),
        ),
      );
    // Every member's Threads use a workspace Project's values; only its
    // creator or a workspace admin changes them.
    return {
      target: {
        scope: "project",
        id: projectId.value,
      } satisfies EnvironmentVariableTarget,
      canMutate:
        project.workspaceId === undefined ||
        project.ownerUserId === principal.userId ||
        (personal.workspace !== undefined &&
          workspaceRoleHasPermission(
            personal.workspace.role,
            "workspace:update",
          )),
    };
  },
);

const queryTarget = (context: Context<AppEnv>, route: RouteScope) =>
  Effect.gen(function* () {
    const raw = yield* decodeRequestInput(
      EnvironmentVariableScopeRequestSchema,
      {
        scope:
          route.mode === "workspace"
            ? "workspace"
            : (context.req.query("scope") ?? "personal"),
        projectId: context.req.query("projectId"),
      },
      () => invalid(fieldError("scope", "Choose an available scope.")),
    );
    return yield* authorizeTarget(route, raw, context.get("principal"));
  });

/** What a response shows of a value: a secret masked, and whether dx hides it. */
const viewOf = (stored: StoredEnvironmentVariable, plaintext: string) => ({
  value: stored.kind === "secret" ? MASKED_SECRET_VALUE : plaintext,
  hidden: isHiddenEnvironmentValue(stored.kind, plaintext),
});

const responseData = (
  stored: StoredEnvironmentVariable,
  { value, hidden }: { readonly value: string; readonly hidden: boolean },
): EnvironmentVariableData => ({
  reference: configReferenceFor(stored.id),
  name: stored.name,
  kind: stored.kind,
  scope: stored.target.scope,
  ...(stored.target.scope === "project" ? { projectId: stored.target.id } : {}),
  enabled: stored.enabled,
  source: stored.target.scope,
  value,
  hidden,
  createdAt: stored.createdAt,
  updatedAt: stored.updatedAt,
  rotatedAt: stored.rotatedAt,
});

const viewStored = (
  keyring: ConfigEncryptionKeyring,
  stored: StoredEnvironmentVariable,
) =>
  decryptEnvironmentVariable(
    keyring,
    {
      id: stored.id,
      target: stored.target,
      name: stored.name,
      kind: stored.kind,
    },
    stored.envelope,
  ).pipe(
    Effect.map((plaintext) => responseData(stored, viewOf(stored, plaintext))),
  );

const errorResponse = (
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
  if (failure instanceof EnvironmentVariableEmptySecret) {
    return failureResponse(
      context,
      invalid(fieldError("value", EMPTY_SECRET_PROBLEM)),
    );
  }
  if (
    failure instanceof InvalidEnvironmentVariablesRequest ||
    failure instanceof InvalidPageCursor
  ) {
    return context.json(
      Schema.encodeUnknownSync(
        EnvironmentVariablesInvalidRequestResponseSchema,
      )({
        status: "error",
        data: {
          code: "INVALID_ENVIRONMENT_VARIABLES_REQUEST",
          message: "Environment variable validation failed.",
          requestId: context.get("requestId"),
          fieldErrors:
            failure instanceof InvalidEnvironmentVariablesRequest
              ? failure.fieldErrors
              : [fieldError("cursor", "Use a valid history cursor.")],
        },
      }),
      400,
    );
  }
  if (
    failure instanceof SettingsScopeForbidden ||
    failure instanceof ProjectNotFound
  ) {
    authorizationLogger.warn(
      "Environment variable scope authorization failed.",
      {
        event: "environment_variable_authorization_failed",
        requestId: context.get("requestId"),
      },
    );
    return errorResponse(
      context,
      EnvironmentVariablesForbiddenResponseSchema,
      403,
      "SETTINGS_SCOPE_FORBIDDEN",
      "The settings scope is unavailable for this user.",
    );
  }
  if (failure instanceof BrowserSessionRequired) {
    return errorResponse(
      context,
      EnvironmentVariablesBrowserSessionRequiredResponseSchema,
      403,
      "BROWSER_SESSION_REQUIRED",
      "A browser session is required to manage environment variables.",
    );
  }
  if (failure instanceof EnvironmentVariableNotFound) {
    return errorResponse(
      context,
      EnvironmentVariableNotFoundResponseSchema,
      404,
      "ENVIRONMENT_VARIABLE_NOT_FOUND",
      "Environment variable not found.",
    );
  }
  if (failure instanceof EnvironmentVariableConflict) {
    return errorResponse(
      context,
      EnvironmentVariableConflictResponseSchema,
      409,
      "ENVIRONMENT_VARIABLE_CONFLICT",
      "An environment variable with that name already exists in this scope.",
    );
  }
  if (failure instanceof EnvironmentVariableLimitExceeded) {
    return errorResponse(
      context,
      EnvironmentVariableLimitResponseSchema,
      409,
      "ENVIRONMENT_VARIABLE_LIMIT_EXCEEDED",
      "This scope has reached its environment variable limit.",
    );
  }
  if (
    failure instanceof PersistenceUnavailable ||
    failure instanceof ConfigEncryptionUnavailable ||
    failure instanceof SettingsMembershipInvariantViolation ||
    Schema.isSchemaError(failure)
  ) {
    return errorResponse(
      context,
      EnvironmentVariablesUnavailableResponseSchema,
      503,
      "ENVIRONMENT_VARIABLES_UNAVAILABLE",
      "Environment variables are temporarily unavailable.",
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

const dependencies = Effect.fn("environmentVariablesDependencies")(function* (
  context: Context<AppEnv>,
) {
  const db = yield* decodeD1Binding(context.env.DB);
  const keyring = yield* loadConfigEncryptionKeyring(context.env);
  return { db, keyring };
});

const withEnvironment = <A, E, R>(
  db: D1Database,
  effect: Effect.Effect<
    A,
    E,
    | R
    | SettingsService
    | ProjectRepository
    | EnvironmentVariableRepository
    | EnvironmentVariableService
  >,
) => effect.pipe(Effect.provide(environmentLayers(db)));

const parseIdentifier = (context: Context<AppEnv>) =>
  decodeRequestInput(
    EnvironmentVariableParamsSchema,
    { environmentVariableId: context.req.param("environmentVariableId") },
    () =>
      invalid(
        fieldError("environmentVariableId", "Use a valid item identifier."),
      ),
  ).pipe(Effect.map(({ environmentVariableId }) => environmentVariableId));

const registerRoutes = (
  router: Hono<AppEnv>,
  routeFor: (context: Context<AppEnv>) => RouteScope,
) => {
  const refresh = (
    context: Context<AppEnv>,
    db: D1Database,
    target: EnvironmentVariableTarget,
  ) => {
    if (context.env.THREAD_EXECUTION === undefined) return;
    context.executionCtx.waitUntil(
      refreshActiveThreadEnvironments(context.env, db, target).catch(
        () => undefined,
      ),
    );
  };

  router.get("/", async (context) => {
    const operation = Effect.gen(function* () {
      const { db, keyring } = yield* dependencies(context);
      const route = routeFor(context);
      const access = yield* withEnvironment(db, queryTarget(context, route));
      const items = yield* withEnvironment(
        db,
        Effect.gen(function* () {
          const service = yield* EnvironmentVariableService;
          return yield* service.list(keyring, access.target);
        }),
      );
      return yield* Schema.encodeUnknownEffect(
        ListEnvironmentVariablesResponseSchema,
      )({
        status: "success",
        data: {
          items: items.map(({ stored, ...view }) => responseData(stored, view)),
          precedence: ENVIRONMENT_VARIABLE_PRECEDENCE,
        },
      });
    });
    return run(context, operation);
  });

  router.get("/history", async (context) => {
    const operation = Effect.gen(function* () {
      const route = routeFor(context);
      const query = yield* decodeRequestInput(
        EnvironmentVariableHistoryQuerySchema,
        {
          scope:
            route.mode === "workspace"
              ? "workspace"
              : (context.req.query("scope") ?? "personal"),
          projectId: context.req.query("projectId"),
          cursor: context.req.query("cursor"),
          limit: context.req.query("limit"),
        },
        () => invalid(fieldError("query", "Use a valid history query.")),
      );
      const { db } = yield* dependencies(context);
      const access = yield* withEnvironment(
        db,
        authorizeTarget(route, query, context.get("principal")),
      );
      const page = yield* withEnvironment(
        db,
        Effect.gen(function* () {
          const service = yield* EnvironmentVariableService;
          return yield* service.listAudit(access.target, {
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            ...(query.limit === undefined ? {} : { limit: query.limit }),
          });
        }),
      );
      return yield* Schema.encodeUnknownEffect(
        ListEnvironmentVariableHistoryResponseSchema,
      )({
        status: "success",
        data: {
          items: page.items.map(({ target: _, ...item }) => item),
          ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
        },
      });
    });
    return run(context, operation);
  });

  router.post("/", async (context) => {
    const operation = Effect.gen(function* () {
      const body = yield* decodeJsonBody(
        context.req,
        CreateEnvironmentVariableRequestSchema,
        () => invalid(fieldError("request", "Use only the supported fields.")),
      );
      const name = yield* validateName(body.name);
      const kind = yield* validateKind(body.kind);
      const value = yield* validateValue(body.value, kind);
      const { db, keyring } = yield* dependencies(context);
      const route = routeFor(context);
      const access = yield* withEnvironment(
        db,
        authorizeTarget(route, body, context.get("principal")),
      );
      if (!access.canMutate) {
        return yield* new SettingsScopeForbidden({ scope: "workspace" });
      }
      const requirements = yield* loadAuthenticationRequirements(context.env);
      yield* requireBrowserSession(
        context,
        createAuth(context.env, requirements),
      );
      const stored = yield* withEnvironment(
        db,
        Effect.gen(function* () {
          const service = yield* EnvironmentVariableService;
          return yield* service.create(
            keyring,
            access.target,
            { name, kind, value },
            {
              userId: context.get("principal").userId,
              requestId: context.get("requestId"),
            },
          );
        }),
      );
      refresh(context, db, access.target);
      return yield* Schema.encodeUnknownEffect(
        CreateEnvironmentVariableResponseSchema,
      )({
        status: "success",
        data: responseData(stored, viewOf(stored, body.value)),
      });
    });
    return run(context, operation, 201);
  });

  router.post("/bulk/preview", async (context) => {
    const operation = Effect.gen(function* () {
      const body = yield* decodeJsonBody(
        context.req,
        BulkEnvironmentVariablesRequestSchema,
        () => invalid(fieldError("request", "Use only the supported fields.")),
      );
      const kind = yield* validateBulkKind(body.kind);
      const { db } = yield* dependencies(context);
      const route = routeFor(context);
      const access = yield* withEnvironment(
        db,
        authorizeTarget(route, body, context.get("principal")),
      );
      const parsed = parseBulk(body.contents);
      const existing = yield* withEnvironment(
        db,
        Effect.gen(function* () {
          const repository = yield* EnvironmentVariableRepository;
          return yield* repository.list(access.target);
        }),
      );
      const existingKinds = new Map(
        existing.map(({ name, kind }) => [name, kind]),
      );
      const overLimit = parsed.length > MAX_ENVIRONMENT_VARIABLE_BULK_ITEMS;
      const items = parsed.map((item) => {
        if (overLimit) {
          return {
            line: item.line,
            name: item.rawName,
            status: "invalid" as const,
            message: `Import at most ${MAX_ENVIRONMENT_VARIABLE_BULK_ITEMS} values at once.`,
          };
        }
        if (
          item.error !== undefined ||
          item.name === undefined ||
          item.value === undefined
        ) {
          return {
            line: item.line,
            name: item.rawName,
            status: "invalid" as const,
            message: item.error ?? "Invalid assignment.",
          };
        }
        // Replacing a stored secret keeps it secret.
        const itemKind =
          existingKinds.get(item.name) === "secret"
            ? "secret"
            : bulkItemKind(kind, item.name, item.value);
        if (itemKind === "secret" && item.value.length === 0) {
          return {
            line: item.line,
            name: item.name,
            status: "invalid" as const,
            message: EMPTY_SECRET_PROBLEM,
          };
        }
        return existingKinds.has(item.name)
          ? {
              line: item.line,
              name: item.name,
              kind: itemKind,
              status: "conflict" as const,
              message: "This name already exists in the selected scope.",
            }
          : {
              line: item.line,
              name: item.name,
              kind: itemKind,
              status: "ready" as const,
            };
      });
      return yield* Schema.encodeUnknownEffect(
        PreviewBulkEnvironmentVariablesResponseSchema,
      )({
        status: "success",
        data: {
          items,
          canApply:
            items.length > 0 &&
            !items.some(({ status }) => status === "invalid"),
        },
      });
    });
    return run(context, operation);
  });

  router.post("/bulk", async (context) => {
    const operation = Effect.gen(function* () {
      const body = yield* decodeJsonBody(
        context.req,
        ApplyBulkEnvironmentVariablesRequestSchema,
        () => invalid(fieldError("request", "Use only the supported fields.")),
      );
      const kind = yield* validateBulkKind(body.kind);
      const parsed = parseBulk(body.contents);
      if (parsed.length === 0) {
        return yield* invalid(
          fieldError("contents", "Paste at least one NAME=value line."),
        );
      }
      if (parsed.length > MAX_ENVIRONMENT_VARIABLE_BULK_ITEMS) {
        return yield* invalid(
          fieldError(
            "contents",
            `Add at most ${MAX_ENVIRONMENT_VARIABLE_BULK_ITEMS} values at once.`,
          ),
        );
      }
      const values: Array<BulkEnvironmentVariableInput> = [];
      const lineErrors: Array<SettingsFieldError> = [];
      for (const item of parsed) {
        const lineError =
          item.name === undefined || item.value === undefined
            ? (item.error ?? "Invalid assignment.")
            : bulkItemKind(kind, item.name, item.value) === "secret" &&
                item.value.length === 0
              ? EMPTY_SECRET_PROBLEM
              : undefined;
        if (
          lineError !== undefined ||
          item.name === undefined ||
          item.value === undefined
        ) {
          lineErrors.push(
            fieldError("contents", `Line ${item.line}: ${lineError}`),
          );
        } else {
          values.push({
            name: item.name,
            value: item.value,
            kind: bulkItemKind(kind, item.name, item.value),
          });
        }
      }
      if (lineErrors.length > 0) return yield* invalid(...lineErrors);
      const { db, keyring } = yield* dependencies(context);
      const route = routeFor(context);
      const access = yield* withEnvironment(
        db,
        authorizeTarget(route, body, context.get("principal")),
      );
      if (!access.canMutate) {
        return yield* new SettingsScopeForbidden({ scope: "workspace" });
      }
      const requirements = yield* loadAuthenticationRequirements(context.env);
      yield* requireBrowserSession(
        context,
        createAuth(context.env, requirements),
      );
      const stored = yield* withEnvironment(
        db,
        Effect.gen(function* () {
          const service = yield* EnvironmentVariableService;
          return yield* service.applyBulk(
            keyring,
            access.target,
            values,
            body.conflictBehavior,
            {
              userId: context.get("principal").userId,
              requestId: context.get("requestId"),
            },
          );
        }),
      );
      refresh(context, db, access.target);
      const plaintextByName = new Map(
        values.map((value) => [value.name, value.value]),
      );
      return yield* Schema.encodeUnknownEffect(
        ApplyBulkEnvironmentVariablesResponseSchema,
      )({
        status: "success",
        data: {
          items: stored.map((item) =>
            responseData(
              item,
              viewOf(item, plaintextByName.get(item.name) ?? ""),
            ),
          ),
          conflictBehavior: body.conflictBehavior,
        },
      });
    });
    return run(context, operation, 201);
  });

  router.patch("/:environmentVariableId", async (context) => {
    const operation = Effect.gen(function* () {
      const id = yield* parseIdentifier(context);
      const body = yield* decodeJsonBody(
        context.req,
        UpdateEnvironmentVariableRequestSchema,
        () => invalid(fieldError("request", "Use only enabled.")),
      );
      if (body.enabled === undefined) {
        return yield* invalid(fieldError("request", "Change enabled."));
      }
      const { db, keyring } = yield* dependencies(context);
      const access = yield* withEnvironment(
        db,
        queryTarget(context, routeFor(context)),
      );
      if (!access.canMutate) {
        return yield* new SettingsScopeForbidden({ scope: "workspace" });
      }
      const stored = yield* withEnvironment(
        db,
        Effect.gen(function* () {
          const service = yield* EnvironmentVariableService;
          return yield* service.updateState(access.target, id, body, {
            userId: context.get("principal").userId,
            requestId: context.get("requestId"),
          });
        }),
      );
      refresh(context, db, access.target);
      const item = yield* viewStored(keyring, stored);
      return yield* Schema.encodeUnknownEffect(
        UpdateEnvironmentVariableResponseSchema,
      )({ status: "success", data: item });
    });
    return run(context, operation);
  });

  router.post("/:environmentVariableId/rotate", async (context) => {
    const operation = Effect.gen(function* () {
      const id = yield* parseIdentifier(context);
      const body = yield* decodeJsonBody(
        context.req,
        RotateEnvironmentVariableRequestSchema,
        () => invalid(fieldError("request", "Use only value.")),
      );
      // The stored kind decides whether empty is allowed; the service checks it.
      const value = yield* validateValue(body.value, "variable");
      const { db, keyring } = yield* dependencies(context);
      const access = yield* withEnvironment(
        db,
        queryTarget(context, routeFor(context)),
      );
      if (!access.canMutate) {
        return yield* new SettingsScopeForbidden({ scope: "workspace" });
      }
      const stored = yield* withEnvironment(
        db,
        Effect.gen(function* () {
          const service = yield* EnvironmentVariableService;
          return yield* service.rotate(keyring, access.target, id, value, {
            userId: context.get("principal").userId,
            requestId: context.get("requestId"),
          });
        }),
      );
      refresh(context, db, access.target);
      return yield* Schema.encodeUnknownEffect(
        RotateEnvironmentVariableResponseSchema,
      )({
        status: "success",
        data: responseData(stored, viewOf(stored, body.value)),
      });
    });
    return run(context, operation);
  });

  router.delete("/:environmentVariableId", async (context) => {
    const operation = Effect.gen(function* () {
      const id = yield* parseIdentifier(context);
      const { db } = yield* dependencies(context);
      const access = yield* withEnvironment(
        db,
        queryTarget(context, routeFor(context)),
      );
      if (!access.canMutate) {
        return yield* new SettingsScopeForbidden({ scope: "workspace" });
      }
      yield* withEnvironment(
        db,
        Effect.gen(function* () {
          const service = yield* EnvironmentVariableService;
          yield* service.remove(access.target, id, {
            userId: context.get("principal").userId,
            requestId: context.get("requestId"),
          });
        }),
      );
      refresh(context, db, access.target);
      return yield* Schema.encodeUnknownEffect(
        DeleteEnvironmentVariableResponseSchema,
      )({ status: "success", data: { deletedEnvironmentVariableId: id } });
    });
    return run(context, operation);
  });
};

export const personalEnvironmentVariableRoutes = new Hono<AppEnv>();
registerRoutes(personalEnvironmentVariableRoutes, () => ({ mode: "personal" }));

export const workspaceEnvironmentVariableRoutes = new Hono<AppEnv>();
registerRoutes(workspaceEnvironmentVariableRoutes, (context) => ({
  mode: "workspace",
  workspaceSlug: context.req.param("workspaceSlug") ?? "",
}));
