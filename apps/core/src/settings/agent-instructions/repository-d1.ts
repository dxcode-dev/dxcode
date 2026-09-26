import {
  PersistenceUnavailable,
  PersonalAgentInstructions,
  PersonalAgentInstructionsNotFound,
  PersonalAgentInstructionsRepository,
  PersonalAgentInstructionsRevisionConflict,
  type UserId,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { settingsPersistenceLogger } from "../../logging.js";

const PersonalAgentInstructionsRow = Schema.Struct({
  user_id: Schema.String,
  content: Schema.String,
  revision: Schema.Number,
  version: Schema.Number,
  updated_at: Schema.String,
});

const decodeRow = (row: typeof PersonalAgentInstructionsRow.Type) =>
  Schema.decodeUnknownEffect(PersonalAgentInstructions)({
    userId: row.user_id,
    content: row.content,
    revision: row.revision,
    version: row.version,
    updatedAt: row.updated_at,
  });

export const PersonalAgentInstructionsRepositoryD1 = Layer.effect(
  PersonalAgentInstructionsRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const unavailable = (operation: string) => (cause: unknown) =>
      PersistenceUnavailable.new({ operation }, cause);

    const find = Effect.fn(
      "PersonalAgentInstructionsRepository.findOwnedByUser",
    )(function* (userId: UserId) {
      const rows = yield* sql`
        SELECT user_id, content, revision, version, updated_at
        FROM personal_agent_instructions
        WHERE user_id = ${userId}
      `.pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            unavailable("settings.personalAgentInstructions.findOwnedByUser")(
              cause,
            ),
          ),
        ),
      );
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.Array(PersonalAgentInstructionsRow),
      )(rows);
      const row = decoded[0];
      if (row === undefined) {
        return yield* new PersonalAgentInstructionsNotFound();
      }
      return yield* decodeRow(row);
    });

    return PersonalAgentInstructionsRepository.of({
      findOwnedByUser: find,
      updateOwnedByUser: Effect.fn(
        "PersonalAgentInstructionsRepository.updateOwnedByUser",
      )(function* (userId, input) {
        const rows = yield* sql`
          UPDATE personal_agent_instructions
          SET
            content = ${input.content},
            revision = revision + 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE user_id = ${userId}
            AND revision = ${input.expectedRevision}
          RETURNING user_id, content, revision, version, updated_at
        `.pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(
              unavailable(
                "settings.personalAgentInstructions.updateOwnedByUser",
              )(cause),
            ),
          ),
        );
        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.Array(PersonalAgentInstructionsRow),
        )(rows);
        const row = decoded[0];
        if (row === undefined) {
          const current = yield* find(userId);
          return yield* new PersonalAgentInstructionsRevisionConflict({
            expectedRevision: input.expectedRevision,
            actualRevision: current.revision,
          });
        }
        const updated = yield* decodeRow(row);
        settingsPersistenceLogger.info(
          "Personal agent instructions update succeeded.",
          {
            event: "personal_agent_instructions_persistence_updated",
            userId,
            revision: updated.revision,
          },
        );
        return updated;
      }),
    });
  }),
);
