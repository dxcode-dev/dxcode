import {
  ListPluginsResponseSchema,
  type PluginData,
  PluginIntegrityConflictResponseSchema,
  PluginLimitResponseSchema,
  PluginNotFoundResponseSchema,
  PluginParamsSchema,
  PluginPermissionInvalidResponseSchema,
  PluginsBrowserSessionRequiredResponseSchema,
  PluginsForbiddenResponseSchema,
  PluginsInvalidRequestResponseSchema,
  PluginsPolicyDeniedResponseSchema,
  PluginsUnavailableResponseSchema,
  PreviewPluginRequestSchema,
  PreviewPluginResponseSchema,
  PublishPluginVersionRequestSchema,
  PublishPluginVersionResponseSchema,
  RemovePluginResponseSchema,
  type SettingsFieldError,
  TrustPluginRequestSchema,
  TrustPluginResponseSchema,
  UpdatePluginStateRequestSchema,
  UpdatePluginStateResponseSchema,
  UpdatePluginWorkspacePolicyRequestSchema,
  UpdatePluginWorkspacePolicyResponseSchema,
} from "@dx/api";
import {
  PersistenceUnavailable,
  PluginIntegrityConflict,
  PluginLimitExceeded,
  PluginNotFound,
  PluginPermissionInvalid,
  PluginRepository,
  type PluginTarget,
  type PluginWithVersion,
  type Principal,
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
import { SettingsAudit } from "../audit.js";
import { EnvironmentVariableRepositoryD1 } from "../environment-variables/repository-d1.js";
import { McpServerRepositoryD1 } from "../mcp-servers/repository-d1.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../workspace-policy/service.js";
import { PluginImportRejected } from "./import.js";
import { PluginRepositoryD1 } from "./repository-d1.js";
import { PluginService } from "./service.js";

class InvalidPluginRequest extends Schema.TaggedError<InvalidPluginRequest>()(
  "InvalidPluginRequest",
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

interface PluginAccess {
  readonly target: PluginTarget;
  readonly canMutate: boolean;
  readonly workspaceId?: string;
}

const fieldError = (field: string, message: string): SettingsFieldError => ({
  field,
  message,
});

const invalid = (field: string, message: string) =>
  new InvalidPluginRequest({ fieldErrors: [fieldError(field, message)] });

const layers = (db: D1Database) => {
  const d1 = D1Client.layer({ db });
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const environment = EnvironmentVariableRepositoryD1(db);
  const mcp = McpServerRepositoryD1(db);
  const plugins = PluginRepositoryD1(db);
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
  const service = PluginService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(environment, mcp, plugins, policy, SettingsAudit.layer),
    ),
  );
  return Layer.mergeAll(
    workspace,
    environment,
    mcp,
    plugins,
    settings,
    policy,
    service,
  );
};

const authorize = Effect.fn("authorizePlugins")(function* (
  route: RouteScope,
  principal: Principal,
) {
  const settings = yield* SettingsService;
  if (route.mode === "personal") {
    const access = yield* settings.personal(principal);
    return {
      target: { scope: "personal", id: principal.userId },
      canMutate: true,
      workspaceId: access.workspace?.workspace.id,
    } satisfies PluginAccess;
  }
  const slug = Schema.decodeOption(WorkspaceSlug)(route.workspaceSlug);
  if (Option.isNone(slug)) {
    return yield* new SettingsScopeForbidden({ scope: "workspace" });
  }
  const access = yield* settings.workspace(principal, slug.value);
  return {
    target: { scope: "workspace", id: access.workspace.workspace.id },
    canMutate: access.workspace.role !== "member",
    workspaceId: access.workspace.workspace.id,
  } satisfies PluginAccess;
});

const fileData = (file: PluginWithVersion["active"]["files"][number]) => ({
  path: file.path,
  mediaType: file.mediaType,
  sizeBytes: file.sizeBytes,
  integrity: file.integrity,
});

const versionData = (version: PluginWithVersion["active"]) => ({
  version: version.version,
  manifest: version.manifest,
  files: version.files.map(fileData),
  source: version.source,
  integrity: version.integrity,
  grants: version.grants,
  trusted: version.trusted,
  trustedAt: version.trustedAt,
});

const pluginData = (
  value: PluginWithVersion,
  effectiveState: PluginData["effectiveState"],
  overridesPersonal: boolean,
): PluginData => ({
  id: value.plugin.id,
  scope: value.plugin.target.scope,
  name: value.plugin.name,
  enabled: value.plugin.enabled,
  activeVersion: value.plugin.activeVersion,
  versions: value.versions,
  active: versionData(value.active),
  healthStatus: value.plugin.healthStatus,
  effectiveState,
  overridesPersonal,
  createdAt: value.plugin.createdAt,
  updatedAt: value.plugin.updatedAt,
});

const listData = Effect.fn("pluginsListData")(function* (
  access: PluginAccess,
  principal: Principal,
) {
  const repository = yield* PluginRepository;
  const items = yield* repository.list(access.target);
  let allowPersonalPlugins: boolean | undefined;
  let counterparts: ReadonlyArray<PluginWithVersion> = [];
  if (access.workspaceId !== undefined) {
    allowPersonalPlugins = yield* repository.getWorkspacePolicy(
      access.workspaceId as never,
    );
    counterparts = yield* repository.list(
      access.target.scope === "personal"
        ? { scope: "workspace", id: access.workspaceId as never }
        : { scope: "personal", id: principal.userId },
    );
  }
  return {
    items: items.map((item) => {
      const conflict = counterparts.some(
        (candidate) =>
          candidate.plugin.enabled &&
          candidate.plugin.name === item.plugin.name,
      );
      const state: PluginData["effectiveState"] = !item.plugin.enabled
        ? "disabled"
        : item.plugin.target.scope === "personal" &&
            allowPersonalPlugins === false
          ? "blocked-by-policy"
          : item.plugin.target.scope === "personal" && conflict
            ? "blocked-by-workspace"
            : "effective";
      return pluginData(
        item,
        state,
        item.plugin.target.scope === "workspace" && conflict,
      );
    }),
    canMutate: access.canMutate,
    precedence: "workspace-over-personal" as const,
    ...(allowPersonalPlugins === undefined ? {} : { allowPersonalPlugins }),
  };
});

const parsePluginId = (context: Context<AppEnv>) =>
  decodeRequestInput(
    PluginParamsSchema,
    { pluginId: context.req.param("pluginId") },
    () => invalid("pluginId", "Use a valid plugin identifier."),
  ).pipe(Effect.map(({ pluginId }) => pluginId));

const failureResponse = (context: Context<AppEnv>, failure: unknown) => {
  const requestId = context.get("requestId");
  const response = (
    schema: Schema.ConstraintEncoder<unknown>,
    status: 401 | 403 | 404 | 409 | 503,
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
  if (
    failure instanceof InvalidPluginRequest ||
    failure instanceof PluginImportRejected
  ) {
    const fieldErrors =
      failure instanceof PluginImportRejected
        ? [fieldError(failure.field, failure.reason)]
        : failure.fieldErrors;
    return context.json(
      Schema.encodeUnknownSync(PluginsInvalidRequestResponseSchema)({
        status: "error",
        data: {
          code: "INVALID_PLUGIN_REQUEST",
          message: "Plugin validation failed.",
          requestId,
          fieldErrors,
        },
      }),
      400,
    );
  }
  if (failure instanceof SettingsScopeForbidden) {
    authorizationLogger.warn("Plugin scope authorization failed.", {
      event: "plugin_scope_authorization_failed",
      requestId,
    });
    return response(
      PluginsForbiddenResponseSchema,
      403,
      "SETTINGS_SCOPE_FORBIDDEN",
      "The settings scope is unavailable for this user.",
    );
  }
  if (failure instanceof BrowserSessionRequired) {
    return response(
      PluginsBrowserSessionRequiredResponseSchema,
      403,
      "BROWSER_SESSION_REQUIRED",
      "A browser session is required to trust plugins.",
    );
  }
  if (failure instanceof PluginNotFound) {
    return response(
      PluginNotFoundResponseSchema,
      404,
      "PLUGIN_NOT_FOUND",
      "Plugin not found.",
    );
  }
  if (failure instanceof PluginLimitExceeded) {
    return response(
      PluginLimitResponseSchema,
      409,
      "PLUGIN_LIMIT_EXCEEDED",
      "This scope has reached its plugin limit.",
    );
  }
  if (failure instanceof PluginIntegrityConflict) {
    return response(
      PluginIntegrityConflictResponseSchema,
      409,
      "PLUGIN_INTEGRITY_CONFLICT",
      "The reviewed plugin content no longer matches or conflicts with an immutable version.",
    );
  }
  if (failure instanceof PluginPermissionInvalid) {
    return response(
      PluginPermissionInvalidResponseSchema,
      409,
      "PLUGIN_PERMISSION_INVALID",
      "Every granted permission must be explicitly requested and reference an approved resource.",
    );
  }
  if (failure instanceof WorkspacePolicyDenied) {
    return context.json(
      Schema.encodeUnknownSync(PluginsPolicyDeniedResponseSchema)({
        status: "error",
        data: {
          code: "WORKSPACE_POLICY_DENIED",
          message:
            "Workspace policy does not allow this personal plugin permission.",
          requestId,
          reason: failure.reason,
        },
      }),
      403,
    );
  }
  if (
    failure instanceof PersistenceUnavailable ||
    failure instanceof SettingsMembershipInvariantViolation ||
    Schema.isSchemaError(failure)
  ) {
    return response(
      PluginsUnavailableResponseSchema,
      503,
      "PLUGINS_UNAVAILABLE",
      "Plugins are temporarily unavailable.",
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
  const operation = <A, E, R>(
    context: Context<AppEnv>,
    use: (
      db: D1Database,
      access: PluginAccess,
    ) => Effect.Effect<A, E, R | PluginService | PluginRepository>,
  ) =>
    Effect.gen(function* () {
      const db = yield* decodeD1Binding(context.env.DB);
      const access = yield* authorize(
        routeFor(context),
        context.get("principal"),
      ).pipe(Effect.provide(layers(db)));
      return yield* use(db, access).pipe(Effect.provide(layers(db)));
    });
  const mutate = (access: PluginAccess) =>
    access.canMutate
      ? Effect.void
      : Effect.fail(new SettingsScopeForbidden({ scope: "workspace" }));
  const audit = (context: Context<AppEnv>) => ({
    userId: context.get("principal").userId,
    requestId: context.get("requestId"),
  });

  router.get("/", (context) =>
    run(
      context,
      operation(context, (_db, access) =>
        Effect.gen(function* () {
          const data = yield* listData(access, context.get("principal"));
          return yield* Schema.encodeUnknownEffect(ListPluginsResponseSchema)({
            status: "success",
            data,
          });
        }),
      ),
    ),
  );

  router.post("/preview", async (context) => {
    const raw = await context.req.json().catch(() => undefined);
    return run(
      context,
      operation(context, (_db, access) =>
        Effect.gen(function* () {
          yield* mutate(access);
          const body = yield* Schema.decodeUnknownEffect(
            PreviewPluginRequestSchema,
          )(raw).pipe(
            Effect.mapError(() =>
              invalid("files", "Use a supported reviewed source bundle."),
            ),
          );
          const service = yield* PluginService;
          const preview = yield* service.preview(body);
          return yield* Schema.encodeUnknownEffect(PreviewPluginResponseSchema)(
            {
              status: "success",
              data: { ...preview, files: preview.files.map(fileData) },
            },
          );
        }),
      ),
    );
  });

  router.post("/", (context) =>
    run(
      context,
      operation(context, (_db, access) =>
        Effect.gen(function* () {
          const body = yield* decodeJsonBody(
            context.req,
            TrustPluginRequestSchema,
            () =>
              invalid("request", "Use bundle, reviewedIntegrity, and grants."),
          );
          yield* mutate(access);
          const service = yield* PluginService;
          yield* service.trust(
            access.target,
            body.bundle,
            body.reviewedIntegrity,
            body.grants,
            audit(context),
          );
          const listed = yield* listData(access, context.get("principal"));
          const created = listed.items.find(
            ({ active }) => active.integrity === body.reviewedIntegrity,
          );
          if (created === undefined) return yield* new PluginNotFound();
          return yield* Schema.encodeUnknownEffect(TrustPluginResponseSchema)({
            status: "success",
            data: created,
          });
        }),
      ),
      201,
    ),
  );

  router.post("/:pluginId/versions", (context) =>
    run(
      context,
      operation(context, (_db, access) =>
        Effect.gen(function* () {
          const id = yield* parsePluginId(context);
          const body = yield* decodeJsonBody(
            context.req,
            PublishPluginVersionRequestSchema,
            () =>
              invalid(
                "request",
                "Use bundle, reviewedIntegrity, grants, and activate.",
              ),
          );
          yield* mutate(access);
          const service = yield* PluginService;
          yield* service.update(
            access.target,
            id,
            body.bundle,
            body.reviewedIntegrity,
            body.grants,
            body.activate,
            audit(context),
          );
          const listed = yield* listData(access, context.get("principal"));
          const updated = listed.items.find((item) => item.id === id);
          if (updated === undefined) return yield* new PluginNotFound();
          return yield* Schema.encodeUnknownEffect(
            PublishPluginVersionResponseSchema,
          )({ status: "success", data: updated });
        }),
      ),
      201,
    ),
  );

  router.patch("/policy", (context) =>
    run(
      context,
      operation(context, (_db, access) =>
        Effect.gen(function* () {
          const body = yield* decodeJsonBody(
            context.req,
            UpdatePluginWorkspacePolicyRequestSchema,
            () => invalid("request", "Use allowPersonalPlugins."),
          );
          yield* mutate(access);
          if (access.target.scope !== "workspace") {
            return yield* new SettingsScopeForbidden({ scope: "workspace" });
          }
          const service = yield* PluginService;
          yield* service.setWorkspacePolicy(
            access.target.id,
            body.allowPersonalPlugins,
            audit(context),
          );
          return yield* Schema.encodeUnknownEffect(
            UpdatePluginWorkspacePolicyResponseSchema,
          )({ status: "success", data: body });
        }),
      ),
    ),
  );

  router.patch("/:pluginId", (context) =>
    run(
      context,
      operation(context, (_db, access) =>
        Effect.gen(function* () {
          const id = yield* parsePluginId(context);
          const body = yield* decodeJsonBody(
            context.req,
            UpdatePluginStateRequestSchema,
            () => invalid("request", "Use enabled or activeVersion."),
          );
          if (Object.keys(body).length === 0) {
            return yield* invalid("request", "Change at least one field.");
          }
          yield* mutate(access);
          if (body.enabled !== false || body.activeVersion !== undefined) {
          }
          const service = yield* PluginService;
          yield* service.changeState(access.target, id, body, audit(context));
          const listed = yield* listData(access, context.get("principal"));
          const updated = listed.items.find((item) => item.id === id);
          if (updated === undefined) return yield* new PluginNotFound();
          return yield* Schema.encodeUnknownEffect(
            UpdatePluginStateResponseSchema,
          )({ status: "success", data: updated });
        }),
      ),
    ),
  );

  router.delete("/:pluginId", (context) =>
    run(
      context,
      operation(context, (_db, access) =>
        Effect.gen(function* () {
          const id = yield* parsePluginId(context);
          yield* mutate(access);
          const service = yield* PluginService;
          yield* service.remove(access.target, id, audit(context));
          return yield* Schema.encodeUnknownEffect(RemovePluginResponseSchema)({
            status: "success",
            data: { removedPluginId: id },
          });
        }),
      ),
    ),
  );
};

export const personalPluginRoutes = new Hono<AppEnv>();
registerRoutes(personalPluginRoutes, () => ({ mode: "personal" }));

export const workspacePluginRoutes = new Hono<AppEnv>();
registerRoutes(workspacePluginRoutes, (context) => ({
  mode: "workspace",
  workspaceSlug: context.req.param("workspaceSlug") ?? "",
}));
