import {
  GetProjectDefaultsResponseSchema,
  ProjectDefaultsConflictResponseSchema,
  ProjectDefaultsForbiddenResponseSchema,
  ProjectDefaultsInvalidRequestResponseSchema,
  ProjectDefaultsPersistenceUnavailableResponseSchema,
  ProjectDefaultsWorkspaceParamsSchema,
  RunnerProfileUnavailableResponseSchema,
  UpdatePersonalProjectDefaultsRequestSchema,
  UpdateProjectDefaultsResponseSchema,
  UpdateWorkspaceProjectDefaultsRequestSchema,
} from "@dx/api";
import {
  PersistenceUnavailable,
  ProjectDefaultsConflict,
  SettingsScopeForbidden,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Result, Schema } from "effect";
import { Hono, type Context } from "hono";
import {
  loadRunnerProfileCatalog,
  type LoadedRunnerProfileCatalog,
  RunnerProfileConfigurationUnavailable,
  RunnerProfileUnavailable,
} from "../../execution/runner-profiles/catalog.js";
import {
  decodeJsonBody,
  decodeRequestInput,
} from "../../http/request-decoding.js";
import type { AppEnv } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { PersonalAccountRepositoryD1 } from "../account/repository-d1.js";
import { SettingsAudit } from "../audit.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../workspace-policy/service.js";
import { ProjectDefaultsRepositoryD1 } from "./repository-d1.js";
import {
  ProjectDefaultsService,
  ProjectPolicyForbidden,
  type PersonalProjectDefaultsView,
  type WorkspaceProjectDefaultsView,
} from "./service.js";

class InvalidProjectDefaultsRequest extends Schema.TaggedError<InvalidProjectDefaultsRequest>()(
  "InvalidProjectDefaultsRequest",
  {},
) {}

export const projectDefaultsLayersFor = (db: D1Database) => {
  const d1 = D1Client.layer({ db });
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const account = PersonalAccountRepositoryD1.pipe(Layer.provide(d1));
  const defaults = ProjectDefaultsRepositoryD1.pipe(Layer.provide(d1));
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  const policies = WorkspacePolicyRepositoryD1(db);
  const policyService = WorkspacePolicyService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(workspace, settings, policies, SettingsAudit.layer),
    ),
  );
  return ProjectDefaultsService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workspace,
        account,
        defaults,
        policies,
        policyService,
        settings,
        SettingsAudit.layer,
      ),
    ),
  );
};

const responseData = (
  view: PersonalProjectDefaultsView | WorkspaceProjectDefaultsView,
  catalog: LoadedRunnerProfileCatalog,
) => ({
  scope: view.scope,
  revision: view.settings.revision,
  overrides: view.settings.overrides,
  resolved: view.resolved,
  catalog: catalog.publicCatalog,
  restrictions: view.restrictions,
  canUpdate: view.canUpdate,
  ...(view.scope === "workspace"
    ? { workspaceRole: view.workspaceRole, policy: view.settings.policy }
    : {}),
});

const failureResponse = (context: Context<AppEnv>, failure: unknown) => {
  const requestId = context.get("requestId");
  if (failure instanceof InvalidProjectDefaultsRequest) {
    return context.json(
      Schema.encodeUnknownSync(ProjectDefaultsInvalidRequestResponseSchema)({
        status: "error",
        data: {
          code: "INVALID_PROJECT_DEFAULTS",
          message: "Project defaults validation failed.",
          requestId,
        },
      }),
      400,
    );
  }
  if (
    failure instanceof SettingsScopeForbidden ||
    failure instanceof ProjectPolicyForbidden
  ) {
    return context.json(
      Schema.encodeUnknownSync(ProjectDefaultsForbiddenResponseSchema)({
        status: "error",
        data: {
          code: "PROJECT_DEFAULTS_FORBIDDEN",
          message: "The project defaults scope is unavailable for this user.",
          requestId,
        },
      }),
      403,
    );
  }
  if (failure instanceof ProjectDefaultsConflict) {
    return context.json(
      Schema.encodeUnknownSync(ProjectDefaultsConflictResponseSchema)({
        status: "error",
        data: {
          code: "PROJECT_DEFAULTS_CONFLICT",
          message: "Project defaults changed in another session.",
          requestId,
        },
      }),
      409,
    );
  }
  if (failure instanceof RunnerProfileUnavailable) {
    return context.json(
      Schema.encodeUnknownSync(RunnerProfileUnavailableResponseSchema)({
        status: "error",
        data: {
          code: "RUNNER_PROFILE_UNAVAILABLE",
          message: "The selected runner profile is unavailable.",
          requestId,
        },
      }),
      400,
    );
  }
  if (
    failure instanceof PersistenceUnavailable ||
    failure instanceof RunnerProfileConfigurationUnavailable
  ) {
    return context.json(
      Schema.encodeUnknownSync(
        ProjectDefaultsPersistenceUnavailableResponseSchema,
      )({
        status: "error",
        data: {
          code: "PERSISTENCE_UNAVAILABLE",
          message: "Project defaults are temporarily unavailable.",
          requestId,
        },
      }),
      503,
    );
  }
  throw failure;
};

const workspaceSlug = (context: Context<AppEnv>) =>
  decodeRequestInput(
    ProjectDefaultsWorkspaceParamsSchema,
    { workspaceSlug: context.req.param("workspaceSlug") },
    () => new InvalidProjectDefaultsRequest(),
  ).pipe(Effect.map(({ workspaceSlug }) => workspaceSlug));

export const personalProjectDefaultsRoutes = new Hono<AppEnv>();

personalProjectDefaultsRoutes.get("/", async (context) => {
  const operation = Effect.gen(function* () {
    const db = yield* decodeD1Binding(context.env.DB);
    const catalog = yield* loadRunnerProfileCatalog(context.env);
    const view = yield* Effect.gen(function* () {
      const service = yield* ProjectDefaultsService;
      return yield* service.getPersonal(context.get("principal"), catalog);
    }).pipe(Effect.provide(projectDefaultsLayersFor(db)));
    return yield* Schema.encodeUnknownEffect(GetProjectDefaultsResponseSchema)({
      status: "success",
      data: responseData(view, catalog),
    });
  });
  const result = await Effect.runPromise(Effect.result(operation));
  return Result.isSuccess(result)
    ? context.json(result.success, 200)
    : failureResponse(context, result.failure);
});

personalProjectDefaultsRoutes.put("/", async (context) => {
  const operation = Effect.gen(function* () {
    const input = yield* decodeJsonBody(
      context.req,
      UpdatePersonalProjectDefaultsRequestSchema,
      () => new InvalidProjectDefaultsRequest(),
    );
    const db = yield* decodeD1Binding(context.env.DB);
    const catalog = yield* loadRunnerProfileCatalog(context.env);
    const view = yield* Effect.gen(function* () {
      const service = yield* ProjectDefaultsService;
      return yield* service.putPersonal(
        context.get("principal"),
        catalog,
        input.overrides,
        input.expectedRevision,
        context.get("requestId"),
      );
    }).pipe(Effect.provide(projectDefaultsLayersFor(db)));
    return yield* Schema.encodeUnknownEffect(
      UpdateProjectDefaultsResponseSchema,
    )({ status: "success", data: responseData(view, catalog) });
  });
  const result = await Effect.runPromise(Effect.result(operation));
  return Result.isSuccess(result)
    ? context.json(result.success, 200)
    : failureResponse(context, result.failure);
});

export const workspaceProjectDefaultsRoutes = new Hono<AppEnv>();

workspaceProjectDefaultsRoutes.get("/", async (context) => {
  const operation = Effect.gen(function* () {
    const slug = yield* workspaceSlug(context);
    const db = yield* decodeD1Binding(context.env.DB);
    const catalog = yield* loadRunnerProfileCatalog(context.env);
    const view = yield* Effect.gen(function* () {
      const service = yield* ProjectDefaultsService;
      return yield* service.getWorkspace(
        context.get("principal"),
        slug,
        catalog,
      );
    }).pipe(Effect.provide(projectDefaultsLayersFor(db)));
    return yield* Schema.encodeUnknownEffect(GetProjectDefaultsResponseSchema)({
      status: "success",
      data: responseData(view, catalog),
    });
  });
  const result = await Effect.runPromise(Effect.result(operation));
  return Result.isSuccess(result)
    ? context.json(result.success, 200)
    : failureResponse(context, result.failure);
});

workspaceProjectDefaultsRoutes.put("/", async (context) => {
  const operation = Effect.gen(function* () {
    const slug = yield* workspaceSlug(context);
    const input = yield* decodeJsonBody(
      context.req,
      UpdateWorkspaceProjectDefaultsRequestSchema,
      () => new InvalidProjectDefaultsRequest(),
    );
    const db = yield* decodeD1Binding(context.env.DB);
    const catalog = yield* loadRunnerProfileCatalog(context.env);
    const view = yield* Effect.gen(function* () {
      const service = yield* ProjectDefaultsService;
      return yield* service.putWorkspace(
        context.get("principal"),
        slug,
        catalog,
        input.overrides,
        input.policy,
        input.expectedRevision,
        context.get("requestId"),
      );
    }).pipe(Effect.provide(projectDefaultsLayersFor(db)));
    return yield* Schema.encodeUnknownEffect(
      UpdateProjectDefaultsResponseSchema,
    )({ status: "success", data: responseData(view, catalog) });
  });
  const result = await Effect.runPromise(Effect.result(operation));
  return Result.isSuccess(result)
    ? context.json(result.success, 200)
    : failureResponse(context, result.failure);
});
