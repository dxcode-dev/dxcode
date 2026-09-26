import {
  GetPersonalAgentInstructionsResponseSchema,
  PersonalAgentInstructionsConflictResponseSchema,
  PersonalAgentInstructionsForbiddenResponseSchema,
  PersonalAgentInstructionsInvalidRequestResponseSchema,
  PersonalAgentInstructionsNotFoundResponseSchema,
  PersonalAgentInstructionsPersistenceUnavailableResponseSchema,
  type SettingsFieldError,
  UpdatePersonalAgentInstructionsRequestSchema,
  UpdatePersonalAgentInstructionsResponseSchema,
} from "@dx/api";
import {
  normalizePersonalAgentInstructions,
  PersonalAgentInstructionsContent,
  PersonalAgentInstructionsRevision,
  type UpdatePersonalAgentInstructionsInput,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Match, Option, Result, Schema } from "effect";
import { Hono, type Context } from "hono";
import { decodeJsonBody } from "../../http/request-decoding.js";
import type { AppEnv } from "../../http/types.js";
import { authorizationLogger } from "../../logging.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { SettingsAudit } from "../audit.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { PersonalAgentInstructionsRepositoryD1 } from "./repository-d1.js";
import { PersonalAgentInstructionsService } from "./service.js";

const AgentInstructionsFieldError = Schema.Struct({
  field: Schema.String,
  message: Schema.String,
});

class InvalidPersonalAgentInstructionsRequest extends Schema.TaggedError<InvalidPersonalAgentInstructionsRequest>()(
  "InvalidPersonalAgentInstructionsRequest",
  { fieldErrors: Schema.Array(AgentInstructionsFieldError) },
) {}

const responseData = (settings: {
  readonly content: string;
  readonly revision: number;
  readonly version: 1;
  readonly updatedAt: unknown;
}) => ({
  instructions: settings.content,
  revision: settings.revision,
  version: settings.version,
  updatedAt: settings.updatedAt,
});

const validateUpdate = (
  input: typeof UpdatePersonalAgentInstructionsRequestSchema.Type,
): Effect.Effect<
  UpdatePersonalAgentInstructionsInput,
  InvalidPersonalAgentInstructionsRequest
> => {
  const content = Schema.decodeOption(PersonalAgentInstructionsContent)(
    normalizePersonalAgentInstructions(input.instructions),
  );
  const expectedRevision = Schema.decodeOption(
    PersonalAgentInstructionsRevision,
  )(input.expectedRevision);
  const fieldErrors: Array<SettingsFieldError> = [];
  if (Option.isNone(content)) {
    fieldErrors.push({
      field: "instructions",
      message: "Enter no more than 10,000 characters.",
    });
  }
  if (Option.isNone(expectedRevision)) {
    fieldErrors.push({
      field: "expectedRevision",
      message: "Use the current non-negative integer revision.",
    });
  }
  return Option.isSome(content) && Option.isSome(expectedRevision)
    ? Effect.succeed({
        content: content.value,
        expectedRevision: expectedRevision.value,
      })
    : Effect.fail(new InvalidPersonalAgentInstructionsRequest({ fieldErrors }));
};

const servicesFor = (db: D1Database) => {
  const repositories = Layer.merge(
    WorkspaceRepositoryD1(db),
    PersonalAgentInstructionsRepositoryD1,
  ).pipe(Layer.provide(D1Client.layer({ db })));
  return Layer.merge(
    SettingsService.layer.pipe(Layer.provide(repositories)),
    PersonalAgentInstructionsService.layer.pipe(
      Layer.provide(Layer.merge(repositories, SettingsAudit.layer)),
    ),
  );
};

const auditInvalidUpdate = (
  context: Context<AppEnv>,
  fieldErrors: ReadonlyArray<SettingsFieldError>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const audit = yield* SettingsAudit;
      yield* audit.record({
        action: "personal_agent_instructions.update",
        scope: "personal",
        outcome: "rejected",
        requestId: context.get("requestId"),
        userId: context.get("principal").userId,
        fields: fieldErrors.flatMap(({ field }) =>
          field === "instructions" || field === "expectedRevision"
            ? [field]
            : [],
        ),
      });
    }).pipe(Effect.provide(SettingsAudit.layer)),
  );

const forbidden = (context: Context<AppEnv>) => {
  authorizationLogger.warn(
    "Personal agent instructions authorization failed.",
    {
      event: "personal_agent_instructions_authorization_failed",
      requestId: context.get("requestId"),
    },
  );
  return context.json(
    Schema.encodeUnknownSync(PersonalAgentInstructionsForbiddenResponseSchema)({
      status: "error",
      data: {
        code: "SETTINGS_SCOPE_FORBIDDEN",
        message: "The settings scope is unavailable for this user.",
        requestId: context.get("requestId"),
      },
    }),
    403,
  );
};

const notFound = (context: Context<AppEnv>) =>
  context.json(
    Schema.encodeUnknownSync(PersonalAgentInstructionsNotFoundResponseSchema)({
      status: "error",
      data: {
        code: "PERSONAL_AGENT_INSTRUCTIONS_NOT_FOUND",
        message: "Personal agent instructions were not found.",
        requestId: context.get("requestId"),
      },
    }),
    404,
  );

const unavailable = (context: Context<AppEnv>) =>
  context.json(
    Schema.encodeUnknownSync(
      PersonalAgentInstructionsPersistenceUnavailableResponseSchema,
    )({
      status: "error",
      data: {
        code: "PERSISTENCE_UNAVAILABLE",
        message: "Settings are temporarily unavailable.",
        requestId: context.get("requestId"),
      },
    }),
    503,
  );

export const personalAgentInstructionsRoutes = new Hono<AppEnv>();

personalAgentInstructionsRoutes.get("/", async (context) => {
  const operation = Effect.gen(function* () {
    const db = yield* decodeD1Binding(context.env.DB);
    return yield* Effect.gen(function* () {
      const settings = yield* SettingsService;
      yield* settings.personal(context.get("principal"));
      const instructions = yield* PersonalAgentInstructionsService;
      const current = yield* instructions.get(context.get("principal"));
      return yield* Schema.encodeUnknownEffect(
        GetPersonalAgentInstructionsResponseSchema,
      )({ status: "success", data: responseData(current) });
    }).pipe(Effect.provide(servicesFor(db)));
  });

  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return context.json(result.success, 200);
  return Match.value(result.failure).pipe(
    Match.tags({
      SettingsScopeForbidden: () => forbidden(context),
      PersonalAgentInstructionsNotFound: () => notFound(context),
      PersistenceUnavailable: () => unavailable(context),
      SettingsMembershipInvariantViolation: (error) => {
        throw error;
      },
      D1BindingUnavailable: (error) => {
        throw error;
      },
      ConfigError: (error) => {
        throw error;
      },
      SchemaError: (error) => {
        throw error;
      },
    }),
    Match.exhaustive,
  );
});

personalAgentInstructionsRoutes.patch("/", async (context) => {
  const requestId = context.get("requestId");
  const operation = Effect.gen(function* () {
    const raw = yield* decodeJsonBody(
      context.req,
      UpdatePersonalAgentInstructionsRequestSchema,
      () =>
        new InvalidPersonalAgentInstructionsRequest({
          fieldErrors: [
            {
              field: "request",
              message: "Only instructions and expectedRevision can be changed.",
            },
          ],
        }),
    );
    const input = yield* validateUpdate(raw);
    const db = yield* decodeD1Binding(context.env.DB);
    return yield* Effect.gen(function* () {
      const settings = yield* SettingsService;
      yield* settings.personal(context.get("principal"));
      const instructions = yield* PersonalAgentInstructionsService;
      const updated = yield* instructions.update(
        context.get("principal"),
        input,
        requestId,
      );
      return yield* Schema.encodeUnknownEffect(
        UpdatePersonalAgentInstructionsResponseSchema,
      )({ status: "success", data: responseData(updated) });
    }).pipe(Effect.provide(servicesFor(db)));
  }).pipe(
    Effect.tapErrorTag("InvalidPersonalAgentInstructionsRequest", (error) =>
      Effect.promise(() => auditInvalidUpdate(context, error.fieldErrors)),
    ),
  );

  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return context.json(result.success, 200);
  return Match.value(result.failure).pipe(
    Match.tags({
      InvalidPersonalAgentInstructionsRequest: (error) =>
        context.json(
          Schema.encodeUnknownSync(
            PersonalAgentInstructionsInvalidRequestResponseSchema,
          )({
            status: "error",
            data: {
              code: "INVALID_AGENT_INSTRUCTIONS",
              message: "Agent instructions validation failed.",
              requestId,
              fieldErrors: error.fieldErrors,
            },
          }),
          400,
        ),
      PersonalAgentInstructionsRevisionConflict: (error) =>
        context.json(
          Schema.encodeUnknownSync(
            PersonalAgentInstructionsConflictResponseSchema,
          )({
            status: "error",
            data: {
              code: "AGENT_INSTRUCTIONS_REVISION_CONFLICT",
              message:
                "Agent instructions changed in another session. Reload before saving.",
              requestId,
              currentRevision: error.actualRevision,
            },
          }),
          409,
        ),
      SettingsScopeForbidden: () => forbidden(context),
      PersonalAgentInstructionsNotFound: () => notFound(context),
      PersistenceUnavailable: () => unavailable(context),
      SettingsMembershipInvariantViolation: (error) => {
        throw error;
      },
      D1BindingUnavailable: (error) => {
        throw error;
      },
      ConfigError: (error) => {
        throw error;
      },
      SchemaError: (error) => {
        throw error;
      },
    }),
    Match.exhaustive,
  );
});
