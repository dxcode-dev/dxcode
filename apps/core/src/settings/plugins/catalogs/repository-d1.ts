import {
  MAX_PLUGIN_CATALOGS_PER_SCOPE,
  PersistenceUnavailable,
  PluginCatalogLimitReached,
  PluginCatalogNotFound,
  PluginCatalogRepository,
  PluginCatalogTaken,
  StoredPluginCatalog,
  Timestamp,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";

const CatalogRow = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  target_id: Schema.String,
  name: Schema.String,
  catalog_json: Schema.String,
  added_by_user_id: Schema.String,
  added_at: Schema.String,
  refreshed_at: Schema.String,
});

type CatalogRow = typeof CatalogRow.Type;

const unavailable = (operation: string) => (cause: unknown) =>
  PersistenceUnavailable.new({ operation }, cause);

const timestamp = (value: typeof Timestamp.Type) =>
  Schema.encodeSync(Timestamp)(value);

const taken = (operation: string) => (cause: unknown) =>
  String(cause).includes("UNIQUE")
    ? new PluginCatalogTaken()
    : unavailable(operation)(cause);

/** The parts of a catalog that live in catalog_json. */
const body = (catalog: StoredPluginCatalog) =>
  JSON.stringify({
    description: catalog.description,
    ...(catalog.ownerName === undefined
      ? {}
      : { ownerName: catalog.ownerName }),
    source: catalog.source,
    entries: catalog.entries,
    publishers: catalog.publishers,
  });

const decode = (row: CatalogRow) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(row.catalog_json) as Record<string, unknown>,
      catch: unavailable("settings.pluginCatalogs.decode"),
    });
    return yield* Schema.decodeUnknownEffect(StoredPluginCatalog)({
      ...parsed,
      id: row.id,
      target: { scope: row.scope, id: row.target_id },
      name: row.name,
      addedAt: row.added_at,
      addedByUserId: row.added_by_user_id,
      refreshedAt: row.refreshed_at,
    });
  });

const select = `SELECT id, scope, target_id, name, catalog_json,
                       added_by_user_id, added_at, refreshed_at
                  FROM plugin_catalog
                 WHERE scope = ? AND target_id = ?`;

export const PluginCatalogRepositoryD1 = (db: D1Database) => {
  const query = (sql: string, bindings: ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .prepare(sql)
            .bind(...bindings)
            .all(),
        catch: unavailable("settings.pluginCatalogs.query"),
      });
      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(CatalogRow))(
        result.results,
      );
      return yield* Effect.all(rows.map(decode));
    });
  return Layer.succeed(
    PluginCatalogRepository,
    PluginCatalogRepository.of({
      list: Effect.fn("PluginCatalogRepository.list")(function* (target) {
        return yield* query(`${select} ORDER BY name, id`, [
          target.scope,
          target.id,
        ]);
      }),
      find: Effect.fn("PluginCatalogRepository.find")(function* (target, id) {
        const [found] = yield* query(`${select} AND id = ? LIMIT 1`, [
          target.scope,
          target.id,
          id,
        ]);
        if (found === undefined) return yield* new PluginCatalogNotFound();
        return found;
      }),
      insert: Effect.fn("PluginCatalogRepository.insert")(function* (catalog) {
        // The limit is checked in the same statement as the insert, so
        // concurrent adds can't pass it together.
        const result = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `INSERT INTO plugin_catalog (
                   id, scope, target_id, name, repository, catalog_json,
                   added_by_user_id, added_at, refreshed_at
                 )
                 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
                  WHERE (SELECT COUNT(*) FROM plugin_catalog
                          WHERE scope = ?2 AND target_id = ?3) < ?10`,
              )
              .bind(
                catalog.id,
                catalog.target.scope,
                catalog.target.id,
                catalog.name,
                catalog.source.repository.toLowerCase(),
                body(catalog),
                catalog.addedByUserId,
                timestamp(catalog.addedAt),
                timestamp(catalog.refreshedAt),
                MAX_PLUGIN_CATALOGS_PER_SCOPE,
              )
              .run(),
          catch: taken("settings.pluginCatalogs.insert"),
        });
        if (result.meta.changes !== 1) {
          return yield* new PluginCatalogLimitReached();
        }
      }),
      replace: Effect.fn("PluginCatalogRepository.replace")(
        function* (catalog) {
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `UPDATE plugin_catalog
                      SET name = ?, catalog_json = ?, refreshed_at = ?
                    WHERE id = ? AND scope = ? AND target_id = ?`,
                )
                .bind(
                  catalog.name,
                  body(catalog),
                  timestamp(catalog.refreshedAt),
                  catalog.id,
                  catalog.target.scope,
                  catalog.target.id,
                )
                .run(),
            catch: taken("settings.pluginCatalogs.replace"),
          });
          if (result.meta.changes !== 1) {
            return yield* new PluginCatalogNotFound();
          }
        },
      ),
      remove: Effect.fn("PluginCatalogRepository.remove")(
        function* (target, id) {
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `DELETE FROM plugin_catalog
                    WHERE id = ? AND scope = ? AND target_id = ?`,
                )
                .bind(id, target.scope, target.id)
                .run(),
            catch: unavailable("settings.pluginCatalogs.remove"),
          });
          if (result.meta.changes !== 1) {
            return yield* new PluginCatalogNotFound();
          }
        },
      ),
    }),
  );
};
