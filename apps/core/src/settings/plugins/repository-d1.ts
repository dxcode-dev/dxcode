import {
  PersistenceUnavailable,
  type PluginId,
  PluginIntegrityConflict,
  PluginInvocationForbidden,
  PluginNotFound,
  PluginRepository,
  type PluginTarget,
  type PluginVersion,
  StoredPlugin,
  StoredPluginVersion,
  Timestamp,
  type UserId,
} from "@dx/domain";
import { Effect, Layer, Schema, SchemaTransformation } from "effect";

const PluginRow = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  target_id: Schema.String,
  name: Schema.String,
  enabled: Schema.Finite,
  active_version: Schema.String,
  health_status: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  removed_at: Schema.NullOr(Schema.String),
});

type PluginRow = typeof PluginRow.Type;

const PluginVersionRow = Schema.Struct({
  plugin_id: Schema.String,
  version: Schema.String,
  manifest_json: Schema.String,
  grants_json: Schema.String,
  source_json: Schema.String,
  integrity: Schema.String,
  trusted: Schema.Finite,
  trusted_at: Schema.String,
  trusted_by_user_id: Schema.String,
});

type PluginVersionRow = typeof PluginVersionRow.Type;

const PluginFileRow = Schema.Struct({
  path: Schema.String,
  media_type: Schema.String,
  content: Schema.String,
  size_bytes: Schema.Finite,
  integrity: Schema.String,
});

const pluginColumns = `
  id, scope, target_id, name, enabled, active_version, health_status,
  created_at, updated_at, removed_at
`;

const qualifiedPluginColumns = `
  trusted_plugin.id AS id,
  trusted_plugin.scope AS scope,
  trusted_plugin.target_id AS target_id,
  trusted_plugin.name AS name,
  trusted_plugin.enabled AS enabled,
  trusted_plugin.active_version AS active_version,
  trusted_plugin.health_status AS health_status,
  trusted_plugin.created_at AS created_at,
  trusted_plugin.updated_at AS updated_at,
  trusted_plugin.removed_at AS removed_at
`;

const unavailable = (operation: string) => (cause: unknown) =>
  PersistenceUnavailable.new({ operation }, cause);

const JsonString = Schema.String.pipe(
  Schema.decodeTo(Schema.Unknown, SchemaTransformation.fromJsonString()),
);

const integrityConflictOrUnavailable =
  (operation: string) => (cause: unknown) =>
    String(cause).includes("UNIQUE") || String(cause).includes("PRIMARY KEY")
      ? new PluginIntegrityConflict()
      : unavailable(operation)(cause);

const encodedTimestamp = (value: typeof Timestamp.Type) =>
  Schema.encodeSync(Timestamp)(value);

const decodeJson = Schema.decodeUnknownEffect(JsonString);

const decodePlugin = (row: PluginRow) =>
  Schema.decodeUnknownEffect(StoredPlugin)({
    id: row.id,
    target: { scope: row.scope, id: row.target_id },
    name: row.name,
    enabled: row.enabled === 1,
    activeVersion: row.active_version,
    healthStatus: row.health_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.removed_at === null ? {} : { removedAt: row.removed_at }),
  });

export const PluginRepositoryD1 = (db: D1Database) =>
  Layer.effect(
    PluginRepository,
    Effect.gen(function* () {
      const queryPlugins = Effect.fn("PluginRepository.queryPlugins")(
        function* (
          suffix: string,
          bindings: ReadonlyArray<unknown>,
          operation: string,
        ) {
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `SELECT ${pluginColumns} FROM trusted_plugin ${suffix}`,
                )
                .bind(...bindings)
                .all(),
            catch: unavailable(operation),
          });
          const rows = yield* Schema.decodeUnknownEffect(
            Schema.Array(PluginRow),
          )(result.results);
          return yield* Effect.all(rows.map(decodePlugin));
        },
      );

      const fileRows = Effect.fn("PluginRepository.fileRows")(function* (
        pluginId: PluginId,
        version: PluginVersion,
      ) {
        const result = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `SELECT path, media_type, content, size_bytes, integrity
                   FROM trusted_plugin_file
                  WHERE plugin_id = ? AND version = ?
                  ORDER BY path`,
              )
              .bind(pluginId, version)
              .all(),
          catch: unavailable("settings.plugins.files"),
        });
        return yield* Schema.decodeUnknownEffect(Schema.Array(PluginFileRow))(
          result.results,
        );
      });

      const decodeVersion = Effect.fn("PluginRepository.decodeVersion")(
        function* (row: PluginVersionRow) {
          const [manifest, grants, source] = yield* Effect.all([
            decodeJson(row.manifest_json),
            decodeJson(row.grants_json),
            decodeJson(row.source_json),
          ]).pipe(
            Effect.mapError(unavailable("settings.plugins.decodeVersion")),
          );
          const files = yield* fileRows(
            row.plugin_id as PluginId,
            row.version as PluginVersion,
          );
          return yield* Schema.decodeUnknownEffect(StoredPluginVersion)({
            pluginId: row.plugin_id,
            version: row.version,
            manifest,
            files: files.map((file) => ({
              path: file.path,
              mediaType: file.media_type,
              content: file.content,
              sizeBytes: file.size_bytes,
              integrity: file.integrity,
            })),
            source,
            integrity: row.integrity,
            grants,
            trusted: row.trusted === 1,
            trustedAt: row.trusted_at,
            trustedByUserId: row.trusted_by_user_id,
          });
        },
      );

      const findVersion = Effect.fn("PluginRepository.findVersion")(function* (
        id: PluginId,
        version: PluginVersion,
      ) {
        const row = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `SELECT plugin_id, version, manifest_json, grants_json,
                          source_json, integrity, trusted, trusted_at,
                          trusted_by_user_id
                     FROM trusted_plugin_version
                    WHERE plugin_id = ? AND version = ? LIMIT 1`,
              )
              .bind(id, version)
              .first(),
          catch: unavailable("settings.plugins.findVersion"),
        });
        if (row === null) return yield* new PluginNotFound();
        const decoded =
          yield* Schema.decodeUnknownEffect(PluginVersionRow)(row);
        return yield* decodeVersion(decoded);
      });

      const hydrate = Effect.fn("PluginRepository.hydrate")(function* (
        plugins: ReadonlyArray<typeof StoredPlugin.Type>,
      ) {
        return yield* Effect.all(
          plugins.map((plugin) =>
            Effect.gen(function* () {
              const active = yield* findVersion(
                plugin.id,
                plugin.activeVersion,
              ).pipe(
                Effect.catchTag("PluginNotFound", (cause) =>
                  Effect.fail(
                    PersistenceUnavailable.new(
                      { operation: "settings.plugins.hydrateActiveVersion" },
                      cause,
                    ),
                  ),
                ),
              );
              const result = yield* Effect.tryPromise({
                try: () =>
                  db
                    .prepare(
                      `SELECT version FROM trusted_plugin_version
                        WHERE plugin_id = ? ORDER BY trusted_at DESC, version DESC`,
                    )
                    .bind(plugin.id)
                    .all<{ version: string }>(),
                catch: unavailable("settings.plugins.listVersions"),
              });
              return {
                plugin,
                active,
                versions: result.results.map(
                  ({ version }) => version as PluginVersion,
                ),
              };
            }),
          ),
        );
      });

      const list = Effect.fn("PluginRepository.list")(function* (
        target: PluginTarget,
      ) {
        const plugins = yield* queryPlugins(
          `WHERE scope = ? AND target_id = ? AND removed_at IS NULL
           ORDER BY name, id`,
          [target.scope, target.id],
          "settings.plugins.list",
        );
        return yield* hydrate(plugins);
      });

      const find = Effect.fn("PluginRepository.find")(function* (
        target: PluginTarget,
        id: PluginId,
      ) {
        const plugins = yield* queryPlugins(
          `WHERE scope = ? AND target_id = ? AND id = ?
             AND removed_at IS NULL LIMIT 1`,
          [target.scope, target.id, id],
          "settings.plugins.find",
        );
        if (plugins[0] === undefined) return yield* new PluginNotFound();
        const hydrated = yield* hydrate([plugins[0]]);
        if (hydrated[0] === undefined) return yield* new PluginNotFound();
        return hydrated[0];
      });

      const listEffectiveForUser = Effect.fn(
        "PluginRepository.listEffectiveForUser",
      )(function* (ownerUserId: UserId) {
        const plugins = yield* queryPlugins(
          `WHERE enabled = 1 AND removed_at IS NULL
             AND (
               (
                 scope = 'workspace' AND EXISTS (
                   SELECT 1 FROM member
                    WHERE member.userId = ?
                      AND member.organizationId = trusted_plugin.target_id
                 )
               )
               OR (
                 scope = 'personal' AND target_id = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM member
                   JOIN trusted_plugin_workspace_policy policy
                     ON policy.workspace_id = member.organizationId
                  WHERE member.userId = ?
                    AND policy.allow_personal_plugins = 0
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM member
                   JOIN trusted_plugin workspace_plugin
                     ON workspace_plugin.scope = 'workspace'
                    AND workspace_plugin.target_id = member.organizationId
                    AND workspace_plugin.name = trusted_plugin.name
                    AND workspace_plugin.enabled = 1
                    AND workspace_plugin.removed_at IS NULL
                  WHERE member.userId = ?
                 )
               )
             )
           ORDER BY name, scope DESC, id`,
          [ownerUserId, ownerUserId, ownerUserId, ownerUserId],
          "settings.plugins.listEffectiveForUser",
        );
        return yield* hydrate(plugins);
      });

      const versionStatement = (version: typeof StoredPluginVersion.Type) =>
        db
          .prepare(
            `INSERT INTO trusted_plugin_version (
               plugin_id, version, manifest_json, grants_json, source_json,
               integrity, trusted, trusted_at, trusted_by_user_id
             ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .bind(
            version.pluginId,
            version.version,
            JSON.stringify(version.manifest),
            JSON.stringify(version.grants),
            JSON.stringify(version.source),
            version.integrity,
            encodedTimestamp(version.trustedAt),
            version.trustedByUserId,
          );

      const fileStatements = (version: typeof StoredPluginVersion.Type) =>
        version.files.map((file) =>
          db
            .prepare(
              `INSERT INTO trusted_plugin_file (
                 plugin_id, version, path, media_type, content, size_bytes,
                 integrity
               ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              version.pluginId,
              version.version,
              file.path,
              file.mediaType,
              file.content,
              file.sizeBytes,
              file.integrity,
            ),
        );

      return PluginRepository.of({
        list,
        find,
        findVersion,
        insert: Effect.fn("PluginRepository.insert")(
          function* (plugin, version) {
            yield* Effect.tryPromise({
              try: () =>
                db.batch([
                  db
                    .prepare(
                      `INSERT INTO trusted_plugin (
                         id, scope, target_id, name, enabled, active_version,
                         health_status, created_at, updated_at
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .bind(
                      plugin.id,
                      plugin.target.scope,
                      plugin.target.id,
                      plugin.name,
                      plugin.enabled ? 1 : 0,
                      plugin.activeVersion,
                      plugin.healthStatus,
                      encodedTimestamp(plugin.createdAt),
                      encodedTimestamp(plugin.updatedAt),
                    ),
                  versionStatement(version),
                  ...fileStatements(version),
                ]),
              catch: integrityConflictOrUnavailable("settings.plugins.insert"),
            });
          },
        ),
        insertVersion: Effect.fn("PluginRepository.insertVersion")(
          function* (target, version, activate, updatedAt) {
            yield* find(target, version.pluginId);
            yield* Effect.tryPromise({
              try: () =>
                db.batch([
                  versionStatement(version),
                  ...fileStatements(version),
                  ...(activate
                    ? [
                        db
                          .prepare(
                            `UPDATE trusted_plugin
                                SET active_version = ?, health_status = 'unchecked',
                                    updated_at = ?
                              WHERE id = ? AND scope = ? AND target_id = ?
                                AND removed_at IS NULL`,
                          )
                          .bind(
                            version.version,
                            encodedTimestamp(updatedAt),
                            version.pluginId,
                            target.scope,
                            target.id,
                          ),
                      ]
                    : []),
                ]),
              catch: integrityConflictOrUnavailable(
                "settings.plugins.insertVersion",
              ),
            });
          },
        ),
        updateState: Effect.fn("PluginRepository.updateState")(
          function* (target, id, input, updatedAt) {
            const current = yield* find(target, id);
            if (input.activeVersion !== undefined) {
              yield* findVersion(id, input.activeVersion);
            }
            const result = yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `UPDATE trusted_plugin
                        SET enabled = ?, active_version = ?, health_status = ?,
                            updated_at = ?, removed_at = ?
                      WHERE id = ? AND scope = ? AND target_id = ?
                        AND removed_at IS NULL`,
                  )
                  .bind(
                    (input.enabled ?? current.plugin.enabled) ? 1 : 0,
                    input.activeVersion ?? current.plugin.activeVersion,
                    input.healthStatus ??
                      (input.activeVersion === undefined
                        ? current.plugin.healthStatus
                        : "unchecked"),
                    encodedTimestamp(updatedAt),
                    input.removedAt === undefined
                      ? null
                      : encodedTimestamp(input.removedAt),
                    id,
                    target.scope,
                    target.id,
                  )
                  .run(),
              catch: unavailable("settings.plugins.updateState"),
            });
            if (result.meta.changes !== 1) return yield* new PluginNotFound();
          },
        ),
        listEffectiveForThread: Effect.fn(
          "PluginRepository.listEffectiveForThread",
        )((ownerUserId, _projectId) => listEffectiveForUser(ownerUserId)),
        listEffectiveForUser,
        findAuthorizedInvocation: Effect.fn(
          "PluginRepository.findAuthorizedInvocation",
        )(function* (threadId, pluginId, version) {
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `SELECT ${qualifiedPluginColumns}
                     FROM trusted_plugin
                     JOIN threads ON threads.id = ?
                    WHERE trusted_plugin.id = ?
                      AND trusted_plugin.enabled = 1
                      AND trusted_plugin.removed_at IS NULL
                      AND EXISTS (
                        SELECT 1 FROM json_each(threads.plugin_snapshot_json)
                         WHERE json_extract(json_each.value, '$.id') = ?
                           AND json_extract(json_each.value, '$.version') = ?
                           AND json_extract(json_each.value, '$.integrity') = (
                             SELECT integrity
                               FROM trusted_plugin_version
                              WHERE plugin_id = ? AND version = ?
                           )
                      )
                      AND (
                        (
                          trusted_plugin.scope = 'workspace'
                          AND EXISTS (
                            SELECT 1 FROM member
                             WHERE member.userId = threads.owner_user_id
                               AND member.organizationId = trusted_plugin.target_id
                          )
                        )
                        OR (
                          trusted_plugin.scope = 'personal'
                          AND trusted_plugin.target_id = threads.owner_user_id
                          AND NOT EXISTS (
                            SELECT 1 FROM member
                            JOIN trusted_plugin_workspace_policy policy
                              ON policy.workspace_id = member.organizationId
                           WHERE member.userId = threads.owner_user_id
                             AND policy.allow_personal_plugins = 0
                          )
                          AND NOT EXISTS (
                            SELECT 1 FROM member
                            JOIN trusted_plugin workspace_plugin
                              ON workspace_plugin.scope = 'workspace'
                             AND workspace_plugin.target_id = member.organizationId
                             AND workspace_plugin.name = trusted_plugin.name
                             AND workspace_plugin.enabled = 1
                             AND workspace_plugin.removed_at IS NULL
                           WHERE member.userId = threads.owner_user_id
                          )
                        )
                      )
                    LIMIT 1`,
                )
                .bind(threadId, pluginId, pluginId, version, pluginId, version)
                .first(),
            catch: unavailable("settings.plugins.authorizeInvocation"),
          });
          if (result === null) return yield* new PluginInvocationForbidden();
          const row = yield* Schema.decodeUnknownEffect(PluginRow)(result);
          const plugin = yield* decodePlugin(row);
          const active = yield* findVersion(pluginId, version).pipe(
            Effect.mapError(() => new PluginInvocationForbidden()),
          );
          return {
            plugin,
            active,
            versions: [active.version],
          };
        }),
        recordInvocation: Effect.fn("PluginRepository.recordInvocation")(
          function* (input) {
            yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `INSERT INTO trusted_plugin_invocation_audit (
                       invocation_id, thread_id, plugin_id, version,
                       capability_kind, capability_name, outcome, duration_ms,
                       created_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  )
                  .bind(
                    input.invocationId,
                    input.threadId,
                    input.pluginId,
                    input.version,
                    input.capabilityKind,
                    input.capabilityName,
                    input.outcome,
                    input.durationMs,
                    encodedTimestamp(input.createdAt),
                  )
                  .run(),
              catch: unavailable("settings.plugins.recordInvocation"),
            });
          },
        ),
        getWorkspacePolicy: Effect.fn("PluginRepository.getWorkspacePolicy")(
          function* (workspaceId) {
            const row = yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `SELECT allow_personal_plugins
                       FROM trusted_plugin_workspace_policy
                      WHERE workspace_id = ?`,
                  )
                  .bind(workspaceId)
                  .first<{ allow_personal_plugins: number }>(),
              catch: unavailable("settings.plugins.getWorkspacePolicy"),
            });
            return row?.allow_personal_plugins !== 0;
          },
        ),
        setWorkspacePolicy: Effect.fn("PluginRepository.setWorkspacePolicy")(
          function* (workspaceId, allowPersonal) {
            yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `INSERT INTO trusted_plugin_workspace_policy (
                       workspace_id, allow_personal_plugins
                     ) VALUES (?, ?)
                     ON CONFLICT(workspace_id) DO UPDATE SET
                       allow_personal_plugins = excluded.allow_personal_plugins`,
                  )
                  .bind(workspaceId, allowPersonal ? 1 : 0)
                  .run(),
              catch: unavailable("settings.plugins.setWorkspacePolicy"),
            });
          },
        ),
      });
    }),
  );
