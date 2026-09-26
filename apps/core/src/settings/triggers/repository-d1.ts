import {
  PersistenceUnavailable,
  PluginTriggerConflict,
  type PluginTriggerId,
  PluginTriggerNotFound,
  PluginTriggerRepository,
  StoredPluginTrigger,
  Timestamp,
  type UserId,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";

const TriggerRow = Schema.Struct({
  id: Schema.String,
  owner_user_id: Schema.String,
  plugin_id: Schema.String,
  plugin_version: Schema.String,
  capability_name: Schema.String,
  source: Schema.String,
  event_type: Schema.String,
  action_name: Schema.String,
  idempotent: Schema.Finite,
  status: Schema.String,
  capability_hash: Schema.String,
  hmac_reference_json: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
  rotated_at: Schema.String,
  revoked_at: Schema.NullOr(Schema.String),
});

type TriggerRow = typeof TriggerRow.Type;

const columns = `
  id, owner_user_id, plugin_id, plugin_version, capability_name, source,
  event_type, action_name, idempotent, status, capability_hash,
  hmac_reference_json, created_at, updated_at, rotated_at, revoked_at
`;

const unavailable = (operation: string) => (cause: unknown) =>
  PersistenceUnavailable.new({ operation }, cause);

const timestamp = (value: typeof Timestamp.Type) =>
  Schema.encodeSync(Timestamp)(value);

const decode = Effect.fn("PluginTriggerRepository.decode")(function* (
  row: TriggerRow,
) {
  const hmacSecretReference =
    row.hmac_reference_json === null
      ? undefined
      : yield* Effect.try({
          try: () => JSON.parse(row.hmac_reference_json as string) as unknown,
          catch: unavailable("settings.triggers.decodeReference"),
        });
  return yield* Schema.decodeUnknownEffect(StoredPluginTrigger)({
    id: row.id,
    ownerUserId: row.owner_user_id,
    pluginId: row.plugin_id,
    pluginVersion: row.plugin_version,
    capabilityName: row.capability_name,
    source: row.source,
    event: row.event_type,
    action: row.action_name,
    idempotent: row.idempotent === 1,
    status: row.status,
    capabilityHash: row.capability_hash,
    ...(hmacSecretReference === undefined ? {} : { hmacSecretReference }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rotatedAt: row.rotated_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  });
});

const conflictOrUnavailable = (operation: string) => (cause: unknown) =>
  String(cause).includes("UNIQUE") || String(cause).includes("PRIMARY KEY")
    ? new PluginTriggerConflict()
    : unavailable(operation)(cause);

export const PluginTriggerRepositoryD1 = (db: D1Database) =>
  Layer.effect(
    PluginTriggerRepository,
    Effect.gen(function* () {
      const query = Effect.fn("PluginTriggerRepository.query")(function* (
        suffix: string,
        bindings: ReadonlyArray<unknown>,
        operation: string,
      ) {
        const result = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(`SELECT ${columns} FROM plugin_trigger ${suffix}`)
              .bind(...bindings)
              .all(),
          catch: unavailable(operation),
        });
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(TriggerRow),
        )(result.results);
        return yield* Effect.all(rows.map(decode));
      });

      const find = Effect.fn("PluginTriggerRepository.find")(function* (
        ownerUserId: UserId,
        id: PluginTriggerId,
      ) {
        const rows = yield* query(
          "WHERE owner_user_id = ? AND id = ? LIMIT 1",
          [ownerUserId, id],
          "settings.triggers.find",
        );
        if (rows[0] === undefined) return yield* new PluginTriggerNotFound();
        return rows[0];
      });

      return PluginTriggerRepository.of({
        list: (ownerUserId) =>
          query(
            "WHERE owner_user_id = ? ORDER BY created_at DESC, id DESC",
            [ownerUserId],
            "settings.triggers.list",
          ),
        find,
        findIngress: Effect.fn("PluginTriggerRepository.findIngress")(
          function* (id) {
            const rows = yield* query(
              "WHERE id = ? LIMIT 1",
              [id],
              "settings.triggers.findIngress",
            );
            if (rows[0] === undefined)
              return yield* new PluginTriggerNotFound();
            return rows[0];
          },
        ),
        insert: Effect.fn("PluginTriggerRepository.insert")(
          function* (trigger) {
            yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `INSERT INTO plugin_trigger (
                     id, owner_user_id, plugin_id, plugin_version,
                     capability_name, source, event_type, action_name,
                     idempotent, status, capability_hash, hmac_reference_json,
                     created_at, updated_at, rotated_at
                   ) VALUES (?, ?, ?, ?, ?, 'webhook', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  )
                  .bind(
                    trigger.id,
                    trigger.ownerUserId,
                    trigger.pluginId,
                    trigger.pluginVersion,
                    trigger.capabilityName,
                    trigger.event,
                    trigger.action,
                    trigger.idempotent ? 1 : 0,
                    trigger.status,
                    trigger.capabilityHash,
                    trigger.hmacSecretReference === undefined
                      ? null
                      : JSON.stringify(trigger.hmacSecretReference),
                    timestamp(trigger.createdAt),
                    timestamp(trigger.updatedAt),
                    timestamp(trigger.rotatedAt),
                  )
                  .run(),
              catch: conflictOrUnavailable("settings.triggers.insert"),
            });
          },
        ),
        updateStatus: Effect.fn("PluginTriggerRepository.updateStatus")(
          function* (ownerUserId, id, status, updatedAt) {
            const result = yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `UPDATE plugin_trigger
                        SET status = ?, updated_at = ?,
                            revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END
                      WHERE owner_user_id = ? AND id = ?
                        AND status != 'revoked'`,
                  )
                  .bind(
                    status,
                    timestamp(updatedAt),
                    status,
                    timestamp(updatedAt),
                    ownerUserId,
                    id,
                  )
                  .run(),
              catch: unavailable("settings.triggers.updateStatus"),
            });
            if (result.meta.changes !== 1)
              return yield* new PluginTriggerNotFound();
          },
        ),
        rotateCapability: Effect.fn("PluginTriggerRepository.rotateCapability")(
          function* (ownerUserId, id, hash, rotatedAt) {
            const result = yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `UPDATE plugin_trigger
                      SET capability_hash = ?, rotated_at = ?, updated_at = ?
                    WHERE owner_user_id = ? AND id = ?
                      AND status != 'revoked'`,
                  )
                  .bind(
                    hash,
                    timestamp(rotatedAt),
                    timestamp(rotatedAt),
                    ownerUserId,
                    id,
                  )
                  .run(),
              catch: unavailable("settings.triggers.rotateCapability"),
            });
            if (result.meta.changes !== 1)
              return yield* new PluginTriggerNotFound();
          },
        ),
        recordAudit: Effect.fn("PluginTriggerRepository.recordAudit")(
          function* (record) {
            yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `INSERT INTO plugin_trigger_audit (
                       audit_id, trigger_id, owner_user_id, action, outcome,
                       request_id, created_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  )
                  .bind(
                    record.auditId,
                    record.triggerId,
                    record.ownerUserId,
                    record.action,
                    record.outcome,
                    record.requestId,
                    timestamp(record.createdAt),
                  )
                  .run(),
              catch: unavailable("settings.triggers.recordAudit"),
            });
          },
        ),
      });
    }),
  );
