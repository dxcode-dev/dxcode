import {
  CreateWorkspaceRequestSchema,
  CreateWorkspaceResponseSchema,
  GetWorkspaceProfileResponseSchema,
  type SettingsFieldError,
  UpdateWorkspaceProfileRequestSchema,
  UpdateWorkspaceProfileResponseSchema,
  WorkspaceMembershipExistsResponseSchema,
  WorkspaceProfileConflictResponseSchema,
  WorkspaceProfileForbiddenResponseSchema,
  WorkspaceProfileInvalidRequestResponseSchema,
  WorkspaceProfileParamsSchema,
  WorkspaceProfilePersistenceUnavailableResponseSchema,
  WorkspaceShortNameUnavailableResponseSchema,
} from "@dx/api";
import {
  type CreateWorkspaceInput,
  normalizeWorkspaceDisplayName,
  normalizeWorkspaceShortName,
  PersistenceUnavailable,
  SettingsScopeForbidden,
  WorkspaceDisplayName,
  WorkspaceMembershipExists,
  WorkspaceProfileConflict,
  WorkspaceShortName,
  WorkspaceShortNameUnavailable,
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
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "./repository-d1.js";
import { WorkspaceProfileService } from "./service.js";

const WorkspaceFieldError = Schema.Struct({
  field: Schema.String,
  message: Schema.String,
});

class InvalidWorkspaceProfileRequest extends Schema.TaggedError<InvalidWorkspaceProfileRequest>()(
  "InvalidWorkspaceProfileRequest",
  { fieldErrors: Schema.Array(WorkspaceFieldError) },
) {}

const responseData = (membership: {
  readonly workspace: {
    readonly id: string;
    readonly displayName: string;
    readonly shortName: string;
    readonly lifecycleState:
      | "active"
      | "deletion-pending"
      | "deleting"
      | "deletion-failed";
    readonly revision: number;
  };
  readonly role: "owner" | "admin" | "auditor" | "member";
}) => ({ ...membership.workspace, role: membership.role });

const validateProfile = (input: {
  readonly displayName: string;
  readonly shortName: string;
}): Effect.Effect<CreateWorkspaceInput, InvalidWorkspaceProfileRequest> => {
  const displayName = Schema.decodeOption(WorkspaceDisplayName)(
    normalizeWorkspaceDisplayName(input.displayName),
  );
  const shortName = Schema.decodeOption(WorkspaceShortName)(
    normalizeWorkspaceShortName(input.shortName),
  );
  const fieldErrors: Array<SettingsFieldError> = [];
  if (Option.isNone(displayName)) {
    fieldErrors.push({
      field: "displayName",
      message: "Enter a display name between 1 and 128 characters.",
    });
  }
  if (Option.isNone(shortName)) {
    fieldErrors.push({
      field: "shortName",
      message:
        "Use 3–63 lowercase letters, numbers, or hyphens, starting and ending with a letter or number.",
    });
  }
  return Option.isSome(displayName) && Option.isSome(shortName)
    ? Effect.succeed({
        displayName: displayName.value,
        shortName: shortName.value,
      })
    : Effect.fail(new InvalidWorkspaceProfileRequest({ fieldErrors }));
};

const servicesFor = (db: D1Database) => {
  const repository = WorkspaceRepositoryD1(db).pipe(
    Layer.provide(D1Client.layer({ db })),
  );
  const settings = SettingsService.layer.pipe(Layer.provide(repository));
  return WorkspaceProfileService.layer.pipe(
    Layer.provide(Layer.mergeAll(repository, settings, SettingsAudit.layer)),
  );
};

const workspaceSlug = (context: Context<AppEnv>) =>
  decodeRequestInput(
    WorkspaceProfileParamsSchema,
    { workspaceSlug: context.req.param("workspaceSlug") },
    () =>
      new InvalidWorkspaceProfileRequest({
        fieldErrors: [
          {
            field: "workspaceSlug",
            message: "Use a valid workspace short name.",
          },
        ],
      }),
  ).pipe(Effect.map((params) => params.workspaceSlug));

const auditInvalid = (
  context: Context<AppEnv>,
  fieldErrors: ReadonlyArray<SettingsFieldError>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const audit = yield* SettingsAudit;
      yield* audit.record({
        action: "workspace.update",
        scope: "workspace",
        outcome: "rejected",
        requestId: context.get("requestId"),
        userId: context.get("principal").userId,
        fields: fieldErrors.flatMap(({ field }) =>
          field === "displayName" || field === "shortName" ? [field] : [],
        ),
      });
    }).pipe(Effect.provide(SettingsAudit.layer)),
  );

const failureResponse = (context: Context<AppEnv>, failure: unknown) => {
  const requestId = context.get("requestId");
  if (failure instanceof InvalidWorkspaceProfileRequest) {
    return context.json(
      Schema.encodeUnknownSync(WorkspaceProfileInvalidRequestResponseSchema)({
        status: "error",
        data: {
          code: "INVALID_WORKSPACE_PROFILE",
          message: "Workspace profile validation failed.",
          requestId,
          fieldErrors: failure.fieldErrors,
        },
      }),
      400,
    );
  }
  if (failure instanceof WorkspaceShortNameUnavailable) {
    return context.json(
      Schema.encodeUnknownSync(WorkspaceShortNameUnavailableResponseSchema)({
        status: "error",
        data: {
          code: "WORKSPACE_SHORT_NAME_UNAVAILABLE",
          message: "That workspace short name is already in use.",
          requestId,
          fieldErrors: [
            {
              field: "shortName",
              message: "Choose a different short name.",
            },
          ],
        },
      }),
      409,
    );
  }
  if (failure instanceof WorkspaceMembershipExists) {
    return context.json(
      Schema.encodeUnknownSync(WorkspaceMembershipExistsResponseSchema)({
        status: "error",
        data: {
          code: "WORKSPACE_MEMBERSHIP_EXISTS",
          message: "This user already belongs to a workspace.",
          requestId,
        },
      }),
      409,
    );
  }
  if (failure instanceof WorkspaceProfileConflict) {
    return context.json(
      Schema.encodeUnknownSync(WorkspaceProfileConflictResponseSchema)({
        status: "error",
        data: {
          code: "WORKSPACE_PROFILE_CONFLICT",
          message: "Workspace profile changed since you started editing.",
          requestId,
          currentRevision: failure.currentRevision,
        },
      }),
      409,
    );
  }
  if (failure instanceof SettingsScopeForbidden) {
    authorizationLogger.warn("Workspace profile authorization failed.", {
      event: "workspace_profile_authorization_failed",
      requestId,
    });
    return context.json(
      Schema.encodeUnknownSync(WorkspaceProfileForbiddenResponseSchema)({
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
  if (failure instanceof PersistenceUnavailable) {
    return context.json(
      Schema.encodeUnknownSync(
        WorkspaceProfilePersistenceUnavailableResponseSchema,
      )({
        status: "error",
        data: {
          code: "PERSISTENCE_UNAVAILABLE",
          message: "Workspace settings are temporarily unavailable.",
          requestId,
        },
      }),
      503,
    );
  }
  throw failure;
};

export const workspaceProfileRoutes = new Hono<AppEnv>();

workspaceProfileRoutes.post("/", async (context) => {
  const operation = Effect.gen(function* () {
    const raw = yield* decodeJsonBody(
      context.req,
      CreateWorkspaceRequestSchema,
      () =>
        new InvalidWorkspaceProfileRequest({
          fieldErrors: [
            {
              field: "request",
              message: "Only displayName and shortName can be set.",
            },
          ],
        }),
    );
    const input = yield* validateProfile(raw);
    const db = yield* decodeD1Binding(context.env.DB);
    const membership = yield* Effect.gen(function* () {
      const service = yield* WorkspaceProfileService;
      return yield* service.create(
        context.get("principal"),
        input,
        context.get("requestId"),
      );
    }).pipe(Effect.provide(servicesFor(db)));
    return yield* Schema.encodeUnknownEffect(CreateWorkspaceResponseSchema)({
      status: "success",
      data: responseData(membership),
    });
  }).pipe(
    Effect.tapErrorTag("InvalidWorkspaceProfileRequest", (error) =>
      Effect.promise(() => auditInvalid(context, error.fieldErrors)),
    ),
  );

  const result = await Effect.runPromise(Effect.result(operation));
  return Result.isSuccess(result)
    ? context.json(result.success, 201)
    : failureResponse(context, result.failure);
});

workspaceProfileRoutes.get("/:workspaceSlug", async (context) => {
  const operation = Effect.gen(function* () {
    const slug = yield* workspaceSlug(context);
    const db = yield* decodeD1Binding(context.env.DB);
    const membership = yield* Effect.gen(function* () {
      const service = yield* WorkspaceProfileService;
      return yield* service.get(context.get("principal"), slug);
    }).pipe(Effect.provide(servicesFor(db)));
    return yield* Schema.encodeUnknownEffect(GetWorkspaceProfileResponseSchema)(
      {
        status: "success",
        data: responseData(membership),
      },
    );
  });

  const result = await Effect.runPromise(Effect.result(operation));
  return Result.isSuccess(result)
    ? context.json(result.success, 200)
    : failureResponse(context, result.failure);
});

workspaceProfileRoutes.patch("/:workspaceSlug", async (context) => {
  const operation = Effect.gen(function* () {
    const slug = yield* workspaceSlug(context);
    const raw = yield* decodeJsonBody(
      context.req,
      UpdateWorkspaceProfileRequestSchema,
      () =>
        new InvalidWorkspaceProfileRequest({
          fieldErrors: [
            {
              field: "request",
              message:
                "Only displayName, shortName, and expectedRevision can be changed.",
            },
          ],
        }),
    );
    const input = yield* validateProfile(raw);
    const db = yield* decodeD1Binding(context.env.DB);
    const membership = yield* Effect.gen(function* () {
      const service = yield* WorkspaceProfileService;
      return yield* service.update(
        context.get("principal"),
        slug,
        input,
        raw.expectedRevision,
        context.get("requestId"),
      );
    }).pipe(Effect.provide(servicesFor(db)));
    return yield* Schema.encodeUnknownEffect(
      UpdateWorkspaceProfileResponseSchema,
    )({ status: "success", data: responseData(membership) });
  }).pipe(
    Effect.tapErrorTag("InvalidWorkspaceProfileRequest", (error) =>
      Effect.promise(() => auditInvalid(context, error.fieldErrors)),
    ),
  );

  const result = await Effect.runPromise(Effect.result(operation));
  return Result.isSuccess(result)
    ? context.json(result.success, 200)
    : failureResponse(context, result.failure);
});
