import {
  ExportSkillResponseSchema,
  ImportSkillRequestSchema,
  ImportSkillResponseSchema,
  ListSkillsResponseSchema,
  PreviewSkillRequestSchema,
  PreviewSkillResponseSchema,
  PublishSkillVersionRequestSchema,
  PublishSkillVersionResponseSchema,
  RemoveSkillResponseSchema,
  type SettingsFieldError,
  type SkillData,
  SkillIntegrityConflictResponseSchema,
  SkillLimitResponseSchema,
  SkillMcpReferenceInvalidResponseSchema,
  SkillNotFoundResponseSchema,
  SkillParamsSchema,
  SkillsForbiddenResponseSchema,
  SkillsInvalidRequestResponseSchema,
  SkillsUnavailableResponseSchema,
  UpdateSkillStateRequestSchema,
  UpdateSkillStateResponseSchema,
  UpdateSkillWorkspacePolicyRequestSchema,
  UpdateSkillWorkspacePolicyResponseSchema,
} from "@dx/api";
import {
  McpServerRepository,
  PersistenceUnavailable,
  type Principal,
  SettingsMembershipInvariantViolation,
  SettingsScopeForbidden,
  SkillIntegrityConflict,
  SkillLimitExceeded,
  SkillMcpReferenceInvalid,
  SkillNotFound,
  SkillRepository,
  type SkillTarget,
  type SkillWithVersion,
  WorkspaceSlug,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Option, Result, Schema } from "effect";
import { Hono, type Context } from "hono";
import {
  decodeJsonBody,
  decodeRequestInput,
} from "../../http/request-decoding.js";
import type { AppEnv } from "../../http/types.js";
import { authorizationLogger } from "../../logging.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { SettingsAudit } from "../audit.js";
import { McpServerRepositoryD1 } from "../mcp-servers/repository-d1.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { exportSkillVersion, SkillImportRejected } from "./import.js";
import { SkillRepositoryD1 } from "./repository-d1.js";
import { SkillService } from "./service.js";

class InvalidSkillRequest extends Schema.TaggedError<InvalidSkillRequest>()(
  "InvalidSkillRequest",
  {
    fieldErrors: Schema.Array(
      Schema.Struct({ field: Schema.String, message: Schema.String }),
    ),
  },
) {}

type RouteScope =
  | { readonly mode: "personal" }
  | { readonly mode: "workspace"; readonly workspaceSlug: string };

interface SkillAccess {
  readonly target: SkillTarget;
  readonly canMutate: boolean;
  readonly workspaceId?: string;
}

const fieldError = (field: string, message: string): SettingsFieldError => ({
  field,
  message,
});

const invalid = (field: string, message: string) =>
  new InvalidSkillRequest({ fieldErrors: [fieldError(field, message)] });

const layers = (db: D1Database) => {
  const d1 = D1Client.layer({ db });
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const skills = SkillRepositoryD1(db);
  const mcp = McpServerRepositoryD1(db);
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  const service = SkillService.layer.pipe(
    Layer.provide(Layer.mergeAll(skills, mcp, SettingsAudit.layer)),
  );
  return Layer.mergeAll(workspace, skills, mcp, settings, service);
};

const authorize = Effect.fn("authorizeSkills")(function* (
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
    } satisfies SkillAccess;
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
  } satisfies SkillAccess;
});

const resourceData = (
  resource: SkillWithVersion["active"]["resources"][number],
) => ({
  path: resource.path,
  mediaType: resource.mediaType,
  sizeBytes: resource.sizeBytes,
  integrity: resource.integrity,
});

const versionData = (version: SkillWithVersion["active"]) => ({
  version: version.version,
  manifest: version.manifest,
  instructions: version.instructions,
  resources: version.resources.map(resourceData),
  source: version.source,
  integrity: version.integrity,
  createdAt: version.createdAt,
});

const skillData = (
  value: SkillWithVersion,
  effectiveState: SkillData["effectiveState"],
  overridesPersonal: boolean,
): SkillData => ({
  id: value.skill.id,
  scope: value.skill.target.scope,
  name: value.skill.name,
  enabled: value.skill.enabled,
  activeVersion: value.skill.activeVersion,
  pinned: value.skill.pinned,
  versions: value.versions,
  active: versionData(value.active),
  effectiveState,
  overridesPersonal,
  createdAt: value.skill.createdAt,
  updatedAt: value.skill.updatedAt,
});

const listData = Effect.fn("skillsListData")(function* (
  access: SkillAccess,
  principal: Principal,
) {
  const repository = yield* SkillRepository;
  const items = yield* repository.list(access.target);
  let allowPersonalSkills: boolean | undefined;
  let counterparts: ReadonlyArray<SkillWithVersion> = [];
  if (access.workspaceId !== undefined) {
    allowPersonalSkills = yield* repository.getWorkspacePolicy(
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
          candidate.skill.enabled && candidate.skill.name === item.skill.name,
      );
      const state: SkillData["effectiveState"] = !item.skill.enabled
        ? "disabled"
        : item.skill.target.scope === "personal" &&
            allowPersonalSkills === false
          ? "blocked-by-policy"
          : item.skill.target.scope === "personal" && conflict
            ? "blocked-by-workspace"
            : "effective";
      return skillData(
        item,
        state,
        item.skill.target.scope === "workspace" && conflict,
      );
    }),
    canMutate: access.canMutate,
    precedence: "workspace-over-personal" as const,
    ...(allowPersonalSkills === undefined ? {} : { allowPersonalSkills }),
  };
});

const parseSkillId = (context: Context<AppEnv>) =>
  decodeRequestInput(
    SkillParamsSchema,
    { skillId: context.req.param("skillId") },
    () => invalid("skillId", "Use a valid skill identifier."),
  ).pipe(Effect.map(({ skillId }) => skillId));

const failureResponse = (context: Context<AppEnv>, failure: unknown) => {
  const requestId = context.get("requestId");
  const response = (
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
  if (
    failure instanceof InvalidSkillRequest ||
    failure instanceof SkillImportRejected
  ) {
    const fieldErrors =
      failure instanceof SkillImportRejected
        ? [fieldError(failure.field, failure.reason)]
        : failure.fieldErrors;
    return context.json(
      Schema.encodeUnknownSync(SkillsInvalidRequestResponseSchema)({
        status: "error",
        data: {
          code: "INVALID_SKILL_REQUEST",
          message: "Skill validation failed.",
          requestId,
          fieldErrors,
        },
      }),
      400,
    );
  }
  if (failure instanceof SettingsScopeForbidden) {
    authorizationLogger.warn("Skill scope authorization failed.", {
      event: "skill_scope_authorization_failed",
      requestId,
    });
    return response(
      SkillsForbiddenResponseSchema,
      403,
      "SETTINGS_SCOPE_FORBIDDEN",
      "The settings scope is unavailable for this user.",
    );
  }
  if (failure instanceof SkillNotFound) {
    return response(
      SkillNotFoundResponseSchema,
      404,
      "SKILL_NOT_FOUND",
      "Skill not found.",
    );
  }
  if (failure instanceof SkillLimitExceeded) {
    return response(
      SkillLimitResponseSchema,
      409,
      "SKILL_LIMIT_EXCEEDED",
      "This scope has reached its skill limit.",
    );
  }
  if (failure instanceof SkillIntegrityConflict) {
    return response(
      SkillIntegrityConflictResponseSchema,
      409,
      "SKILL_INTEGRITY_CONFLICT",
      "The reviewed skill content no longer matches or conflicts with an immutable version.",
    );
  }
  if (failure instanceof SkillMcpReferenceInvalid) {
    return response(
      SkillMcpReferenceInvalidResponseSchema,
      409,
      "SKILL_MCP_REFERENCE_INVALID",
      "Every MCP dependency must be enabled and have a currently reviewed tool in this scope.",
    );
  }
  if (
    failure instanceof PersistenceUnavailable ||
    failure instanceof SettingsMembershipInvariantViolation ||
    Schema.isSchemaError(failure)
  ) {
    return response(
      SkillsUnavailableResponseSchema,
      503,
      "SKILLS_UNAVAILABLE",
      "Skills are temporarily unavailable.",
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
      access: SkillAccess,
    ) => Effect.Effect<A, E, R | SkillService | SkillRepository>,
  ) =>
    Effect.gen(function* () {
      const db = yield* decodeD1Binding(context.env.DB);
      const access = yield* authorize(
        routeFor(context),
        context.get("principal"),
      ).pipe(Effect.provide(layers(db)));
      return yield* use(db, access).pipe(Effect.provide(layers(db)));
    });
  const mutate = (access: SkillAccess) =>
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
          return yield* Schema.encodeUnknownEffect(ListSkillsResponseSchema)({
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
            PreviewSkillRequestSchema,
          )(raw).pipe(
            Effect.mapError(() =>
              invalid("files", "Use a supported browser-file bundle."),
            ),
          );
          const service = yield* SkillService;
          const preview = yield* service.preview(body);
          return yield* Schema.encodeUnknownEffect(PreviewSkillResponseSchema)({
            status: "success",
            data: {
              ...preview,
              resources: preview.resources.map(resourceData),
            },
          });
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
            ImportSkillRequestSchema,
            () => invalid("request", "Use bundle and reviewedIntegrity."),
          );
          yield* mutate(access);
          const service = yield* SkillService;
          yield* service.create(
            access.target,
            body.bundle,
            body.reviewedIntegrity,
            audit(context),
          );
          const listed = yield* listData(access, context.get("principal"));
          const created = listed.items.find(
            ({ active }) => active.integrity === body.reviewedIntegrity,
          );
          if (created === undefined) return yield* new SkillNotFound();
          return yield* Schema.encodeUnknownEffect(ImportSkillResponseSchema)({
            status: "success",
            data: created,
          });
        }),
      ),
      201,
    ),
  );

  router.post("/:skillId/versions", (context) =>
    run(
      context,
      operation(context, (_db, access) =>
        Effect.gen(function* () {
          const id = yield* parseSkillId(context);
          const body = yield* decodeJsonBody(
            context.req,
            PublishSkillVersionRequestSchema,
            () =>
              invalid(
                "request",
                "Use bundle, reviewedIntegrity, and activate.",
              ),
          );
          yield* mutate(access);
          const service = yield* SkillService;
          yield* service.update(
            access.target,
            id,
            body.bundle,
            body.reviewedIntegrity,
            body.activate,
            audit(context),
          );
          const listed = yield* listData(access, context.get("principal"));
          const updated = listed.items.find((item) => item.id === id);
          if (updated === undefined) return yield* new SkillNotFound();
          return yield* Schema.encodeUnknownEffect(
            PublishSkillVersionResponseSchema,
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
            UpdateSkillWorkspacePolicyRequestSchema,
            () => invalid("request", "Use allowPersonalSkills."),
          );
          yield* mutate(access);
          if (access.target.scope !== "workspace") {
            return yield* new SettingsScopeForbidden({ scope: "workspace" });
          }
          const service = yield* SkillService;
          yield* service.setWorkspacePolicy(
            access.target.id,
            body.allowPersonalSkills,
            audit(context),
          );
          return yield* Schema.encodeUnknownEffect(
            UpdateSkillWorkspacePolicyResponseSchema,
          )({ status: "success", data: body });
        }),
      ),
    ),
  );

  router.patch("/:skillId", (context) =>
    run(
      context,
      operation(context, (_db, access) =>
        Effect.gen(function* () {
          const id = yield* parseSkillId(context);
          const body = yield* decodeJsonBody(
            context.req,
            UpdateSkillStateRequestSchema,
            () => invalid("request", "Use enabled, activeVersion, or pinned."),
          );
          if (Object.keys(body).length === 0) {
            return yield* invalid("request", "Change at least one field.");
          }
          yield* mutate(access);
          const service = yield* SkillService;
          yield* service.changeState(access.target, id, body, audit(context));
          const listed = yield* listData(access, context.get("principal"));
          const updated = listed.items.find((item) => item.id === id);
          if (updated === undefined) return yield* new SkillNotFound();
          return yield* Schema.encodeUnknownEffect(
            UpdateSkillStateResponseSchema,
          )({ status: "success", data: updated });
        }),
      ),
    ),
  );

  router.get("/:skillId/export", (context) =>
    run(
      context,
      operation(context, (_db, access) =>
        Effect.gen(function* () {
          const id = yield* parseSkillId(context);
          const service = yield* SkillService;
          const version = yield* service.exportVersion(access.target, id);
          const exported = exportSkillVersion(version);
          return yield* Schema.encodeUnknownEffect(ExportSkillResponseSchema)({
            status: "success",
            data: {
              source: exported.source,
              integrity: version.integrity,
              files: exported.files,
            },
          });
        }),
      ),
    ),
  );

  router.delete("/:skillId", (context) =>
    run(
      context,
      operation(context, (_db, access) =>
        Effect.gen(function* () {
          const id = yield* parseSkillId(context);
          yield* mutate(access);
          const service = yield* SkillService;
          yield* service.remove(access.target, id, audit(context));
          return yield* Schema.encodeUnknownEffect(RemoveSkillResponseSchema)({
            status: "success",
            data: { removedSkillId: id },
          });
        }),
      ),
    ),
  );
};

export const personalSkillRoutes = new Hono<AppEnv>();
registerRoutes(personalSkillRoutes, () => ({ mode: "personal" }));

export const workspaceSkillRoutes = new Hono<AppEnv>();
registerRoutes(workspaceSkillRoutes, (context) => ({
  mode: "workspace",
  workspaceSlug: context.req.param("workspaceSlug") ?? "",
}));
