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
import { SqlClient } from "effect/sql/SqlClient";
import { settingsPersistenceLogger } from "../../logging.js";

const PersonalAccountRow = Schema.Struct({
  user_id: Schema.String,
  display_name: Schema.String,
  username: Schema.String,
  email: Schema.String,
  email_verified: Schema.Literals([0, 1]),
  identity_authority: Schema.String,
  appearance: Schema.String,
  palette: Schema.String,
  terminal_theme: Schema.String,
  text_size: Schema.String,
  thread_width: Schema.String,
  terminal_appearance: Schema.String,
  code_font_family: Schema.NullOr(Schema.String),
  code_font_size: Schema.NullOr(Schema.String),
  code_line_height: Schema.NullOr(Schema.String),
  logo_animation: Schema.Literals([0, 1]),
  ui_sounds: Schema.Literals([0, 1]),
  avatar_key: Schema.NullOr(Schema.String),
});

const UpdatedRow = Schema.Struct({ user_id: Schema.String });

/** 1 when a nullable field was sent, so `null` clears it. */
const sets = (value: unknown) => (value === undefined ? 0 : 1);

/** A switch as its 0 or 1 column, or `null` to keep the stored value. */
const flag = (value: boolean | undefined) =>
  value === undefined ? null : value ? 1 : 0;

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
            profile.text_size,
            profile.thread_width,
            profile.terminal_appearance,
            profile.code_font_family,
            profile.code_font_size,
            profile.code_line_height,
            profile.logo_animation,
            profile.ui_sounds,
            profile.avatar_key,
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
            END AS identity_authority
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
          appearance: row.appearance,
          palette: row.palette,
          terminalTheme: row.terminal_theme,
          textSize: row.text_size,
          threadWidth: row.thread_width,
          terminalAppearance: row.terminal_appearance,
          codeFontFamily: row.code_font_family,
          codeFontSize: row.code_font_size,
          codeLineHeight: row.code_line_height,
          logoAnimation: row.logo_animation === 1,
          uiSounds: row.ui_sounds === 1,
          ...(row.avatar_key === null ? {} : { avatarKey: row.avatar_key }),
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
      countThreadsOwnedByUser: Effect.fn(
        "PersonalAccountRepository.countThreadsOwnedByUser",
      )(function* (userId) {
        const rows = yield* sql<{ readonly thread_count: number }>`
          SELECT count(*) AS thread_count
          FROM threads
          WHERE owner_user_id = ${userId}
        `.pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(
              unavailable("settings.personalAccount.countThreadsOwnedByUser")(
                cause,
              ),
            ),
          ),
        );
        return rows[0]?.thread_count ?? 0;
      }),
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
            text_size = COALESCE(${input.textSize ?? null}, text_size),
            thread_width = COALESCE(${input.threadWidth ?? null}, thread_width),
            terminal_appearance = COALESCE(
              ${input.terminalAppearance ?? null},
              terminal_appearance
            ),
            code_font_family = CASE
              WHEN ${sets(input.codeFontFamily)} = 1
                THEN ${input.codeFontFamily ?? null}
              ELSE code_font_family
            END,
            code_font_size = CASE
              WHEN ${sets(input.codeFontSize)} = 1
                THEN ${input.codeFontSize ?? null}
              ELSE code_font_size
            END,
            logo_animation = COALESCE(
              ${flag(input.logoAnimation)},
              logo_animation
            ),
            ui_sounds = COALESCE(${flag(input.uiSounds)}, ui_sounds),
            code_line_height = CASE
              WHEN ${sets(input.codeLineHeight)} = 1
                THEN ${input.codeLineHeight ?? null}
              ELSE code_line_height
            END,
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
