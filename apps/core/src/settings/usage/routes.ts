import {
  ExportPersonalUsageResponseSchema,
  GetPersonalUsageResponseSchema,
  PersonalUsageForbiddenResponseSchema,
  PersonalUsageInvalidRequestResponseSchema,
  PersonalUsageQuerySchema,
  PersonalUsageUnavailableResponseSchema,
} from "@dx/api";
import type {
  InvalidUsageQuery,
  PersistenceUnavailable,
  UsageResourceForbidden,
} from "@dx/domain";
import { Effect, Layer, Match, Result, Schema } from "effect";
import { Hono, type Context } from "hono";
import { decodeRequestInput } from "../../http/request-decoding.js";
import type { AppEnv } from "../../http/types.js";
import {
  decodeD1Binding,
  type D1BindingUnavailable,
} from "../../persistence/d1-binding.js";
import { UsageRepositoryD1 } from "./repository-d1.js";
import { PersonalUsageService } from "./service.js";

class InvalidPersonalUsageRequest extends Schema.TaggedError<InvalidPersonalUsageRequest>()(
  "InvalidPersonalUsageRequest",
  {},
) {}

const layer = (db: D1Database) =>
  PersonalUsageService.layer.pipe(Layer.provide(UsageRepositoryD1(db)));

type UsageRouteFailure =
  | InvalidPersonalUsageRequest
  | InvalidUsageQuery
  | UsageResourceForbidden
  | PersistenceUnavailable
  | D1BindingUnavailable
  | Schema.SchemaError;

const failureResponse = (
  context: Context<AppEnv>,
  failure: UsageRouteFailure,
) => {
  const requestId = context.get("requestId");
  return Match.value(failure).pipe(
    Match.tags({
      InvalidPersonalUsageRequest: () =>
        context.json(
          Schema.encodeUnknownSync(PersonalUsageInvalidRequestResponseSchema)({
            status: "error",
            data: {
              code: "INVALID_USAGE_QUERY",
              message: "Usage query validation failed.",
              requestId,
            },
          }),
          400,
        ),
      InvalidUsageQuery: () =>
        context.json(
          Schema.encodeUnknownSync(PersonalUsageInvalidRequestResponseSchema)({
            status: "error",
            data: {
              code: "INVALID_USAGE_QUERY",
              message: "Usage query validation failed.",
              requestId,
            },
          }),
          400,
        ),
      UsageResourceForbidden: () =>
        context.json(
          Schema.encodeUnknownSync(PersonalUsageForbiddenResponseSchema)({
            status: "error",
            data: {
              code: "USAGE_RESOURCE_FORBIDDEN",
              message:
                "The requested usage resource is unavailable for this user.",
              requestId,
            },
          }),
          403,
        ),
      PersistenceUnavailable: () =>
        context.json(
          Schema.encodeUnknownSync(PersonalUsageUnavailableResponseSchema)({
            status: "error",
            data: {
              code: "PERSISTENCE_UNAVAILABLE",
              message: "Usage is temporarily unavailable.",
              requestId,
            },
          }),
          503,
        ),
      D1BindingUnavailable: (error) => {
        throw error;
      },
      SchemaError: (error) => {
        throw error;
      },
    }),
    Match.exhaustive,
  );
};

const operation = (context: Context<AppEnv>, mode: "dashboard" | "export") =>
  Effect.gen(function* () {
    const query = yield* decodeRequestInput(
      PersonalUsageQuerySchema,
      context.req.query(),
      () => new InvalidPersonalUsageRequest(),
    );
    const db = yield* decodeD1Binding(context.env.DB);
    return yield* Effect.gen(function* () {
      const service = yield* PersonalUsageService;
      if (mode === "dashboard") {
        const data = yield* service.get(context.get("principal"), query);
        return yield* Schema.encodeUnknownEffect(
          GetPersonalUsageResponseSchema,
        )({ status: "success", data });
      }
      const data = yield* service.exportCsv(context.get("principal"), query);
      return yield* Schema.encodeUnknownEffect(
        ExportPersonalUsageResponseSchema,
      )({ status: "success", data });
    }).pipe(Effect.provide(layer(db)));
  });

const handle = async (
  context: Context<AppEnv>,
  mode: "dashboard" | "export",
) => {
  const result = await Effect.runPromise(
    Effect.result(operation(context, mode)),
  );
  return Result.isSuccess(result)
    ? context.json(result.success, 200)
    : failureResponse(context, result.failure);
};

export const personalUsageRoutes = new Hono<AppEnv>();

personalUsageRoutes.get("/", (context) => handle(context, "dashboard"));
personalUsageRoutes.get("/export", (context) => handle(context, "export"));
