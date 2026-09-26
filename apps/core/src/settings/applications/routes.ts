import {
  CreateExternalApiApplicationRequestSchema,
  CreateExternalApiApplicationResponseSchema,
  ExternalApiApplicationNotFoundResponseSchema,
  ExternalApiApplicationParamsSchema,
  ExternalApiApplicationsInvalidRequestResponseSchema,
  ExternalApiApplicationsParamsSchema,
  ExternalApiApplicationsPermissionForbiddenResponseSchema,
  ExternalApiApplicationsPersistenceUnavailableResponseSchema,
  ExternalApiApplicationsScopeForbiddenResponseSchema,
  ExternalApiApplicationUnsupportedScopeResponseSchema,
  ListExternalApiApplicationAuditQuerySchema,
  ListExternalApiApplicationAuditResponseSchema,
  ListExternalApiApplicationsQuerySchema,
  ListExternalApiApplicationsResponseSchema,
  RevokeExternalApiApplicationResponseSchema,
  RotateExternalApiApplicationRequestSchema,
  RotateExternalApiApplicationResponseSchema,
  SetExternalApiApplicationStatusResponseSchema,
  type SettingsFieldError,
  UpdateExternalApiApplicationRequestSchema,
  UpdateExternalApiApplicationResponseSchema,
} from "@dx/api";
import {
  ExternalApiApplicationName,
  ExternalApiApplicationNotFound,
  ExternalApiApplicationRateLimit,
  ExternalApiApplicationScopes,
  ExternalApiApplicationUnsupportedScope,
  externalApiApplicationScopes,
  InvalidPageCursor,
  normalizeExternalApiApplicationName,
  PersistenceUnavailable,
  SettingsScopeForbidden,
  WorkspacePermissionForbidden,
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
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { ExternalApiApplicationCredentials } from "./credentials.js";
import { ExternalApiApplicationRepositoryD1 } from "./repository-d1.js";
import { ExternalApiApplicationsService } from "./service.js";

class InvalidExternalApiApplicationRequest extends Schema.TaggedError<InvalidExternalApiApplicationRequest>()(
  "InvalidExternalApiApplicationRequest",
  {
    fieldErrors: Schema.Array(
      Schema.Struct({ field: Schema.String, message: Schema.String }),
    ),
  },
) {}

const servicesFor = (db: D1Database) => {
  const workspaceRepository = WorkspaceRepositoryD1(db).pipe(
    Layer.provide(D1Client.layer({ db })),
  );
  const applicationRepository = ExternalApiApplicationRepositoryD1(db);
  const settings = SettingsService.layer.pipe(
    Layer.provide(workspaceRepository),
  );
  return ExternalApiApplicationsService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workspaceRepository,
        applicationRepository,
        settings,
        SettingsAudit.layer,
        ExternalApiApplicationCredentials.layer,
      ),
    ),
  );
};

const decode = <S extends Schema.Constraint>(schema: S, input: unknown) =>
  decodeRequestInput(
    schema,
    input,
    () => new InvalidExternalApiApplicationRequest({ fieldErrors: [] }),
  );

const fieldError = (field: string, message: string): SettingsFieldError => ({
  field,
  message,
});

const validatedApplicationInput = (input: {
  readonly name: string;
  readonly scopes: ReadonlyArray<string>;
  readonly rateLimitPerMinute: number;
}) => {
  const unsupported = input.scopes.find(
    (scope) =>
      !(externalApiApplicationScopes as ReadonlyArray<string>).includes(scope),
  );
  if (unsupported !== undefined) {
    return Effect.fail(
      new ExternalApiApplicationUnsupportedScope({ scope: unsupported }),
    );
  }
  const name = Schema.decodeOption(ExternalApiApplicationName)(
    normalizeExternalApiApplicationName(input.name),
  );
  const scopes = Schema.decodeUnknownOption(ExternalApiApplicationScopes)(
    input.scopes,
  );
  const rateLimit = Schema.decodeOption(ExternalApiApplicationRateLimit)(
    input.rateLimitPerMinute,
  );
  const fieldErrors: Array<SettingsFieldError> = [];
  if (Option.isNone(name)) {
    fieldErrors.push(
      fieldError("name", "Enter a name between 1 and 64 characters."),
    );
  }
  if (Option.isNone(scopes)) {
    fieldErrors.push(
      fieldError(
        "scopes",
        "Select one or more valid, distinct product scopes.",
      ),
    );
  }
  if (Option.isNone(rateLimit)) {
    fieldErrors.push(
      fieldError(
        "rateLimitPerMinute",
        "Choose a whole-number rate limit between 10 and 1000 requests per minute.",
      ),
    );
  }
  return Option.isSome(name) &&
    Option.isSome(scopes) &&
    Option.isSome(rateLimit)
    ? Effect.succeed({
        name: name.value,
        scopes: scopes.value,
        rateLimitPerMinute: rateLimit.value,
      })
    : Effect.fail(new InvalidExternalApiApplicationRequest({ fieldErrors }));
};

const applicationData = (application: {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly owner: {
    readonly userId: string;
    readonly name: string;
    readonly email: string;
    readonly activeMember: boolean;
  };
  readonly status: string;
  readonly scopes: ReadonlyArray<string>;
  readonly rateLimitPerMinute: number;
  readonly credential: {
    readonly id: string;
    readonly identifier: string;
    readonly createdAt: unknown;
    readonly expiresAt?: unknown;
  };
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
  readonly lastUsedAt?: unknown;
}) => ({
  id: application.id,
  clientId: application.clientId,
  name: application.name,
  owner: application.owner,
  status: application.status,
  scopes: application.scopes,
  rateLimitPerMinute: application.rateLimitPerMinute,
  credential: application.credential,
  createdAt: application.createdAt,
  updatedAt: application.updatedAt,
  ...(application.lastUsedAt === undefined
    ? {}
    : { lastUsedAt: application.lastUsedAt }),
});

const failureResponse = (context: Context<AppEnv>, failure: unknown) => {
  const requestId = context.get("requestId");
  if (
    failure instanceof InvalidExternalApiApplicationRequest ||
    failure instanceof InvalidPageCursor
  ) {
    return context.json(
      Schema.encodeUnknownSync(
        ExternalApiApplicationsInvalidRequestResponseSchema,
      )({
        status: "error",
        data: {
          code: "INVALID_EXTERNAL_API_APPLICATION_REQUEST",
          message: "External API application request validation failed.",
          requestId,
          fieldErrors:
            failure instanceof InvalidExternalApiApplicationRequest
              ? failure.fieldErrors
              : [],
        },
      }),
      400,
    );
  }
  if (failure instanceof ExternalApiApplicationUnsupportedScope) {
    return context.json(
      Schema.encodeUnknownSync(
        ExternalApiApplicationUnsupportedScopeResponseSchema,
      )({
        status: "error",
        data: {
          code: "UNSUPPORTED_EXTERNAL_API_APPLICATION_SCOPE",
          message:
            "The requested scope is not supported for external applications.",
          requestId,
        },
      }),
      400,
    );
  }
  if (failure instanceof SettingsScopeForbidden) {
    authorizationLogger.warn(
      "External API application workspace scope denied.",
      {
        event: "external_api_application_scope_denied",
        requestId,
      },
    );
    return context.json(
      Schema.encodeUnknownSync(
        ExternalApiApplicationsScopeForbiddenResponseSchema,
      )({
        status: "error",
        data: {
          code: "SETTINGS_SCOPE_FORBIDDEN",
          message: "The settings scope is unavailable for this user.",
          requestId,
        },
      }),
      403,
    );
  }
  if (failure instanceof WorkspacePermissionForbidden) {
    return context.json(
      Schema.encodeUnknownSync(
        ExternalApiApplicationsPermissionForbiddenResponseSchema,
      )({
        status: "error",
        data: {
          code: "WORKSPACE_PERMISSION_FORBIDDEN",
          message: "This workspace action is not permitted.",
          requestId,
        },
      }),
      403,
    );
  }
  if (failure instanceof ExternalApiApplicationNotFound) {
    return context.json(
      Schema.encodeUnknownSync(ExternalApiApplicationNotFoundResponseSchema)({
        status: "error",
        data: {
          code: "EXTERNAL_API_APPLICATION_NOT_FOUND",
          message: "External API application not found.",
          requestId,
        },
      }),
      404,
    );
  }
  if (failure instanceof PersistenceUnavailable) {
    return context.json(
      Schema.encodeUnknownSync(
        ExternalApiApplicationsPersistenceUnavailableResponseSchema,
      )({
        status: "error",
        data: {
          code: "PERSISTENCE_UNAVAILABLE",
          message: "External API applications are temporarily unavailable.",
          requestId,
        },
      }),
      503,
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

const withServices = <A, E, R>(
  db: D1Database,
  effect: Effect.Effect<A, E, R | ExternalApiApplicationsService>,
) => effect.pipe(Effect.provide(servicesFor(db)));

const baseParams = (context: Context<AppEnv>) =>
  decode(ExternalApiApplicationsParamsSchema, {
    workspaceSlug: context.req.param("workspaceSlug"),
  });

const applicationParams = (context: Context<AppEnv>) =>
  decode(ExternalApiApplicationParamsSchema, {
    workspaceSlug: context.req.param("workspaceSlug"),
    applicationId: context.req.param("applicationId"),
  });

export const workspaceApplicationRoutes = new Hono<AppEnv>();

workspaceApplicationRoutes.get(
  "/:workspaceSlug/applications",
  async (context) => {
    const operation = Effect.gen(function* () {
      const params = yield* baseParams(context);
      const query = yield* decode(ListExternalApiApplicationsQuerySchema, {
        limit: context.req.query("limit"),
        cursor: context.req.query("cursor"),
      });
      const db = yield* decodeD1Binding(context.env.DB);
      const page = yield* withServices(
        db,
        Effect.gen(function* () {
          const service = yield* ExternalApiApplicationsService;
          return yield* service.list(
            context.get("principal"),
            params.workspaceSlug,
            {
              limit: query.limit ?? 20,
              ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            },
          );
        }),
      );
      return yield* Schema.encodeUnknownEffect(
        ListExternalApiApplicationsResponseSchema,
      )({
        status: "success",
        data: {
          items: page.items.map(applicationData),
          ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
          permissions: page.permissions,
        },
      });
    });
    return run(context, operation);
  },
);

workspaceApplicationRoutes.post(
  "/:workspaceSlug/applications",
  async (context) => {
    const operation = Effect.gen(function* () {
      const params = yield* baseParams(context);
      const body = yield* decodeJsonBody(
        context.req,
        CreateExternalApiApplicationRequestSchema,
        () => new InvalidExternalApiApplicationRequest({ fieldErrors: [] }),
      );
      const input = yield* validatedApplicationInput(body);
      const db = yield* decodeD1Binding(context.env.DB);
      const created = yield* withServices(
        db,
        Effect.gen(function* () {
          const service = yield* ExternalApiApplicationsService;
          return yield* service.create(
            context.get("principal"),
            params.workspaceSlug,
            input,
            context.get("requestId"),
          );
        }),
      );
      return yield* Schema.encodeUnknownEffect(
        CreateExternalApiApplicationResponseSchema,
      )({
        status: "success",
        data: {
          application: applicationData(created.application),
          clientSecret: created.clientSecret,
        },
      });
    });
    return run(context, operation, 201);
  },
);

workspaceApplicationRoutes.patch(
  "/:workspaceSlug/applications/:applicationId",
  async (context) => {
    const operation = Effect.gen(function* () {
      const params = yield* applicationParams(context);
      const body = yield* decodeJsonBody(
        context.req,
        UpdateExternalApiApplicationRequestSchema,
        () => new InvalidExternalApiApplicationRequest({ fieldErrors: [] }),
      );
      const input = yield* validatedApplicationInput(body);
      const db = yield* decodeD1Binding(context.env.DB);
      const updated = yield* withServices(
        db,
        Effect.gen(function* () {
          const service = yield* ExternalApiApplicationsService;
          return yield* service.update(
            context.get("principal"),
            params.workspaceSlug,
            params.applicationId,
            input,
            context.get("requestId"),
          );
        }),
      );
      return yield* Schema.encodeUnknownEffect(
        UpdateExternalApiApplicationResponseSchema,
      )({ status: "success", data: applicationData(updated) });
    });
    return run(context, operation);
  },
);

workspaceApplicationRoutes.post(
  "/:workspaceSlug/applications/:applicationId/rotate",
  async (context) => {
    const operation = Effect.gen(function* () {
      const params = yield* applicationParams(context);
      const body = yield* decodeJsonBody(
        context.req,
        RotateExternalApiApplicationRequestSchema,
        () => new InvalidExternalApiApplicationRequest({ fieldErrors: [] }),
      );
      const db = yield* decodeD1Binding(context.env.DB);
      const rotated = yield* withServices(
        db,
        Effect.gen(function* () {
          const service = yield* ExternalApiApplicationsService;
          return yield* service.rotate(
            context.get("principal"),
            params.workspaceSlug,
            params.applicationId,
            body.overlapSeconds,
            context.get("requestId"),
          );
        }),
      );
      return yield* Schema.encodeUnknownEffect(
        RotateExternalApiApplicationResponseSchema,
      )({
        status: "success",
        data: {
          application: applicationData(rotated.application),
          clientSecret: rotated.clientSecret,
        },
      });
    });
    return run(context, operation);
  },
);

for (const status of ["active", "disabled"] as const) {
  const action = status === "active" ? "enable" : "disable";
  workspaceApplicationRoutes.post(
    `/:workspaceSlug/applications/:applicationId/${action}`,
    async (context) => {
      const operation = Effect.gen(function* () {
        const params = yield* applicationParams(context);
        const db = yield* decodeD1Binding(context.env.DB);
        const updated = yield* withServices(
          db,
          Effect.gen(function* () {
            const service = yield* ExternalApiApplicationsService;
            return yield* service.setStatus(
              context.get("principal"),
              params.workspaceSlug,
              params.applicationId,
              status,
              context.get("requestId"),
            );
          }),
        );
        return yield* Schema.encodeUnknownEffect(
          SetExternalApiApplicationStatusResponseSchema,
        )({ status: "success", data: applicationData(updated) });
      });
      return run(context, operation);
    },
  );
}

workspaceApplicationRoutes.delete(
  "/:workspaceSlug/applications/:applicationId",
  async (context) => {
    const operation = Effect.gen(function* () {
      const params = yield* applicationParams(context);
      const db = yield* decodeD1Binding(context.env.DB);
      yield* withServices(
        db,
        Effect.gen(function* () {
          const service = yield* ExternalApiApplicationsService;
          return yield* service.setStatus(
            context.get("principal"),
            params.workspaceSlug,
            params.applicationId,
            "revoked",
            context.get("requestId"),
          );
        }),
      );
      return yield* Schema.encodeUnknownEffect(
        RevokeExternalApiApplicationResponseSchema,
      )({
        status: "success",
        data: { revokedApplicationId: params.applicationId },
      });
    });
    return run(context, operation);
  },
);

workspaceApplicationRoutes.get(
  "/:workspaceSlug/applications/:applicationId/audit",
  async (context) => {
    const operation = Effect.gen(function* () {
      const params = yield* applicationParams(context);
      const query = yield* decode(ListExternalApiApplicationAuditQuerySchema, {
        limit: context.req.query("limit"),
        cursor: context.req.query("cursor"),
      });
      const db = yield* decodeD1Binding(context.env.DB);
      const page = yield* withServices(
        db,
        Effect.gen(function* () {
          const service = yield* ExternalApiApplicationsService;
          return yield* service.listAudit(
            context.get("principal"),
            params.workspaceSlug,
            params.applicationId,
            {
              limit: query.limit ?? 25,
              ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            },
          );
        }),
      );
      return yield* Schema.encodeUnknownEffect(
        ListExternalApiApplicationAuditResponseSchema,
      )({
        status: "success",
        data: {
          items: page.items,
          ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
        },
      });
    });
    return run(context, operation);
  },
);
