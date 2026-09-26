import {
  decodeEnvironmentVariableAuditCursor,
  encodeEnvironmentVariableAuditCursor,
  EnvironmentVariableAuditEvent,
  EnvironmentVariableConflict,
  EnvironmentVariableNotFound,
  EnvironmentVariableRepository,
  InvalidPageCursor,
  PersistenceUnavailable,
  StoredEnvironmentVariable,
  Timestamp,
  type EnvironmentVariableAuditRecord,
  type EnvironmentVariableId,
  type EnvironmentVariableName,
  type EnvironmentVariableTarget,
} from "@dx/domain";
import { Effect, Layer, Option, Result, Schema } from "effect";
import { settingsPersistenceLogger } from "../../logging.js";

const EnvironmentVariableRow = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  target_id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  enabled: Schema.Number,
  envelope_version: Schema.Number,
  key_version: Schema.Number,
  value_nonce: Schema.String,
  ciphertext: Schema.String,
  wrapped_key_nonce: Schema.String,
  wrapped_key: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  rotated_at: Schema.String,
});

const columns = `
  id, scope, target_id, name, kind, enabled,
  envelope_version, key_version, value_nonce, ciphertext,
  wrapped_key_nonce, wrapped_key, created_at, updated_at, rotated_at
`;

const decodeRows = (input: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(EnvironmentVariableRow))(input).pipe(
    Effect.flatMap((rows) =>
      Effect.all(
        rows.map((row) =>
          Schema.decodeUnknownEffect(StoredEnvironmentVariable)({
            id: row.id,
            target: { scope: row.scope, id: row.target_id },
            name: row.name,
            kind: row.kind,
            enabled: row.enabled === 1,
            envelope: {
              version: row.envelope_version,
              keyVersion: row.key_version,
              valueNonce: row.value_nonce,
              ciphertext: row.ciphertext,
              wrappedKeyNonce: row.wrapped_key_nonce,
              wrappedKey: row.wrapped_key,
            },
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            rotatedAt: row.rotated_at,
          }),
        ),
      ),
    ),
  );

const encodedTimestamp = (value: typeof Timestamp.Type) =>
  Schema.encodeSync(Timestamp)(value);

const EnvironmentVariableAuditRow = Schema.Struct({
  id: Schema.String,
  variable_id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  action: Schema.String,
  actor_user_id: Schema.String,
  actor_name: Schema.String,
  request_id: Schema.String,
  occurred_at: Schema.String,
});

const insertValue = (db: D1Database, value: StoredEnvironmentVariable) =>
  db
    .prepare(
      `INSERT INTO environment_variable (
        id, scope, target_id, name, kind, enabled, policy_locked,
        envelope_version, key_version, value_nonce, ciphertext,
        wrapped_key_nonce, wrapped_key,
        created_at, updated_at, rotated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      value.id,
      value.target.scope,
      value.target.id,
      value.name,
      value.kind,
      value.enabled ? 1 : 0,
      value.envelope.version,
      value.envelope.keyVersion,
      value.envelope.valueNonce,
      value.envelope.ciphertext,
      value.envelope.wrappedKeyNonce,
      value.envelope.wrappedKey,
      encodedTimestamp(value.createdAt),
      encodedTimestamp(value.updatedAt),
      encodedTimestamp(value.rotatedAt),
    );

const replaceValue = (db: D1Database, value: StoredEnvironmentVariable) =>
  db
    .prepare(
      `UPDATE environment_variable
       SET kind = ?, enabled = ?, policy_locked = 0,
           envelope_version = ?, key_version = ?, value_nonce = ?,
           ciphertext = ?, wrapped_key_nonce = ?, wrapped_key = ?,
           updated_at = ?, rotated_at = ?
       WHERE scope = ? AND target_id = ? AND id = ?`,
    )
    .bind(
      value.kind,
      value.enabled ? 1 : 0,
      value.envelope.version,
      value.envelope.keyVersion,
      value.envelope.valueNonce,
      value.envelope.ciphertext,
      value.envelope.wrappedKeyNonce,
      value.envelope.wrappedKey,
      encodedTimestamp(value.updatedAt),
      encodedTimestamp(value.rotatedAt),
      value.target.scope,
      value.target.id,
      value.id,
    );

const insertAudit = (db: D1Database, audit: EnvironmentVariableAuditRecord) =>
  db
    .prepare(
      `INSERT INTO environment_variable_audit (
        id, scope, target_id, variable_id, name, kind, action,
        actor_user_id, request_id, occurred_at
      ) VALUES (
        CASE WHEN changes() = 1 THEN ? ELSE NULL END,
        ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`,
    )
    .bind(
      audit.id,
      audit.target.scope,
      audit.target.id,
      audit.variableId,
      audit.name,
      audit.kind,
      audit.action,
      audit.actorUserId,
      audit.requestId,
      encodedTimestamp(audit.occurredAt),
    );

export const EnvironmentVariableRepositoryD1 = (db: D1Database) =>
  Layer.effect(
    EnvironmentVariableRepository,
    Effect.gen(function* () {
      const unavailable = (operation: string) => (cause: unknown) =>
        PersistenceUnavailable.new({ operation }, cause);

      const query = Effect.fn("EnvironmentVariableRepository.query")(function* (
        target: EnvironmentVariableTarget,
        suffix: string,
        bindings: ReadonlyArray<unknown>,
        operation: string,
      ) {
        const result = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `SELECT ${columns}
                   FROM environment_variable
                   WHERE scope = ? AND target_id = ? ${suffix}`,
              )
              .bind(target.scope, target.id, ...bindings)
              .all(),
          catch: unavailable(operation),
        });
        return yield* decodeRows(result.results);
      });

      const find = Effect.fn("EnvironmentVariableRepository.find")(function* (
        target: EnvironmentVariableTarget,
        id: EnvironmentVariableId,
      ) {
        const values = yield* query(
          target,
          "AND id = ? LIMIT 1",
          [id],
          "settings.environmentVariables.find",
        );
        const value = values[0];
        if (value === undefined)
          return yield* new EnvironmentVariableNotFound();
        return value;
      });

      const findByName = Effect.fn("EnvironmentVariableRepository.findByName")(
        function* (
          target: EnvironmentVariableTarget,
          name: EnvironmentVariableName,
        ) {
          const values = yield* query(
            target,
            "AND name = ? LIMIT 1",
            [name],
            "settings.environmentVariables.findByName",
          );
          return Option.fromNullishOr(values[0]);
        },
      );

      return EnvironmentVariableRepository.of({
        list: (target) =>
          query(
            target,
            "ORDER BY name ASC, id ASC",
            [],
            "settings.environmentVariables.list",
          ),
        find,
        findByName,
        write: Effect.fn("EnvironmentVariableRepository.write")(
          function* (writes) {
            if (writes.length === 0) return;
            const statements = writes.flatMap((write) => [
              write.operation === "insert"
                ? insertValue(db, write.value)
                : replaceValue(db, write.value),
              insertAudit(db, write.audit),
            ]);
            const result = yield* Effect.result(
              Effect.tryPromise({
                try: () => db.batch(statements),
                catch: unavailable("settings.environmentVariables.write"),
              }),
            );
            if (Result.isFailure(result)) {
              for (const write of writes) {
                if (
                  write.operation === "insert" &&
                  Option.isSome(
                    yield* findByName(write.value.target, write.value.name),
                  )
                ) {
                  return yield* new EnvironmentVariableConflict();
                }
                if (write.operation === "replace") {
                  const current = yield* Effect.result(
                    find(write.value.target, write.value.id),
                  );
                  if (
                    Result.isFailure(current) &&
                    current.failure instanceof EnvironmentVariableNotFound
                  ) {
                    return yield* current.failure;
                  }
                }
              }
              return yield* result.failure;
            }
            for (const write of writes) {
              settingsPersistenceLogger.info(
                "Environment variable persistence succeeded.",
                {
                  event:
                    write.operation === "insert"
                      ? "environment_variable_persistence_created"
                      : "environment_variable_persistence_updated",
                  environmentVariableId: write.value.id,
                  scope: write.value.target.scope,
                },
              );
            }
          },
        ),
        remove: Effect.fn("EnvironmentVariableRepository.remove")(
          function* (target, id, audit) {
            yield* find(target, id);
            const result = yield* Effect.result(
              Effect.tryPromise({
                try: () =>
                  db.batch([
                    db
                      .prepare(
                        "DELETE FROM environment_variable WHERE scope = ? AND target_id = ? AND id = ?",
                      )
                      .bind(target.scope, target.id, id),
                    insertAudit(db, audit),
                  ]),
                catch: unavailable("settings.environmentVariables.remove"),
              }),
            );
            if (Result.isFailure(result)) {
              const current = yield* Effect.result(find(target, id));
              if (
                Result.isFailure(current) &&
                current.failure instanceof EnvironmentVariableNotFound
              ) {
                return yield* current.failure;
              }
              return yield* result.failure;
            }
            settingsPersistenceLogger.info(
              "Environment variable persistence succeeded.",
              {
                event: "environment_variable_persistence_deleted",
                environmentVariableId: id,
                scope: target.scope,
              },
            );
          },
        ),
        listAudit: Effect.fn("EnvironmentVariableRepository.listAudit")(
          function* (target, request) {
            const limit = request.limit ?? 20;
            const cursor =
              request.cursor === undefined
                ? undefined
                : yield* decodeEnvironmentVariableAuditCursor(request.cursor);
            if (
              cursor !== undefined &&
              (cursor.target.scope !== target.scope ||
                cursor.target.id !== target.id)
            ) {
              return yield* new InvalidPageCursor();
            }
            const conditions = ["audit.scope = ?", "audit.target_id = ?"];
            const bindings: Array<string | number> = [target.scope, target.id];
            if (cursor !== undefined) {
              conditions.push(
                "(audit.occurred_at < ? OR (audit.occurred_at = ? AND audit.id < ?))",
              );
              const occurredAt = encodedTimestamp(cursor.occurredAt);
              bindings.push(occurredAt, occurredAt, cursor.id);
            }
            bindings.push(limit + 1);
            const result = yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `SELECT audit.id, audit.variable_id, audit.name, audit.kind,
                            audit.action, audit.actor_user_id,
                            COALESCE(personal_account.display_name, user.name, 'Former user') AS actor_name,
                            audit.request_id, audit.occurred_at
                     FROM environment_variable_audit AS audit
                     LEFT JOIN user ON user.id = audit.actor_user_id
                     LEFT JOIN personal_account ON personal_account.user_id = audit.actor_user_id
                     WHERE ${conditions.join(" AND ")}
                     ORDER BY audit.occurred_at DESC, audit.id DESC
                     LIMIT ?`,
                  )
                  .bind(...bindings)
                  .all(),
              catch: unavailable("settings.environmentVariables.listAudit"),
            });
            const rows = yield* Schema.decodeUnknownEffect(
              Schema.Array(EnvironmentVariableAuditRow),
            )(result.results);
            const items = yield* Effect.all(
              rows.slice(0, limit).map((row) =>
                Schema.decodeUnknownEffect(EnvironmentVariableAuditEvent)({
                  id: row.id,
                  target,
                  variableId: row.variable_id,
                  name: row.name,
                  kind: row.kind,
                  action: row.action,
                  actorUserId: row.actor_user_id,
                  actorName: row.actor_name,
                  requestId: row.request_id,
                  occurredAt: row.occurred_at,
                }),
              ),
            );
            const last = items.at(-1);
            const nextCursor =
              rows.length > limit && last !== undefined
                ? yield* encodeEnvironmentVariableAuditCursor({
                    target,
                    occurredAt: last.occurredAt,
                    id: last.id,
                  })
                : undefined;
            return {
              items,
              ...(nextCursor === undefined ? {} : { nextCursor }),
            };
          },
        ),
      });
    }),
  );
