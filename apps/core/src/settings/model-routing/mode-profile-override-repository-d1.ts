import {
  ModeProfileOverride,
  ModeProfileOverrideRepository,
  PersistenceUnavailable,
  Timestamp,
} from "@dx/domain";
import { Effect, Layer, Option, Schema } from "effect";

const OverrideRow = Schema.Struct({
  user_id: Schema.String,
  profile_id: Schema.String,
  mode: Schema.String,
  config: Schema.String,
  updated_at: Schema.String,
});

const decodeRow = (row: typeof OverrideRow.Type) =>
  Effect.gen(function* () {
    const config = yield* Effect.try({
      try: () => JSON.parse(row.config) as unknown,
      catch: (cause) =>
        PersistenceUnavailable.new(
          { operation: "settings.modelRouting.decodeModeOverride" },
          cause,
        ),
    });
    return yield* Schema.decodeUnknownEffect(ModeProfileOverride)({
      userId: row.user_id,
      profileId: row.profile_id,
      mode: row.mode,
      config,
      updatedAt: row.updated_at,
    });
  });

export const ModeProfileOverrideRepositoryD1 = (db: D1Database) =>
  Layer.effect(
    ModeProfileOverrideRepository,
    Effect.gen(function* () {
      const unavailable = (operation: string) => (cause: unknown) =>
        PersistenceUnavailable.new({ operation }, cause);

      const listOverrides = Effect.fn(
        "ModeProfileOverrideRepository.listOverrides",
      )(function* (userId, profileId) {
        const result = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `SELECT user_id, profile_id, mode, config, updated_at
                 FROM mode_profile_override
                 WHERE user_id = ? AND profile_id = ?
                 ORDER BY mode`,
              )
              .bind(userId, profileId)
              .all(),
          catch: unavailable("settings.modelRouting.listModeOverrides"),
        });
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(OverrideRow),
        )(result.results);
        return yield* Effect.all(rows.map(decodeRow));
      });

      return ModeProfileOverrideRepository.of({
        listOverrides,
        findOverride: Effect.fn("ModeProfileOverrideRepository.findOverride")(
          function* (userId, profileId, mode) {
            const result = yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `SELECT user_id, profile_id, mode, config, updated_at
                     FROM mode_profile_override
                     WHERE user_id = ? AND profile_id = ? AND mode = ?`,
                  )
                  .bind(userId, profileId, mode)
                  .all(),
              catch: unavailable("settings.modelRouting.findModeOverride"),
            });
            const rows = yield* Schema.decodeUnknownEffect(
              Schema.Array(OverrideRow),
            )(result.results);
            const row = rows[0];
            return row === undefined
              ? Option.none()
              : Option.some(yield* decodeRow(row));
          },
        ),
        upsertOverride: Effect.fn(
          "ModeProfileOverrideRepository.upsertOverride",
        )(function* (override) {
          const config = yield* Effect.try({
            try: () => JSON.stringify(override.config),
            catch: unavailable("settings.modelRouting.encodeModeOverride"),
          });
          yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `INSERT INTO mode_profile_override
                     (user_id, profile_id, mode, config, updated_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT (user_id, profile_id, mode)
                   DO UPDATE SET config = excluded.config,
                                 updated_at = excluded.updated_at`,
                )
                .bind(
                  override.userId,
                  override.profileId,
                  override.mode,
                  config,
                  Schema.encodeSync(Timestamp)(override.updatedAt),
                )
                .run(),
            catch: unavailable("settings.modelRouting.upsertModeOverride"),
          });
        }),
        removeOverride: Effect.fn(
          "ModeProfileOverrideRepository.removeOverride",
        )(function* (userId, profileId, mode) {
          yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `DELETE FROM mode_profile_override
                   WHERE user_id = ? AND profile_id = ? AND mode = ?`,
                )
                .bind(userId, profileId, mode)
                .run(),
            catch: unavailable("settings.modelRouting.removeModeOverride"),
          });
        }),
      });
    }),
  );
