import {
  ExperimentalFeaturesConflictResponseSchema,
  ExperimentalFeaturesForbiddenResponseSchema,
  ExperimentalFeaturesInvalidRequestResponseSchema,
  ExperimentalFeaturesPersistenceUnavailableResponseSchema,
  GetPersonalExperimentalFeaturesResponseSchema,
  UpdatePersonalExperimentalFeatureRequestSchema,
  UpdatePersonalExperimentalFeatureResponseSchema,
} from "@dx/api";
import type { ExperimentalFeatureId, Principal } from "@dx/domain";
import {
  ExperimentalFeaturePreferenceInvalid,
  ExperimentalFeaturePreferencesConflict,
  PersistenceUnavailable,
  SettingsScopeForbidden,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import { decodeJsonBody } from "../../http/request-decoding.js";
import type { AppEnv } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { SettingsAudit } from "../audit.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { experimentalFeatureRegistryFor } from "./registry.js";
import { ExperimentalFeaturePreferencesRepositoryD1 } from "./repository-d1.js";
import {
  ExperimentalFeaturesService,
  type PersonalExperimentalFeaturesView,
} from "./service.js";

class InvalidExperimentalFeatureRequest extends Schema.TaggedError<InvalidExperimentalFeatureRequest>()(
  "InvalidExperimentalFeatureRequest",
  {},
) {}

const servicesFor = (db: D1Database) => {
  const d1 = D1Client.layer({ db });
  const workspaces = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const preferences = ExperimentalFeaturePreferencesRepositoryD1.pipe(
    Layer.provide(d1),
  );
  const settings = SettingsService.layer.pipe(Layer.provide(workspaces));
  return ExperimentalFeaturesService.layer.pipe(
    Layer.provide(Layer.mergeAll(preferences, settings, SettingsAudit.layer)),
  );
};

const responseData = (view: PersonalExperimentalFeaturesView) => ({
  registryVersion: view.registryVersion,
  revision: view.revision,
  flags: view.flags,
});

const failureResponse = (context: Context<AppEnv>, failure: unknown) => {
  const requestId = context.get("requestId");
  if (failure instanceof InvalidExperimentalFeatureRequest) {
    return context.json(
      Schema.encodeUnknownSync(
        ExperimentalFeaturesInvalidRequestResponseSchema,
      )({
        status: "error",
        data: {
          code: "INVALID_EXPERIMENTAL_FEATURE_PREFERENCE",
          message: "Experimental feature preference is invalid.",
          requestId,
        },
      }),
      400,
    );
  }
  if (failure instanceof ExperimentalFeaturePreferenceInvalid) {
    return context.json(
      Schema.encodeUnknownSync(
        ExperimentalFeaturesInvalidRequestResponseSchema,
      )({
        status: "error",
        data: {
          code: "INVALID_EXPERIMENTAL_FEATURE_PREFERENCE",
          message: "Experimental feature preference is invalid.",
          requestId,
          featureId: failure.featureId,
          reason: failure.reason,
          ...(failure.relatedFeatureId === undefined
            ? {}
            : { relatedFeatureId: failure.relatedFeatureId }),
        },
      }),
      400,
    );
  }
  if (failure instanceof ExperimentalFeaturePreferencesConflict) {
    return context.json(
      Schema.encodeUnknownSync(ExperimentalFeaturesConflictResponseSchema)({
        status: "error",
        data: {
          code: "EXPERIMENTAL_FEATURE_PREFERENCES_CONFLICT",
          message:
            "Experimental feature preferences changed in another session.",
          requestId,
          currentRevision: failure.currentRevision,
        },
      }),
      409,
    );
  }
  if (failure instanceof SettingsScopeForbidden) {
    return context.json(
      Schema.encodeUnknownSync(ExperimentalFeaturesForbiddenResponseSchema)({
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
        ExperimentalFeaturesPersistenceUnavailableResponseSchema,
      )({
        status: "error",
        data: {
          code: "PERSISTENCE_UNAVAILABLE",
          message:
            "Experimental feature preferences are temporarily unavailable.",
          requestId,
        },
      }),
      503,
    );
  }
  throw failure;
};

/**
 * The personal experimental features that are on for the person, after
 * their prerequisites and incompatibilities. A failed read rejects, so
 * callers fail closed.
 */
export const enabledExperimentalFeatures = async (
  bindings: AppEnv["Bindings"],
  principal: Principal,
): Promise<ReadonlySet<ExperimentalFeatureId>> => {
  const operation = Effect.gen(function* () {
    const db = yield* decodeD1Binding(bindings.DB);
    return yield* Effect.gen(function* () {
      const service = yield* ExperimentalFeaturesService;
      const view = yield* service.getPersonal(
        principal,
        experimentalFeatureRegistryFor(bindings),
      );
      return new Set(
        view.flags.flatMap(({ registration, effectiveEnabled }) =>
          effectiveEnabled ? [registration.id] : [],
        ),
      );
    }).pipe(Effect.provide(servicesFor(db)));
  });
  return Effect.runPromise(operation);
};

/**
 * Whether a personal experimental feature is on for the person, after its
 * prerequisites and incompatibilities. A feature the registry does not
 * list is off; a failed read rejects, so callers fail closed.
 */
export const experimentalFeatureEnabled = async (
  bindings: AppEnv["Bindings"],
  principal: Principal,
  featureId: ExperimentalFeatureId,
): Promise<boolean> =>
  (await enabledExperimentalFeatures(bindings, principal)).has(featureId);

export const personalExperimentalFeaturesRoutes = new Hono<AppEnv>();

personalExperimentalFeaturesRoutes.get("/", async (context) => {
  const operation = Effect.gen(function* () {
    const db = yield* decodeD1Binding(context.env.DB);
    return yield* Effect.gen(function* () {
      const service = yield* ExperimentalFeaturesService;
      const view = yield* service.getPersonal(
        context.get("principal"),
        experimentalFeatureRegistryFor(context.env),
      );
      return yield* Schema.encodeUnknownEffect(
        GetPersonalExperimentalFeaturesResponseSchema,
      )({ status: "success", data: responseData(view) });
    }).pipe(Effect.provide(servicesFor(db)));
  });
  const result = await Effect.runPromise(Effect.result(operation));
  return Result.isSuccess(result)
    ? context.json(result.success, 200)
    : failureResponse(context, result.failure);
});

personalExperimentalFeaturesRoutes.put("/", async (context) => {
  const operation = Effect.gen(function* () {
    const input = yield* decodeJsonBody(
      context.req,
      UpdatePersonalExperimentalFeatureRequestSchema,
      () => new InvalidExperimentalFeatureRequest(),
    );
    const db = yield* decodeD1Binding(context.env.DB);
    return yield* Effect.gen(function* () {
      const service = yield* ExperimentalFeaturesService;
      const view = yield* service.updatePersonal(
        context.get("principal"),
        experimentalFeatureRegistryFor(context.env),
        input,
        context.get("requestId"),
      );
      return yield* Schema.encodeUnknownEffect(
        UpdatePersonalExperimentalFeatureResponseSchema,
      )({ status: "success", data: responseData(view) });
    }).pipe(Effect.provide(servicesFor(db)));
  });
  const result = await Effect.runPromise(Effect.result(operation));
  return Result.isSuccess(result)
    ? context.json(result.success, 200)
    : failureResponse(context, result.failure);
});
