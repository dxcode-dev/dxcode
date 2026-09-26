import { Context, type Effect, Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import { Timestamp } from "../persistence/timestamp.js";
import { UserId } from "../users/user-id.js";
import {
  ExperimentalFeaturePreference,
  type ExperimentalFeaturePreference as ExperimentalFeaturePreferenceType,
} from "./experimental-feature.js";

export const ExperimentalFeaturePreferencesRevision = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("@dx/ExperimentalFeaturePreferencesRevision"));

export type ExperimentalFeaturePreferencesRevision =
  typeof ExperimentalFeaturePreferencesRevision.Type;

export const PersonalExperimentalFeaturePreferences = Schema.Struct({
  userId: UserId,
  preferences: Schema.Array(ExperimentalFeaturePreference),
  revision: ExperimentalFeaturePreferencesRevision,
  updatedAt: Schema.NullOr(Timestamp),
});

export type PersonalExperimentalFeaturePreferences =
  typeof PersonalExperimentalFeaturePreferences.Type;

export class ExperimentalFeaturePreferencesConflict extends Schema.TaggedError<ExperimentalFeaturePreferencesConflict>()(
  "ExperimentalFeaturePreferencesConflict",
  { currentRevision: ExperimentalFeaturePreferencesRevision },
) {}

export interface ExperimentalFeaturePreferencesRepositoryShape {
  readonly get: (
    userId: UserId,
  ) => Effect.Effect<
    PersonalExperimentalFeaturePreferences,
    Schema.SchemaError | PersistenceUnavailable
  >;
  readonly put: (
    userId: UserId,
    preferences: ReadonlyArray<ExperimentalFeaturePreferenceType>,
    expectedRevision: ExperimentalFeaturePreferencesRevision,
  ) => Effect.Effect<
    PersonalExperimentalFeaturePreferences,
    | Schema.SchemaError
    | PersistenceUnavailable
    | ExperimentalFeaturePreferencesConflict
  >;
}

export class ExperimentalFeaturePreferencesRepository extends Context.Service<
  ExperimentalFeaturePreferencesRepository,
  ExperimentalFeaturePreferencesRepositoryShape
>()("@dx/domain/settings/ExperimentalFeaturePreferencesRepository") {}
