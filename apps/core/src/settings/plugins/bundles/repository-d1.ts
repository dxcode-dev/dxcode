import {
  PersistenceUnavailable,
  PluginBundleRepository,
  PluginIntegrityConflict,
  PluginNotFound,
  StoredPluginBundle,
  Timestamp,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";

const BundleRow = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  target_id: Schema.String,
  name: Schema.String,
  enabled: Schema.Finite,
  active_version: Schema.String,
  updated_at: Schema.String,
  manifest_json: Schema.String,
  source_json: Schema.String,
  integrity: Schema.String,
  trusted_at: Schema.String,
  trusted_by_user_id: Schema.String,
});

type BundleRow = typeof BundleRow.Type;

const unavailable = (operation: string) => (cause: unknown) =>
  PersistenceUnavailable.new({ operation }, cause);

const encodedTimestamp = (value: typeof Timestamp.Type) =>
  Schema.encodeSync(Timestamp)(value);

const bundleSelect = `
  SELECT trusted_plugin.id AS id,
         trusted_plugin.scope AS scope,
         trusted_plugin.target_id AS target_id,
         trusted_plugin.name AS name,
         trusted_plugin.enabled AS enabled,
         trusted_plugin.active_version AS active_version,
         trusted_plugin.updated_at AS updated_at,
         version.manifest_json AS manifest_json,
         version.source_json AS source_json,
         version.integrity AS integrity,
         version.trusted_at AS trusted_at,
         version.trusted_by_user_id AS trusted_by_user_id
    FROM trusted_plugin
    JOIN trusted_plugin_version version
      ON version.plugin_id = trusted_plugin.id
     AND version.version = trusted_plugin.active_version
   WHERE trusted_plugin.kind = 'bundle'
     AND trusted_plugin.removed_at IS NULL
     AND trusted_plugin.scope = ?
     AND trusted_plugin.target_id = ?`;

export const PluginBundleRepositoryD1 = (db: D1Database) =>
  Layer.succeed(
    PluginBundleRepository,
    PluginBundleRepository.of({
      list: Effect.fn("PluginBundleRepository.list")(function* (target) {
        return yield* query(
          db,
          `${bundleSelect} ORDER BY trusted_plugin.name, trusted_plugin.id`,
          [target.scope, target.id],
        );
      }),
      find: Effect.fn("PluginBundleRepository.find")(function* (target, id) {
        const found = yield* query(
          db,
          `${bundleSelect} AND trusted_plugin.id = ? LIMIT 1`,
          [target.scope, target.id, id],
        );
        if (found[0] === undefined) return yield* new PluginNotFound();
        return found[0];
      }),
      names: Effect.fn("PluginBundleRepository.names")(function* (target) {
        const result = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `SELECT name FROM trusted_plugin
                  WHERE scope = ? AND target_id = ? AND removed_at IS NULL`,
              )
              .bind(target.scope, target.id)
              .all<{ name: string }>(),
          catch: unavailable("settings.pluginBundles.names"),
        });
        return result.results.map(({ name }) => name);
      }),
      insert: Effect.fn("PluginBundleRepository.insert")(function* (bundle) {
        yield* Effect.tryPromise({
          try: () =>
            db.batch([
              // A removed plugin keeps its row for audit but gives its name up.
              db
                .prepare(
                  `UPDATE trusted_plugin SET name = id
                    WHERE scope = ? AND target_id = ? AND name = ?
                      AND removed_at IS NOT NULL`,
                )
                .bind(bundle.target.scope, bundle.target.id, bundle.name),
              db
                .prepare(
                  `INSERT INTO trusted_plugin (
                     id, scope, target_id, name, enabled, active_version,
                     health_status, created_at, updated_at, kind
                   ) VALUES (?, ?, ?, ?, ?, ?, 'unchecked', ?, ?, 'bundle')`,
                )
                .bind(
                  bundle.id,
                  bundle.target.scope,
                  bundle.target.id,
                  bundle.name,
                  bundle.enabled ? 1 : 0,
                  bundle.version,
                  encodedTimestamp(bundle.installedAt),
                  encodedTimestamp(bundle.updatedAt),
                ),
              db
                .prepare(
                  `INSERT INTO trusted_plugin_version (
                     plugin_id, version, manifest_json, grants_json,
                     source_json, integrity, trusted, trusted_at,
                     trusted_by_user_id
                   ) VALUES (?, ?, ?, '{}', ?, ?, 1, ?, ?)`,
                )
                .bind(
                  bundle.id,
                  bundle.version,
                  JSON.stringify(bundle.manifest),
                  JSON.stringify(bundle.source),
                  bundle.integrity,
                  encodedTimestamp(bundle.installedAt),
                  bundle.installedByUserId,
                ),
            ]),
          catch: (cause) =>
            String(cause).includes("UNIQUE")
              ? new PluginIntegrityConflict()
              : unavailable("settings.pluginBundles.insert")(cause),
        });
      }),
      setEnabled: Effect.fn("PluginBundleRepository.setEnabled")(
        function* (target, id, enabled, updatedAt) {
          yield* change(
            db,
            `UPDATE trusted_plugin SET enabled = ?, updated_at = ?
              WHERE id = ? AND scope = ? AND target_id = ? AND kind = 'bundle'
                AND removed_at IS NULL`,
            [
              enabled ? 1 : 0,
              encodedTimestamp(updatedAt),
              id,
              target.scope,
              target.id,
            ],
            "settings.pluginBundles.setEnabled",
          );
        },
      ),
      remove: Effect.fn("PluginBundleRepository.remove")(
        function* (target, id, removedAt) {
          const at = encodedTimestamp(removedAt);
          yield* change(
            db,
            `UPDATE trusted_plugin
                SET enabled = 0, updated_at = ?, removed_at = ?
              WHERE id = ? AND scope = ? AND target_id = ? AND kind = 'bundle'
                AND removed_at IS NULL`,
            [at, at, id, target.scope, target.id],
            "settings.pluginBundles.remove",
          );
        },
      ),
    }),
  );

const change = (
  db: D1Database,
  sql: string,
  bindings: ReadonlyArray<unknown>,
  operation: string,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(sql)
          .bind(...bindings)
          .run(),
      catch: unavailable(operation),
    });
    if (result.meta.changes !== 1) return yield* new PluginNotFound();
  });

const query = (db: D1Database, sql: string, bindings: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(sql)
          .bind(...bindings)
          .all(),
      catch: unavailable("settings.pluginBundles.query"),
    });
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(BundleRow))(
      result.results,
    );
    return yield* Effect.all(rows.map(decodeBundle));
  });

const decodeBundle = (row: BundleRow) =>
  Effect.gen(function* () {
    const [manifest, source] = yield* Effect.try({
      try: () =>
        [JSON.parse(row.manifest_json), JSON.parse(row.source_json)] as const,
      catch: unavailable("settings.pluginBundles.decode"),
    });
    return yield* Schema.decodeUnknownEffect(StoredPluginBundle)({
      id: row.id,
      target: { scope: row.scope, id: row.target_id },
      name: row.name,
      enabled: row.enabled === 1,
      version: row.active_version,
      manifest,
      source,
      integrity: row.integrity,
      installedAt: row.trusted_at,
      installedByUserId: row.trusted_by_user_id,
      updatedAt: row.updated_at,
    });
  });
