import {
  ExportWorkspaceUsageAuditResponseSchema,
  ExportWorkspaceUsageResponseSchema,
  GetWorkspaceUsageResponseSchema,
  InspectWorkspacePrivateThreadRequestSchema,
  InspectWorkspacePrivateThreadResponseSchema,
  ListWorkspaceUsageAuditResponseSchema,
  WorkspacePrivateInspectionForbiddenResponseSchema,
  WorkspacePrivateInspectionUnavailableResponseSchema,
  WorkspaceUsageAuditQuerySchema,
  WorkspaceUsageInvalidRequestResponseSchema,
  WorkspaceUsageParamsSchema,
  WorkspaceUsagePermissionForbiddenResponseSchema,
  WorkspaceUsagePersistenceUnavailableResponseSchema,
  WorkspaceUsageQuerySchema,
  WorkspaceUsageResourceForbiddenResponseSchema,
  WorkspaceUsageScopeForbiddenResponseSchema,
} from "@dx/api";
import {
  InvalidUsageQuery,
  InvalidWorkspacePrivateThreadInspectionReason,
  PersistenceUnavailable,
  SettingsScopeForbidden,
  UsageResourceForbidden,
  WorkspacePermissionForbidden,
  WorkspacePrivateThreadInspectionForbidden,
  WorkspacePrivateThreadInspectionUnavailable,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import {
  decodeJsonBody,
  decodeRequestInput,
} from "../../http/request-decoding.js";
import type { AppEnv } from "../../http/types.js";
import { authorizationLogger } from "../../logging.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { WorkspaceUsageAuditRepositoryD1 } from "./audit-repository-d1.js";
import { UsageRepositoryD1 } from "./repository-d1.js";
import { WorkspaceUsageService } from "./workspace-service.js";

class InvalidWorkspaceUsageRequest extends Schema.TaggedError<InvalidWorkspaceUsageRequest>()(
  "InvalidWorkspaceUsageRequest",
  {},
) {}

const servicesFor = (db: D1Database) => {
  const workspaceRepository = WorkspaceRepositoryD1(db).pipe(
    Layer.provide(D1Client.layer({ db })),
  );
  const settings = SettingsService.layer.pipe(
    Layer.provide(workspaceRepository),
  );
  return WorkspaceUsageService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        settings,
        UsageRepositoryD1(db),
        WorkspaceUsageAuditRepositoryD1(db),
      ),
    ),
  );
};

const decode = <S extends Schema.Constraint>(schema: S, input: unknown) =>
  decodeRequestInput(schema, input, () => new InvalidWorkspaceUsageRequest());

const error = (
  context: Context<AppEnv>,
  schema: Schema.ConstraintEncoder<unknown>,
  status: 400 | 401 | 403 | 404 | 503,
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
    failure instanceof InvalidWorkspaceUsageRequest ||
    failure instanceof InvalidUsageQuery ||
    failure instanceof InvalidWorkspacePrivateThreadInspectionReason
  ) {
    return error(
      context,
      WorkspaceUsageInvalidRequestResponseSchema,
      400,
      "INVALID_WORKSPACE_USAGE_REQUEST",
      "Workspace usage request validation failed.",
    );
  }
  if (failure instanceof SettingsScopeForbidden) {
    authorizationLogger.warn("Workspace usage scope authorization failed.", {
      event: "workspace_usage_scope_authorization_failed",
      requestId: context.get("requestId"),
    });
    return error(
      context,
      WorkspaceUsageScopeForbiddenResponseSchema,
      403,
      "SETTINGS_SCOPE_FORBIDDEN",
      "The settings scope is unavailable for this user.",
    );
  }
  if (failure instanceof WorkspacePermissionForbidden) {
    authorizationLogger.warn("Workspace usage permission denied.", {
      event: "workspace_usage_permission_denied",
      permission: failure.permission,
      requestId: context.get("requestId"),
    });
    return error(
      context,
      WorkspaceUsagePermissionForbiddenResponseSchema,
      403,
      "WORKSPACE_PERMISSION_FORBIDDEN",
      "This workspace usage action is not permitted.",
    );
  }
  if (failure instanceof UsageResourceForbidden) {
    return error(
      context,
      WorkspaceUsageResourceForbiddenResponseSchema,
      403,
      "USAGE_RESOURCE_FORBIDDEN",
      "The requested usage resource is unavailable in this workspace.",
    );
  }
  if (failure instanceof WorkspacePrivateThreadInspectionForbidden) {
    authorizationLogger.warn("Private Thread inspection permission denied.", {
      event: "workspace_private_thread_inspection_denied",
      requestId: context.get("requestId"),
    });
    return error(
      context,
      WorkspacePrivateInspectionForbiddenResponseSchema,
      403,
      "PRIVATE_THREAD_INSPECTION_FORBIDDEN",
      "Private Thread inspection requires the explicit Auditor role.",
    );
  }
  if (failure instanceof WorkspacePrivateThreadInspectionUnavailable) {
    return error(
      context,
      WorkspacePrivateInspectionUnavailableResponseSchema,
      404,
      "PRIVATE_THREAD_INSPECTION_UNAVAILABLE",
      "The requested private Thread is unavailable for inspection.",
    );
  }
  if (failure instanceof PersistenceUnavailable) {
    return error(
      context,
      WorkspaceUsagePersistenceUnavailableResponseSchema,
      503,
      "PERSISTENCE_UNAVAILABLE",
      "Workspace usage is temporarily unavailable.",
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

const operation = (
  context: Context<AppEnv>,
  mode: "dashboard" | "export" | "audit" | "audit-export",
) =>
  Effect.gen(function* () {
    const params = yield* decode(
      WorkspaceUsageParamsSchema,
      context.req.param(),
    );
    const query = yield* decode(
      mode === "audit" || mode === "audit-export"
        ? WorkspaceUsageAuditQuerySchema
        : WorkspaceUsageQuerySchema,
      context.req.query(),
    );
    const db = yield* decodeD1Binding(context.env.DB);
    return yield* Effect.gen(function* () {
      const service = yield* WorkspaceUsageService;
      const principal = context.get("principal");
      if (mode === "dashboard") {
        const data = yield* service.get(
          principal,
          params.workspaceSlug,
          query as never,
        );
        return yield* Schema.encodeUnknownEffect(
          GetWorkspaceUsageResponseSchema,
        )({
          status: "success",
          data,
        });
      }
      if (mode === "export") {
        const data = yield* service.exportCsv(
          principal,
          params.workspaceSlug,
          query as never,
        );
        return yield* Schema.encodeUnknownEffect(
          ExportWorkspaceUsageResponseSchema,
        )({ status: "success", data });
      }
      if (mode === "audit") {
        const data = yield* service.listAudit(
          principal,
          params.workspaceSlug,
          query as never,
        );
        const items = data.items.map(({ workspaceId: _, ...item }) => item);
        return yield* Schema.encodeUnknownEffect(
          ListWorkspaceUsageAuditResponseSchema,
        )({ status: "success", data: { ...data, items } });
      }
      const data = yield* service.exportAuditCsv(
        principal,
        params.workspaceSlug,
        query as never,
      );
      return yield* Schema.encodeUnknownEffect(
        ExportWorkspaceUsageAuditResponseSchema,
      )({ status: "success", data });
    }).pipe(Effect.provide(servicesFor(db)));
  });

const inspectOperation = (context: Context<AppEnv>) =>
  Effect.gen(function* () {
    const params = yield* decode(
      WorkspaceUsageParamsSchema,
      context.req.param(),
    );
    const input = yield* decodeJsonBody(
      context.req,
      InspectWorkspacePrivateThreadRequestSchema,
      () => new InvalidWorkspaceUsageRequest(),
    );
    const db = yield* decodeD1Binding(context.env.DB);
    return yield* Effect.gen(function* () {
      const service = yield* WorkspaceUsageService;
      const data = yield* service.inspectPrivateThread(
        context.get("principal"),
        params.workspaceSlug,
        input,
      );
      return yield* Schema.encodeUnknownEffect(
        InspectWorkspacePrivateThreadResponseSchema,
      )({ status: "success", data });
    }).pipe(Effect.provide(servicesFor(db)));
  });

export const workspaceUsageRoutes = new Hono<AppEnv>();

workspaceUsageRoutes.get("/", (context) =>
  run(context, operation(context, "dashboard")),
);
workspaceUsageRoutes.get("/export", (context) =>
  run(context, operation(context, "export")),
);
workspaceUsageRoutes.post("/private-inspections", (context) =>
  run(context, inspectOperation(context)),
);
workspaceUsageRoutes.get("/audit", (context) =>
  run(context, operation(context, "audit")),
);
workspaceUsageRoutes.get("/audit/export", (context) =>
  run(context, operation(context, "audit-export")),
);
