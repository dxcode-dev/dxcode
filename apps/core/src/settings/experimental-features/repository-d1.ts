import {
  ExperimentalFeaturePreference,
  ExperimentalFeaturePreferencesConflict,
  ExperimentalFeaturePreferencesRepository,
  PersistenceUnavailable,
  PersonalExperimentalFeaturePreferences,
  Timestamp,
  type UserId,
} from "@dx/domain";
import { DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const PreferencesRow = Schema.Struct({
  user_id: Schema.String,
  preferences: Schema.String,
  revision: Schema.Number,
  updated_at: Schema.String,
});

const decodeRow = Effect.fn("decodeExperimentalFeaturePreferencesRow")(
  function* (row: typeof PreferencesRow.Type) {
    const preferences = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(ExperimentalFeaturePreference)),
    )(row.preferences);
    return yield* Schema.decodeUnknownEffect(
      PersonalExperimentalFeaturePreferences,
    )({
      userId: row.user_id,
      preferences,
      revision: row.revision,
      updatedAt: row.updated_at,
    });
  },
);

export const ExperimentalFeaturePreferencesRepositoryD1 = Layer.effect(
  ExperimentalFeaturePreferencesRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const unavailable = (operation: string) => (cause: unknown) =>
      PersistenceUnavailable.new({ operation }, cause);

    const get = Effect.fn("ExperimentalFeaturePreferencesRepository.get")(
      function* (userId: UserId) {
        const rows = yield* sql`
          SELECT user_id, preferences, revision, updated_at
          FROM personal_experimental_feature_preferences
          WHERE user_id = ${userId}
        `.pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(
              unavailable("experimentalFeatures.preferences.get")(cause),
            ),
          ),
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Array(PreferencesRow)),
          ),
        );
        const row = rows[0];
        return row === undefined
          ? yield* Schema.decodeUnknownEffect(
              PersonalExperimentalFeaturePreferences,
            )({
              userId,
              preferences: [],
              revision: 0,
              updatedAt: null,
            })
          : yield* decodeRow(row);
      },
    );

    return ExperimentalFeaturePreferencesRepository.of({
      get,
      put: Effect.fn("ExperimentalFeaturePreferencesRepository.put")(
        function* (userId, preferences, expectedRevision) {
          const encodedPreferences = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Array(ExperimentalFeaturePreference)),
          )(preferences);
          const updatedAt = yield* DateTime.now.pipe(
            Effect.flatMap(Schema.encodeEffect(Timestamp)),
          );
          const rows = yield* sql`
            INSERT INTO personal_experimental_feature_preferences (
              user_id, preferences, revision, updated_at
            )
            SELECT ${userId}, ${encodedPreferences}, 1, ${updatedAt}
            WHERE ${expectedRevision} = 0
              OR EXISTS (
                SELECT 1 FROM personal_experimental_feature_preferences
                WHERE user_id = ${userId} AND revision = ${expectedRevision}
              )
            ON CONFLICT(user_id) DO UPDATE SET
              preferences = excluded.preferences,
              revision = personal_experimental_feature_preferences.revision + 1,
              updated_at = excluded.updated_at
            WHERE personal_experimental_feature_preferences.revision = ${expectedRevision}
            RETURNING user_id, preferences, revision, updated_at
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(
                unavailable("experimentalFeatures.preferences.put")(cause),
              ),
            ),
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Array(PreferencesRow)),
            ),
          );
          const row = rows[0];
          if (row !== undefined) return yield* decodeRow(row);
          const current = yield* get(userId);
          return yield* new ExperimentalFeaturePreferencesConflict({
            currentRevision: current.revision,
          });
        },
      ),
    });
  }),
);
