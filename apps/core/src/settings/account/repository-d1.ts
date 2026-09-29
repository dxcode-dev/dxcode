import {
  PersistenceUnavailable,
  PersonalAccount,
  PersonalAccountNotFound,
  PersonalAccountRepository,
  PersonalAccountUsernameUnavailable,
  PersonalComposerDefaults,
  type UserId,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { settingsPersistenceLogger } from "../../logging.js";

const PersonalAccountRow = Schema.Struct({
  user_id: Schema.String,
  display_name: Schema.String,
  username: Schema.String,
  email: Schema.String,
  email_verified: Schema.Literals([0, 1]),
  identity_authority: Schema.String,
  thread_count: Schema.Finite,
  appearance: Schema.String,
  palette: Schema.String,
  terminal_theme: Schema.String,
});

const UpdatedRow = Schema.Struct({ user_id: Schema.String });

const ComposerDefaultsRow = Schema.Struct({
  composer_project: Schema.NullOr(Schema.String),
  composer_mode: Schema.NullOr(Schema.String),
  composer_model: Schema.NullOr(Schema.String),
  composer_runner_profile_id: Schema.NullOr(Schema.String),
});

export const PersonalAccountRepositoryD1 = Layer.effect(
  PersonalAccountRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const unavailable = (operation: string) => (cause: unknown) =>
      PersistenceUnavailable.new({ operation }, cause);

    const find = Effect.fn("PersonalAccountRepository.findOwnedByUser")(
      function* (userId: UserId) {
        const rows = yield* sql`
          SELECT
            profile.user_id,
            profile.display_name,
            profile.username,
            profile.appearance,
            profile.palette,
            profile.terminal_theme,
            identity.email,
            identity.emailVerified AS email_verified,
            CASE
              WHEN EXISTS (
                SELECT 1 FROM account
                WHERE account.userId = profile.user_id
                  AND account.providerId = 'cloudflare-access'
              ) THEN 'cloudflare-access'
              WHEN EXISTS (
                SELECT 1 FROM account
                WHERE account.userId = profile.user_id
                  AND account.providerId = 'credential'
              ) THEN 'local-password'
              ELSE 'external'
            END AS identity_authority,
            (
              SELECT count(*)
              FROM threads
              WHERE threads.owner_user_id = profile.user_id
            ) AS thread_count
          FROM personal_account AS profile
          INNER JOIN "user" AS identity ON identity.id = profile.user_id
          WHERE profile.user_id = ${userId}
        `.pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(
              unavailable("settings.personalAccount.findOwnedByUser")(cause),
            ),
          ),
        );
        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.Array(PersonalAccountRow),
        )(rows);
        const row = decoded[0];
        if (row === undefined) return yield* new PersonalAccountNotFound();
        return yield* Schema.decodeUnknownEffect(PersonalAccount)({
          userId: row.user_id,
          displayName: row.display_name,
          username: row.username,
          email: row.email,
          emailVerified: row.email_verified === 1,
          identityAuthority: row.identity_authority,
          threadCount: row.thread_count,
          appearance: row.appearance,
          palette: row.palette,
          terminalTheme: row.terminal_theme,
        });
      },
    );

    const decodeComposerDefaults = Effect.fn(
      "PersonalAccountRepository.decodeComposerDefaults",
    )(function* (rows: unknown) {
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.Array(ComposerDefaultsRow),
      )(rows);
      const row = decoded[0];
      if (row === undefined) return yield* new PersonalAccountNotFound();
      return yield* Schema.decodeUnknownEffect(PersonalComposerDefaults)({
        project: row.composer_project,
        mode: row.composer_mode,
        model: row.composer_model,
        runnerProfileId: row.composer_runner_profile_id,
      });
    });

    return PersonalAccountRepository.of({
      findOwnedByUser: find,
      findComposerDefaultsOwnedByUser: Effect.fn(
        "PersonalAccountRepository.findComposerDefaultsOwnedByUser",
      )(function* (userId) {
        const rows = yield* sql`
          SELECT
            composer_project,
            composer_mode,
            composer_model,
            composer_runner_profile_id
          FROM personal_account
          WHERE user_id = ${userId}
        `.pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(
              unavailable(
                "settings.personalAccount.findComposerDefaultsOwnedByUser",
              )(cause),
            ),
          ),
        );
        return yield* decodeComposerDefaults(rows);
      }),
      updateComposerDefaultsOwnedByUser: Effect.fn(
        "PersonalAccountRepository.updateComposerDefaultsOwnedByUser",
      )(function* (userId, input) {
        const setsModel = input.model === undefined ? 0 : 1;
        const rows = yield* sql`
          UPDATE personal_account
          SET
            composer_project = COALESCE(${input.project ?? null}, composer_project),
            composer_mode = COALESCE(${input.mode ?? null}, composer_mode),
            composer_model = CASE
              WHEN ${setsModel} = 1 THEN ${input.model ?? null}
              ELSE composer_model
            END,
            composer_runner_profile_id = COALESCE(
              ${input.runnerProfileId ?? null},
              composer_runner_profile_id
            ),
            updated_at = datetime('now')
          WHERE user_id = ${userId}
          RETURNING
            composer_project,
            composer_mode,
            composer_model,
            composer_runner_profile_id
        `.pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(
              unavailable(
                "settings.personalAccount.updateComposerDefaultsOwnedByUser",
              )(cause),
            ),
          ),
        );
        return yield* decodeComposerDefaults(rows);
      }),
      updateOwnedByUser: Effect.fn(
        "PersonalAccountRepository.updateOwnedByUser",
      )(function* (userId, input) {
        const rows = yield* sql`
          UPDATE personal_account
          SET
            display_name = ${input.displayName},
            username = ${input.username},
            updated_at = datetime('now')
          WHERE user_id = ${userId}
            AND NOT EXISTS (
              SELECT 1
              FROM personal_account AS claimed
              WHERE claimed.username = ${input.username} COLLATE NOCASE
                AND claimed.user_id <> ${userId}
            )
          RETURNING user_id
        `.pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(
              unavailable("settings.personalAccount.updateOwnedByUser")(cause),
            ),
          ),
        );
        const updated = yield* Schema.decodeUnknownEffect(
          Schema.Array(UpdatedRow),
        )(rows);
        if (updated.length === 0) {
          const owners = yield* sql`
            SELECT user_id FROM personal_account WHERE user_id = ${userId}
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(
                unavailable("settings.personalAccount.updateOwnedByUser")(
                  cause,
                ),
              ),
            ),
          );
          const decodedOwners = yield* Schema.decodeUnknownEffect(
            Schema.Array(UpdatedRow),
          )(owners);
          if (decodedOwners.length === 0) {
            return yield* new PersonalAccountNotFound();
          }
          return yield* new PersonalAccountUsernameUnavailable();
        }
        settingsPersistenceLogger.info("Personal account update succeeded.", {
          event: "personal_account_persistence_updated",
          userId,
        });
        return yield* find(userId);
      }),
      updateAppearanceOwnedByUser: Effect.fn(
        "PersonalAccountRepository.updateAppearanceOwnedByUser",
      )(function* (userId, input) {
        const rows = yield* sql`
          UPDATE personal_account
          SET
            appearance = COALESCE(${input.appearance ?? null}, appearance),
            palette = COALESCE(${input.palette ?? null}, palette),
            terminal_theme = COALESCE(${input.terminalTheme ?? null}, terminal_theme),
            updated_at = datetime('now')
          WHERE user_id = ${userId}
          RETURNING user_id
        `.pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(
              unavailable(
                "settings.personalAccount.updateAppearanceOwnedByUser",
              )(cause),
            ),
          ),
        );
        const updated = yield* Schema.decodeUnknownEffect(
          Schema.Array(UpdatedRow),
        )(rows);
        if (updated.length === 0) return yield* new PersonalAccountNotFound();
        settingsPersistenceLogger.info(
          "Personal appearance update succeeded.",
          {
            event: "personal_appearance_persistence_updated",
            userId,
          },
        );
        return yield* find(userId);
      }),
    });
  }),
);
