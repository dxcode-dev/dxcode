import {
  InstallPluginBundleResponseSchema,
  ListPluginBundlesResponseSchema,
  type PluginBundleData,
  PluginBundleIntegrityConflictResponseSchema,
  PluginBundleNotFoundResponseSchema,
  PluginBundleParamsSchema,
  PluginBundleRejectedResponseSchema,
  PluginBundleSourceUnavailableResponseSchema,
  PluginBundlesForbiddenResponseSchema,
  PluginBundlesUnavailableResponseSchema,
  PreviewPluginBundleResponseSchema,
  RemovePluginBundleResponseSchema,
  UpdatePluginBundleRequestSchema,
  UpdatePluginBundleResponseSchema,
} from "@dx/api";
import {
  MAX_PLUGIN_ARCHIVE_BYTES,
  McpServerLimitExceeded,
  McpServerRepository,
  type McpServerTarget,
  PersistenceUnavailable,
  PluginBundleRepository,
  PluginBundleSource,
  PluginIntegrity,
  PluginIntegrityConflict,
  PluginNotFound,
  type PluginTarget,
  type Principal,
  SettingsMembershipInvariantViolation,
  SettingsScopeForbidden,
  SkillLimitExceeded,
  SkillRepository,
  type StoredPluginBundle,
  WorkspaceSlug,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Option, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import {
  decodeJsonBody,
  decodeRequestInput,
} from "../../../http/request-decoding.js";
import type { AppEnv } from "../../../http/types.js";
import { authorizationLogger } from "../../../logging.js";
import { decodeD1Binding } from "../../../persistence/d1-binding.js";
import { SettingsAudit } from "../../audit.js";
import { EnvironmentVariableRepositoryD1 } from "../../environment-variables/repository-d1.js";
import { McpServerRepositoryD1 } from "../../mcp-servers/repository-d1.js";
import {
  McpModuleIdTaken,
  McpServerService,
} from "../../mcp-servers/service.js";
import { SettingsService } from "../../service.js";
import { SkillImportRejected } from "../../skills/import.js";
import { SkillRepositoryD1 } from "../../skills/repository-d1.js";
import { SkillService } from "../../skills/service.js";
import { WorkspaceRepositoryD1 } from "../../workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../../workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../../workspace-policy/service.js";
import {
  PluginBundleRejected,
  PluginBundleSourceUnavailable,
} from "./errors.js";
import { PluginBundleRepositoryD1 } from "./repository-d1.js";
import { type PluginBundleInput, PluginBundleService } from "./service.js";

type RouteScope =
  | { readonly mode: "personal" }
  | { readonly mode: "workspace"; readonly workspaceSlug: string };

interface BundleAccess {
  readonly target: PluginTarget;
  readonly canMutate: boolean;
}

const layers = (db: D1Database) => {
  const d1 = D1Client.layer({ db });
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  const environment = EnvironmentVariableRepositoryD1(db);
  const mcp = McpServerRepositoryD1(db);
  const skills = SkillRepositoryD1(db);
  const bundles = PluginBundleRepositoryD1(db);
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
  const mcpService = McpServerService.layer.pipe(
    Layer.provide(Layer.mergeAll(environment, mcp, SettingsAudit.layer)),
  );
  const skillService = SkillService.layer.pipe(
    Layer.provide(Layer.mergeAll(skills, mcp, SettingsAudit.layer)),
  );
  const service = PluginBundleService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        bundles,
        skills,
        skillService,
        mcp,
        mcpService,
        policy,
        SettingsAudit.layer,
      ),
    ),
  );
  return Layer.mergeAll(workspace, settings, bundles, skills, mcp, service);
};

const authorize = Effect.fn("authorizePluginBundles")(function* (
  route: RouteScope,
  principal: Principal,
) {
  const settings = yield* SettingsService;
  if (route.mode === "personal") {
    yield* settings.personal(principal);
    return {
      target: { scope: "personal", id: principal.userId },
      canMutate: true,
    } satisfies BundleAccess;
  }
  const slug = Schema.decodeOption(WorkspaceSlug)(route.workspaceSlug);
  if (Option.isNone(slug)) {
    return yield* new SettingsScopeForbidden({ scope: "workspace" });
  }
  const access = yield* settings.workspace(principal, slug.value);
  return {
    target: { scope: "workspace", id: access.workspace.workspace.id },
    canMutate: access.workspace.role !== "member",
  } satisfies BundleAccess;
});

/** One bundle with the skills and MCP servers it installed. */
const bundleData = Effect.fn("pluginBundleData")(function* (
  bundle: StoredPluginBundle,
) {
  const skills = yield* SkillRepository;
  const mcp = yield* McpServerRepository;
  const installedSkills = (yield* skills.list(bundle.target)).filter(
    ({ skill }) => skill.pluginId === bundle.id,
  );
  const installedServers = (yield* mcp.list(
    bundle.target as McpServerTarget,
  )).filter(({ server }) => server.pluginId === bundle.id);
  return {
    id: bundle.id,
    scope: bundle.target.scope,
    name: bundle.name,
    displayName: bundle.manifest.displayName,
    description: bundle.manifest.description,
    ...(bundle.manifest.version === undefined
      ? {}
      : { version: bundle.manifest.version }),
    enabled: bundle.enabled,
    source: bundle.source,
    integrity: bundle.integrity,
    skills: installedSkills.map(({ skill }) => ({
      id: skill.id,
      name: skill.name,
      enabled: skill.enabled,
    })),
    mcpServers: installedServers.map(({ server, tools }) => ({
      id: server.id,
      name: server.name,
      endpoint: server.endpoint,
      reviewed: tools.some(
        (tool) =>
          tool.approvedSchemaHash !== undefined &&
          tool.approvedSchemaHash === tool.schemaHash,
      ),
    })),
    skipped: bundle.manifest.skipped,
    installedAt: bundle.installedAt,
    updatedAt: bundle.updatedAt,
  } satisfies PluginBundleData;
});

const rejected = (reason: string) => new PluginBundleRejected({ reason });

const readZipBody = (request: Request) =>
  Effect.tryPromise({
    try: async () => {
      const declared = Number(request.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_PLUGIN_ARCHIVE_BYTES) {
        return "too-large" as const;
      }
      const reader = request.body?.getReader();
      if (reader === undefined) return new Uint8Array();
      const chunks: Array<Uint8Array> = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_PLUGIN_ARCHIVE_BYTES) {
          await reader.cancel().catch(() => undefined);
          return "too-large" as const;
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let position = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, position);
        position += chunk.byteLength;
      }
      return bytes;
    },
    catch: () => rejected("The upload was interrupted. Try again."),
  }).pipe(
    Effect.flatMap((bytes) =>
      bytes === "too-large"
        ? Effect.fail(
            rejected(
              `The archive is larger than ${MAX_PLUGIN_ARCHIVE_BYTES.toLocaleString("en-US")} bytes.`,
            ),
          )
        : Effect.succeed(bytes),
    ),
  );

const isZip = (context: Context<AppEnv>) =>
  /^application\/(?:zip|x-zip-compressed|octet-stream)\b/i.test(
    context.req.header("content-type") ?? "",
  );

const PreviewGitHubRequest = Schema.Struct({ url: Schema.String });

const InstallGitHubRequest = Schema.Struct({
  source: PluginBundleSource,
  reviewedIntegrity: PluginIntegrity,
});

/**
 * A ZIP upload is the request body, named by `?name=`; a GitHub URL is JSON.
 * Installing a ZIP repeats the upload with `?integrity=`, and installing from
 * GitHub sends the previewed source, pinned to its commit.
 */
const previewInput = (context: Context<AppEnv>) =>
  isZip(context)
    ? readZipBody(context.req.raw).pipe(
        Effect.map(
          (bytes): PluginBundleInput => ({
            type: "zip",
            label: context.req.query("name") ?? "plugin.zip",
            bytes,
          }),
        ),
      )
    : decodeJsonBody(context.req, PreviewGitHubRequest, () =>
        rejected("Send a ZIP archive or a GitHub URL."),
      ).pipe(
        Effect.map(
          ({ url }): PluginBundleInput => ({ type: "github-url", url }),
        ),
      );

const installInput = (context: Context<AppEnv>) =>
  isZip(context)
    ? Effect.gen(function* () {
        const integrity = yield* decodeRequestInput(
          PluginIntegrity,
          context.req.query("integrity"),
          () => rejected("Preview the archive before installing it."),
        );
        const input = yield* previewInput(context);
        return { input, integrity };
      })
    : decodeJsonBody(context.req, InstallGitHubRequest, () =>
        rejected("Preview the plugin before installing it."),
      ).pipe(
        Effect.flatMap(({ source, reviewedIntegrity }) =>
          source.type === "github"
            ? Effect.succeed({
                input: { type: "github-commit", source } as PluginBundleInput,
                integrity: reviewedIntegrity,
              })
            : Effect.fail(
                rejected("Upload the ZIP archive again to install it."),
              ),
        ),
      );

const failureResponse = (context: Context<AppEnv>, failure: unknown) => {
  const requestId = context.get("requestId");
  const fixed = (
    schema: Schema.ConstraintEncoder<unknown>,
    status: 403 | 404 | 409 | 503,
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
  if (failure instanceof PluginBundleRejected) {
    return context.json(
      Schema.encodeUnknownSync(PluginBundleRejectedResponseSchema)({
        status: "error",
        data: {
          code: "PLUGIN_BUNDLE_REJECTED",
          message: failure.reason,
          requestId,
        },
      }),
      400,
    );
  }
  if (failure instanceof PluginBundleSourceUnavailable) {
    return context.json(
      Schema.encodeUnknownSync(PluginBundleSourceUnavailableResponseSchema)({
        status: "error",
        data: {
          code: "PLUGIN_BUNDLE_SOURCE_UNAVAILABLE",
          message: failure.reason,
          requestId,
        },
      }),
      502,
    );
  }
  if (failure instanceof SettingsScopeForbidden) {
    authorizationLogger.warn("Plugin bundle scope authorization failed.", {
      event: "plugin_bundle_scope_authorization_failed",
      requestId,
    });
    return fixed(
      PluginBundlesForbiddenResponseSchema,
      403,
      "SETTINGS_SCOPE_FORBIDDEN",
      "The settings scope is unavailable for this user.",
    );
  }
  if (failure instanceof PluginNotFound) {
    return fixed(
      PluginBundleNotFoundResponseSchema,
      404,
      "PLUGIN_NOT_FOUND",
      "Plugin not found.",
    );
  }
  if (failure instanceof PluginIntegrityConflict) {
    return fixed(
      PluginBundleIntegrityConflictResponseSchema,
      409,
      "PLUGIN_INTEGRITY_CONFLICT",
      "The plugin changed since you reviewed it. Preview it again.",
    );
  }
  if (
    failure instanceof PersistenceUnavailable ||
    failure instanceof SettingsMembershipInvariantViolation ||
    Schema.isSchemaError(failure)
  ) {
    return fixed(
      PluginBundlesUnavailableResponseSchema,
      503,
      "PLUGINS_UNAVAILABLE",
      "Plugins are temporarily unavailable.",
    );
  }
  // A skill or MCP server the bundle installs can be refused by its store.
  const refusal =
    failure instanceof SkillImportRejected
      ? failure.reason
      : failure instanceof SkillLimitExceeded
        ? "Skills in this scope are at their limit."
        : failure instanceof McpServerLimitExceeded
          ? "MCP servers in this scope are at their limit."
          : failure instanceof McpModuleIdTaken
            ? "An MCP server with the same ID already exists."
            : undefined;
  if (refusal !== undefined) {
    return context.json(
      Schema.encodeUnknownSync(PluginBundleRejectedResponseSchema)({
        status: "error",
        data: { code: "PLUGIN_BUNDLE_REJECTED", message: refusal, requestId },
      }),
      400,
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
    use: (access: BundleAccess) => Effect.Effect<A, E, R>,
    options: { readonly mutate: boolean },
  ) =>
    Effect.gen(function* () {
      const db = yield* decodeD1Binding(context.env.DB);
      return yield* Effect.gen(function* () {
        const access = yield* authorize(
          routeFor(context),
          context.get("principal"),
        );
        if (options.mutate && !access.canMutate) {
          return yield* new SettingsScopeForbidden({ scope: "workspace" });
        }
        return yield* use(access);
      }).pipe(Effect.provide(layers(db)));
    });
  const audit = (context: Context<AppEnv>) => ({
    userId: context.get("principal").userId,
    requestId: context.get("requestId"),
  });
  const parseId = (context: Context<AppEnv>) =>
    decodeRequestInput(
      PluginBundleParamsSchema,
      { pluginId: context.req.param("pluginId") },
      () => new PluginNotFound(),
    ).pipe(Effect.map(({ pluginId }) => pluginId));

  router.get("/", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const repository = yield* PluginBundleRepository;
            const bundles = yield* repository.list(access.target);
            const items = yield* Effect.all(bundles.map(bundleData));
            return yield* Schema.encodeUnknownEffect(
              ListPluginBundlesResponseSchema,
            )({
              status: "success",
              data: { items, canMutate: access.canMutate },
            });
          }),
        { mutate: false },
      ),
    ),
  );

  router.post("/preview", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const input = yield* previewInput(context);
            const service = yield* PluginBundleService;
            const preview = yield* service.preview(access.target, input);
            return yield* Schema.encodeUnknownEffect(
              PreviewPluginBundleResponseSchema,
            )({
              status: "success",
              data: {
                manifest: preview.bundle.manifest,
                source: preview.source,
                integrity: preview.bundle.integrity,
                conflicts: preview.conflicts,
              },
            });
          }),
        { mutate: true },
      ),
    ),
  );

  router.post("/", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const { input, integrity } = yield* installInput(context);
            const service = yield* PluginBundleService;
            const installed = yield* service.install(
              access.target,
              input,
              integrity,
              audit(context),
            );
            return yield* Schema.encodeUnknownEffect(
              InstallPluginBundleResponseSchema,
            )({ status: "success", data: yield* bundleData(installed) });
          }),
        { mutate: true },
      ),
      201,
    ),
  );

  router.patch("/:pluginId", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const id = yield* parseId(context);
            const body = yield* decodeJsonBody(
              context.req,
              UpdatePluginBundleRequestSchema,
              () => rejected("Send enabled: true or false."),
            );
            const service = yield* PluginBundleService;
            yield* service.setEnabled(
              access.target,
              id,
              body.enabled,
              audit(context),
            );
            const repository = yield* PluginBundleRepository;
            const updated = yield* repository.find(access.target, id);
            return yield* Schema.encodeUnknownEffect(
              UpdatePluginBundleResponseSchema,
            )({ status: "success", data: yield* bundleData(updated) });
          }),
        { mutate: true },
      ),
    ),
  );

  router.delete("/:pluginId", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const id = yield* parseId(context);
            const service = yield* PluginBundleService;
            yield* service.remove(access.target, id, audit(context));
            return yield* Schema.encodeUnknownEffect(
              RemovePluginBundleResponseSchema,
            )({ status: "success", data: { removedPluginId: id } });
          }),
        { mutate: true },
      ),
    ),
  );
};

export const personalPluginBundleRoutes = new Hono<AppEnv>();
registerRoutes(personalPluginBundleRoutes, () => ({ mode: "personal" }));

export const workspacePluginBundleRoutes = new Hono<AppEnv>();
registerRoutes(workspacePluginBundleRoutes, (context) => ({
  mode: "workspace",
  workspaceSlug: context.req.param("workspaceSlug") ?? "",
}));
