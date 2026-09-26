import {
  ExperimentalFeatureId,
  ExperimentalFeaturePreferencesRevision,
  ExperimentalFeatureRegistration,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

export const ExperimentalFeatureDenialReasonSchema = Schema.Literals([
  "prerequisite-disabled",
  "incompatible-feature",
]);

export const ExperimentalFeaturePreferenceDataSchema = Schema.Struct({
  registration: ExperimentalFeatureRegistration,
  personalEnabled: Schema.Boolean,
  preferenceSource: Schema.Literals(["default", "personal"]),
  effectiveEnabled: Schema.Boolean,
  denialReason: Schema.optional(ExperimentalFeatureDenialReasonSchema),
  blockedBy: Schema.Array(ExperimentalFeatureId),
});

export type ExperimentalFeaturePreferenceData =
  typeof ExperimentalFeaturePreferenceDataSchema.Type;

export const PersonalExperimentalFeaturesDataSchema = Schema.Struct({
  registryVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  revision: ExperimentalFeaturePreferencesRevision,
  flags: Schema.Array(ExperimentalFeaturePreferenceDataSchema),
});

export type PersonalExperimentalFeaturesData =
  typeof PersonalExperimentalFeaturesDataSchema.Type;

export const GetPersonalExperimentalFeaturesResponseSchema = successResponse(
  PersonalExperimentalFeaturesDataSchema,
);

export const UpdatePersonalExperimentalFeatureRequestSchema = Schema.Struct({
  featureId: ExperimentalFeatureId,
  enabled: Schema.Boolean,
  expectedRevision: ExperimentalFeaturePreferencesRevision,
});

export type UpdatePersonalExperimentalFeatureRequest =
  typeof UpdatePersonalExperimentalFeatureRequestSchema.Type;

export const UpdatePersonalExperimentalFeatureResponseSchema =
  GetPersonalExperimentalFeaturesResponseSchema;

export const ExperimentalFeaturesInvalidRequestResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("INVALID_EXPERIMENTAL_FEATURE_PREFERENCE"),
    message: Schema.Literal("Experimental feature preference is invalid."),
    requestId: Schema.String,
    featureId: Schema.optional(ExperimentalFeatureId),
    reason: Schema.optional(
      Schema.Literals([
        "unknown-feature",
        "prerequisite-disabled",
        "incompatible-feature",
      ]),
    ),
    relatedFeatureId: Schema.optional(ExperimentalFeatureId),
  }),
});

export const ExperimentalFeaturesConflictResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("EXPERIMENTAL_FEATURE_PREFERENCES_CONFLICT"),
    message: Schema.Literal(
      "Experimental feature preferences changed in another session.",
    ),
    requestId: Schema.String,
    currentRevision: ExperimentalFeaturePreferencesRevision,
  }),
});

export const ExperimentalFeaturesForbiddenResponseSchema = errorResponse(
  "SETTINGS_SCOPE_FORBIDDEN",
  "The settings scope is unavailable for this user.",
);

export const ExperimentalFeaturesPersistenceUnavailableResponseSchema =
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Experimental feature preferences are temporarily unavailable.",
  );

export const ExperimentalFeaturesErrorResponseSchema = Schema.Union([
  ExperimentalFeaturesInvalidRequestResponseSchema,
  ExperimentalFeaturesConflictResponseSchema,
  ExperimentalFeaturesForbiddenResponseSchema,
  ExperimentalFeaturesPersistenceUnavailableResponseSchema,
]);
