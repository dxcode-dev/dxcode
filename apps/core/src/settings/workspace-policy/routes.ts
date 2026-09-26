import {
  GetWorkspacePolicyResponseSchema,
  UpdateWorkspacePolicyRequestSchema,
  UpdateWorkspacePolicyResponseSchema,
  WorkspacePolicyConflictResponseSchema,
  WorkspacePolicyForbiddenResponseSchema,
  WorkspacePolicyInvalidRequestResponseSchema,
  WorkspacePolicyParamsSchema,
  WorkspacePolicyPersistenceUnavailableResponseSchema,
} from "@dx/api";
import {
  PersistenceUnavailable,
  SettingsScopeForbidden,
  WorkspacePolicyConflict,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import {
  type LoadedRunnerProfileCatalog,
  loadRunnerProfileCatalog,
  RunnerProfileConfigurationUnavailable,
} from "../../execution/runner-profiles/catalog.js";
import {
  decodeJsonBody,
  decodeRequestInput,
} from "../../http/request-decoding.js";
import type { AppEnv } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { SettingsAudit } from "../audit.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "./repository-d1.js";
import {
  InvalidWorkspacePolicy,
  WorkspacePolicyService,
  type WorkspacePolicyView,
} from "./service.js";

class InvalidWorkspacePolicyRequest extends Schema.TaggedError<InvalidWorkspacePolicyRequest>()(
  "InvalidWorkspacePolicyRequest",
  {},
) {}

const layersFor = (db: D1Database) => {
  const d1 = D1Client.layer({ db });
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  return WorkspacePolicyService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workspace,
        settings,
        WorkspacePolicyRepositoryD1(db),
        SettingsAudit.layer,
      ),
    ),
  );
};

const workspaceSlug = (context: Context<AppEnv>) =>
  decodeRequestInput(
    WorkspacePolicyParamsSchema,
    { workspaceSlug: context.req.param("workspaceSlug") },
    () => new InvalidWorkspacePolicyRequest(),
  ).pipe(Effect.map(({ workspaceSlug }) => workspaceSlug));

const responseData = (
  view: WorkspacePolicyView,
  runnerProfileCatalog: LoadedRunnerProfileCatalog["publicCatalog"],
) => ({
  revision: view.policy.revision,
  restrictions: view.policy.restrictions,
  runnerProfileCatalog,
  canUpdate: view.canUpdate,
  workspaceRole: view.workspaceRole,
});

const error = (
  context: Context<AppEnv>,
  schema: Schema.ConstraintEncoder<unknown>,
  status: 400 | 401 | 403 | 409 | 503,
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
  if (
    failure instanceof InvalidWorkspacePolicyRequest ||
    failure instanceof InvalidWorkspacePolicy
  ) {
    return error(
      context,
      WorkspacePolicyInvalidRequestResponseSchema,
      400,
      "INVALID_WORKSPACE_POLICY",
      "Workspace policy validation failed.",
    );
  }
  if (failure instanceof SettingsScopeForbidden) {
    return error(
      context,
      WorkspacePolicyForbiddenResponseSchema,
      403,
      "WORKSPACE_POLICY_FORBIDDEN",
      "This workspace policy action is not permitted.",
    );
  }
  if (failure instanceof WorkspacePolicyConflict) {
    return context.json(
      Schema.encodeUnknownSync(WorkspacePolicyConflictResponseSchema)({
        status: "error",
        data: {
          code: "WORKSPACE_POLICY_CONFLICT",
          message: "Workspace policy changed in another session.",
          requestId: context.get("requestId"),
          currentRevision: failure.currentRevision,
        },
      }),
      409,
    );
  }
  if (
    failure instanceof PersistenceUnavailable ||
    failure instanceof RunnerProfileConfigurationUnavailable
  ) {
    return error(
      context,
      WorkspacePolicyPersistenceUnavailableResponseSchema,
      503,
      "PERSISTENCE_UNAVAILABLE",
      "Workspace policy is temporarily unavailable.",
    );
  }
  throw failure;
};

const run = async <A, E>(
  context: Context<AppEnv>,
  operation: Effect.Effect<A, E>,
) => {
  const result = await Effect.runPromise(Effect.result(operation));
  return Result.isSuccess(result)
    ? context.json(result.success, 200)
    : failureResponse(context, result.failure);
};

export const workspacePolicyRoutes = new Hono<AppEnv>();

workspacePolicyRoutes.get("/", async (context) => {
  const operation = Effect.gen(function* () {
    const slug = yield* workspaceSlug(context);
    const db = yield* decodeD1Binding(context.env.DB);
    const catalog = yield* loadRunnerProfileCatalog(context.env);
    const view = yield* Effect.gen(function* () {
      const service = yield* WorkspacePolicyService;
      return yield* service.get(context.get("principal"), slug);
    }).pipe(Effect.provide(layersFor(db)));
    return yield* Schema.encodeUnknownEffect(GetWorkspacePolicyResponseSchema)({
      status: "success",
      data: responseData(view, catalog.publicCatalog),
    });
  });
  return run(context, operation);
});

workspacePolicyRoutes.put("/", async (context) => {
  const operation = Effect.gen(function* () {
    const slug = yield* workspaceSlug(context);
    const input = yield* decodeJsonBody(
      context.req,
      UpdateWorkspacePolicyRequestSchema,
      () => new InvalidWorkspacePolicyRequest(),
    );
    const db = yield* decodeD1Binding(context.env.DB);
    const catalog = yield* loadRunnerProfileCatalog(context.env);
    const layer = layersFor(db);
    const view = yield* Effect.gen(function* () {
      const service = yield* WorkspacePolicyService;
      return yield* service.update(
        context.get("principal"),
        slug,
        { restrictions: input.restrictions },
        input.expectedRevision,
        catalog.publicCatalog.profiles.flatMap((profile) =>
          profile.availability === "available" ? [profile.id] : [],
        ),
        context.get("requestId"),
      );
    }).pipe(Effect.provide(layer));
    return yield* Schema.encodeUnknownEffect(
      UpdateWorkspacePolicyResponseSchema,
    )({
      status: "success",
      data: responseData(view, catalog.publicCatalog),
    });
  });
  return run(context, operation);
});
