import {
  PersistenceUnavailable,
  type SkillId,
  SkillIntegrityConflict,
  SkillNotFound,
  SkillRepository,
  SkillResource,
  type SkillTarget,
  type SkillVersion,
  StoredSkill,
  StoredSkillVersion,
  Timestamp,
} from "@dx/domain";
import { Effect, Layer, Schema, SchemaTransformation } from "effect";
import { pluginRunsForOwnerSql } from "../plugins/bundles/overlap.js";
import {
  putSkillFiles,
  readSkillFileContent,
  storesInR2,
} from "./file-store.js";

const SkillRow = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  target_id: Schema.String,
  name: Schema.String,
  enabled: Schema.Finite,
  active_version: Schema.Finite,
  pinned: Schema.Finite,
  plugin_id: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
  removed_at: Schema.NullOr(Schema.String),
});

type SkillRow = typeof SkillRow.Type;

const SkillVersionRow = Schema.Struct({
  skill_id: Schema.String,
  version: Schema.Finite,
  description: Schema.String,
  instructions: Schema.String,
  manifest_json: Schema.String,
  mcp_server_ids_json: Schema.String,
  source_type: Schema.String,
  source_label: Schema.String,
  source_json: Schema.NullOr(Schema.String),
  integrity: Schema.String,
  created_at: Schema.String,
  created_by_user_id: Schema.String,
});

type SkillVersionRow = typeof SkillVersionRow.Type;

const SkillResourceRow = Schema.Struct({
  skill_id: Schema.String,
  version: Schema.Finite,
  path: Schema.String,
  media_type: Schema.String,
  size_bytes: Schema.Finite,
  integrity: Schema.String,
});

const SkillFileRow = Schema.Struct({
  ...SkillResourceRow.fields,
  /** NULL while the content is in R2. */
  content: Schema.NullOr(Schema.String),
});

/** Resource rows go in as JSON chunks this large, under D1's value limit. */
const RESOURCE_CHUNK_BYTES = 900_000;

/** A skill with its active version's columns and its files and versions as JSON. */
const HydratedSkillRow = Schema.Struct({
  ...SkillRow.fields,
  version_skill_id: Schema.NullOr(Schema.String),
  version_version: Schema.NullOr(Schema.Finite),
  version_description: Schema.NullOr(Schema.String),
  version_instructions: Schema.NullOr(Schema.String),
  version_manifest_json: Schema.NullOr(Schema.String),
  version_mcp_server_ids_json: Schema.NullOr(Schema.String),
  version_source_type: Schema.NullOr(Schema.String),
  version_source_label: Schema.NullOr(Schema.String),
  version_source_json: Schema.NullOr(Schema.String),
  version_integrity: Schema.NullOr(Schema.String),
  version_created_at: Schema.NullOr(Schema.String),
  version_created_by_user_id: Schema.NullOr(Schema.String),
  resources_json: Schema.String,
  versions_json: Schema.String,
});

const skillColumns = `
  id, scope, target_id, name, enabled, active_version, pinned, plugin_id,
  created_at, updated_at, removed_at
`;

const unavailable = (operation: string) => (cause: unknown) =>
  PersistenceUnavailable.new({ operation }, cause);

const JsonString = Schema.String.pipe(
  Schema.decodeTo(Schema.Unknown, SchemaTransformation.fromJsonString()),
);

const integrityConflictOrUnavailable =
  (operation: string) => (cause: unknown) =>
    String(cause).includes("UNIQUE")
      ? new SkillIntegrityConflict()
      : unavailable(operation)(cause);

const encodedTimestamp = (value: typeof Timestamp.Type) =>
  Schema.encodeSync(Timestamp)(value);

const decodeJson = Schema.decodeUnknownEffect(JsonString);

/** What a source records beyond its type and label, or NULL for none. */
const sourceJson = (source: (typeof StoredSkillVersion.Type)["source"]) => {
  if (source.type !== "github") return null;
  const { type: _type, label: _label, ...details } = source;
  return JSON.stringify(details);
};

const decodeSkill = (row: SkillRow) =>
  Schema.decodeUnknownEffect(StoredSkill)({
    id: row.id,
    target: { scope: row.scope, id: row.target_id },
    name: row.name,
    enabled: row.enabled === 1,
    activeVersion: row.active_version,
    pinned: row.pinned === 1,
    ...(row.plugin_id === null ? {} : { pluginId: row.plugin_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.removed_at === null ? {} : { removedAt: row.removed_at }),
  });

/** True while a workspace the user `owner` belongs to blocks personal skills. */
const personalBlockedSqlFor = (owner: string) => `EXISTS (
  SELECT 1 FROM member
  JOIN skill_workspace_policy policy
    ON policy.workspace_id = member.organizationId
 WHERE member.userId = ${owner}
   AND policy.allow_personal_skills = 0
)`;

const personalBlockedSql = personalBlockedSqlFor("?");

/**
 * Skills in D1, with the content of large files in `bucket` (see
 * file-store.ts).
 */
export const SkillRepositoryD1 = (db: D1Database, bucket?: R2Bucket) =>
  Layer.effect(
    SkillRepository,
    Effect.gen(function* () {
      const versionColumns = `
        version.skill_id, version.version, version.description,
        version.instructions, version.manifest_json,
        version.mcp_server_ids_json, version.source_type, version.source_label,
        version.source_json, version.integrity, version.created_at, version.created_by_user_id
      `;
      const resourceColumns = `
        resource.skill_id, resource.version, resource.path,
        resource.media_type, resource.size_bytes, resource.integrity
      `;

      const decodeVersion = Effect.fn("SkillRepository.decodeVersion")(
        function* (
          row: SkillVersionRow,
          resources: ReadonlyArray<typeof SkillResourceRow.Type>,
        ) {
          const manifest = yield* decodeJson(row.manifest_json).pipe(
            Effect.mapError(unavailable("settings.skills.decodeManifest")),
          );
          const mcpServerIds = yield* decodeJson(row.mcp_server_ids_json).pipe(
            Effect.mapError(unavailable("settings.skills.decodeMcpReferences")),
          );
          const sourceDetails =
            row.source_json === null
              ? {}
              : yield* decodeJson(row.source_json).pipe(
                  Effect.mapError(unavailable("settings.skills.decodeSource")),
                );
          return yield* Schema.decodeUnknownEffect(StoredSkillVersion)({
            skillId: row.skill_id,
            version: row.version,
            manifest: {
              ...(manifest as object),
              mcpServerIds,
            },
            instructions: row.instructions,
            resources: resources.map((resource) => ({
              path: resource.path,
              mediaType: resource.media_type,
              sizeBytes: resource.size_bytes,
              integrity: resource.integrity,
            })),
            source: {
              ...(sourceDetails as object),
              type: row.source_type,
              label: row.source_label,
            },
            integrity: row.integrity,
            createdAt: row.created_at,
            createdByUserId: row.created_by_user_id,
          });
        },
      );

      /** One version with its resource files, in one round trip. */
      const findVersion = Effect.fn("SkillRepository.findVersion")(function* (
        id: SkillId,
        version: SkillVersion,
      ) {
        const [versions, resources] = yield* Effect.tryPromise({
          try: () =>
            db.batch([
              db
                .prepare(
                  `SELECT ${versionColumns} FROM skill_version AS version
                    WHERE version.skill_id = ? AND version.version = ?`,
                )
                .bind(id, version),
              db
                .prepare(
                  `SELECT ${resourceColumns} FROM skill_resource AS resource
                    WHERE resource.skill_id = ? AND resource.version = ?
                    ORDER BY resource.path`,
                )
                .bind(id, version),
            ]),
          catch: unavailable("settings.skills.findVersion"),
        });
        const row = versions?.results[0];
        if (row === undefined) return yield* new SkillNotFound();
        return yield* decodeVersion(
          yield* Schema.decodeUnknownEffect(SkillVersionRow)(row),
          yield* Schema.decodeUnknownEffect(Schema.Array(SkillResourceRow))(
            resources?.results ?? [],
          ),
        );
      });

      /**
       * The skills `where` selects, each with its active version, that
       * version's resource files, and its version numbers, in one statement
       * and one round trip however many skills match. `where` must qualify
       * skill columns as `skill.`.
       */
      const querySkills = Effect.fn("SkillRepository.querySkills")(function* (
        where: string,
        order: string,
        bindings: ReadonlyArray<unknown>,
        operation: string,
      ) {
        const result = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `SELECT ${skillColumns.replace(/(\w+)/g, "skill.$1")},
                        version.skill_id AS version_skill_id,
                        version.version AS version_version,
                        version.description AS version_description,
                        version.instructions AS version_instructions,
                        version.manifest_json AS version_manifest_json,
                        version.mcp_server_ids_json AS version_mcp_server_ids_json,
                        version.source_type AS version_source_type,
                        version.source_label AS version_source_label,
                        version.source_json AS version_source_json,
                        version.integrity AS version_integrity,
                        version.created_at AS version_created_at,
                        version.created_by_user_id AS version_created_by_user_id,
                        (SELECT json_group_array(json_object(
                                  'skill_id', resource.skill_id,
                                  'version', resource.version,
                                  'path', resource.path,
                                  'media_type', resource.media_type,
                                  'size_bytes', resource.size_bytes,
                                  'integrity', resource.integrity))
                           FROM (SELECT * FROM skill_resource
                                  WHERE skill_id = skill.id
                                    AND version = skill.active_version
                                  ORDER BY path) AS resource
                        ) AS resources_json,
                        (SELECT json_group_array(numbered.version)
                           FROM (SELECT version FROM skill_version
                                  WHERE skill_id = skill.id
                                  ORDER BY version DESC) AS numbered
                        ) AS versions_json
                   FROM skill
                   LEFT JOIN skill_version AS version
                     ON version.skill_id = skill.id
                    AND version.version = skill.active_version
                  WHERE ${where}
                  ORDER BY ${order}`,
              )
              .bind(...bindings)
              .all(),
          catch: unavailable(operation),
        });
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(HydratedSkillRow),
        )(result.results);
        return yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const skill = yield* decodeSkill(row);
            if (row.version_skill_id === null) {
              return yield* Effect.fail(
                PersistenceUnavailable.new(
                  { operation: "settings.skills.hydrateActiveVersion" },
                  new SkillNotFound(),
                ),
              );
            }
            const resources = yield* decodeJson(row.resources_json).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.Array(SkillResourceRow)),
              ),
              Effect.mapError(unavailable("settings.skills.decodeResources")),
            );
            const versions = yield* decodeJson(row.versions_json).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.Array(Schema.Finite)),
              ),
              Effect.mapError(unavailable("settings.skills.decodeVersions")),
            );
            const active = yield* decodeVersion(
              {
                skill_id: row.version_skill_id,
                version: row.version_version ?? 0,
                description: row.version_description ?? "",
                instructions: row.version_instructions ?? "",
                manifest_json: row.version_manifest_json ?? "",
                mcp_server_ids_json: row.version_mcp_server_ids_json ?? "",
                source_type: row.version_source_type ?? "",
                source_label: row.version_source_label ?? "",
                source_json: row.version_source_json,
                integrity: row.version_integrity ?? "",
                created_at: row.version_created_at ?? "",
                created_by_user_id: row.version_created_by_user_id ?? "",
              },
              resources,
            );
            return {
              skill,
              active,
              versions: versions.map((version) => version as SkillVersion),
            };
          }),
        );
      });

      const list = Effect.fn("SkillRepository.list")(function* (
        target: SkillTarget,
      ) {
        return yield* querySkills(
          `skill.scope = ? AND skill.target_id = ? AND skill.removed_at IS NULL`,
          "skill.name, skill.id",
          [target.scope, target.id],
          "settings.skills.list",
        );
      });

      const find = Effect.fn("SkillRepository.find")(function* (
        target: SkillTarget,
        id: SkillId,
      ) {
        const skills = yield* querySkills(
          `skill.scope = ? AND skill.target_id = ? AND skill.id = ?
             AND skill.removed_at IS NULL`,
          "skill.id",
          [target.scope, target.id, id],
          "settings.skills.find",
        );
        if (skills[0] === undefined) return yield* new SkillNotFound();
        return skills[0];
      });

      /**
       * A batch may only write a version while `guard` holds; its bindings
       * follow the row's. Without one the row is always written.
       */
      interface Guard {
        readonly sql: string;
        readonly bindings: ReadonlyArray<unknown>;
      }
      const guarded = (columns: number, guard: Guard | undefined) =>
        guard === undefined
          ? `VALUES (${Array(columns).fill("?").join(", ")})`
          : `SELECT ${Array(columns).fill("?").join(", ")} WHERE ${guard.sql}`;

      const versionStatement = (
        version: typeof StoredSkillVersion.Type,
        guard?: Guard,
      ) =>
        db
          .prepare(
            `INSERT INTO skill_version (
               skill_id, version, description, instructions, manifest_json,
               mcp_server_ids_json, source_type, source_label, source_json,
               integrity, created_at, created_by_user_id
             ) ${guarded(12, guard)}`,
          )
          .bind(
            version.skillId,
            version.version,
            version.manifest.description,
            version.instructions,
            JSON.stringify({
              schemaVersion: version.manifest.schemaVersion,
              name: version.manifest.name,
              description: version.manifest.description,
            }),
            JSON.stringify(version.manifest.mcpServerIds),
            version.source.type,
            version.source.label,
            sourceJson(version.source),
            version.integrity,
            encodedTimestamp(version.createdAt),
            version.createdByUserId,
            ...(guard?.bindings ?? []),
          );

      /**
       * The version's resource rows, a few statements however many files:
       * each inserts a JSON chunk of rows. A file R2 holds has no content
       * in its row.
       */
      const resourceStatements = (
        version: typeof StoredSkillVersion.Type,
        files: ReadonlyArray<SkillResource>,
        guard?: Guard,
      ) => {
        const chunks: Array<Array<string>> = [];
        let chunkBytes = 0;
        for (const file of files) {
          const row = JSON.stringify({
            path: file.path,
            mediaType: file.mediaType,
            content: storesInR2(bucket, file.sizeBytes) ? null : file.content,
            sizeBytes: file.sizeBytes,
            integrity: file.integrity,
          });
          const current = chunks.at(-1);
          if (
            current === undefined ||
            chunkBytes + row.length > RESOURCE_CHUNK_BYTES
          ) {
            chunks.push([row]);
            chunkBytes = row.length;
          } else {
            current.push(row);
            chunkBytes += row.length;
          }
        }
        return chunks.map((rows) =>
          db
            .prepare(
              `INSERT INTO skill_resource (
                 skill_id, version, path, media_type, content, size_bytes, integrity
               )
               SELECT ?, ?, json_extract(value, '$.path'),
                      json_extract(value, '$.mediaType'),
                      json_extract(value, '$.content'),
                      json_extract(value, '$.sizeBytes'),
                      json_extract(value, '$.integrity')
                 FROM json_each(?)
                WHERE ${guard?.sql ?? "1"}`,
            )
            .bind(
              version.skillId,
              version.version,
              `[${rows.join(",")}]`,
              ...(guard?.bindings ?? []),
            ),
        );
      };

      /** Every file listed in `version.resources` must be in `files`. */
      const checkFiles = (
        version: typeof StoredSkillVersion.Type,
        files: ReadonlyArray<SkillResource>,
      ) => {
        const given = new Map(files.map((file) => [file.path, file]));
        return version.resources.length === files.length &&
          version.resources.every(
            (resource) =>
              given.get(resource.path)?.integrity === resource.integrity,
          )
          ? Effect.void
          : Effect.fail(
              PersistenceUnavailable.new(
                { operation: "settings.skills.checkFiles" },
                new Error("The files do not match the version's resources."),
              ),
            );
      };

      const storeLargeFiles = (files: ReadonlyArray<SkillResource>) =>
        Effect.tryPromise({
          try: () => putSkillFiles(bucket, files),
          catch: unavailable("settings.skills.putFiles"),
        });

      const readFiles = Effect.fn("SkillRepository.readFiles")(function* (
        id: SkillId,
        version: SkillVersion,
        paths?: ReadonlyArray<string>,
      ) {
        if (paths !== undefined && paths.length === 0) return [];
        const result = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `SELECT ${resourceColumns}, resource.content
                   FROM skill_resource AS resource
                  WHERE resource.skill_id = ? AND resource.version = ?
                    ${paths === undefined ? "" : "AND resource.path IN (SELECT value FROM json_each(?))"}
                  ORDER BY resource.path`,
              )
              .bind(
                id,
                version,
                ...(paths === undefined ? [] : [JSON.stringify(paths)]),
              )
              .all(),
          catch: unavailable("settings.skills.readFiles"),
        });
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(SkillFileRow),
        )(result.results);
        return yield* Effect.forEach(
          rows,
          (row) =>
            Effect.gen(function* () {
              const content = yield* Effect.tryPromise({
                try: () => readSkillFileContent(bucket, row),
                catch: unavailable("settings.skills.readFile"),
              });
              if (content === undefined) {
                return yield* Effect.fail(
                  PersistenceUnavailable.new(
                    { operation: "settings.skills.readFile" },
                    new Error(`The content of ${row.path} is missing.`),
                  ),
                );
              }
              return yield* Schema.decodeUnknownEffect(SkillResource)({
                path: row.path,
                mediaType: row.media_type,
                content,
                sizeBytes: row.size_bytes,
                integrity: row.integrity,
              });
            }),
          { concurrency: 8 },
        );
      });

      return SkillRepository.of({
        list,
        find,
        findVersion,
        readFiles,
        insert: Effect.fn("SkillRepository.insert")(
          function* (skill, version, files) {
            yield* checkFiles(version, files);
            yield* storeLargeFiles(files);
            yield* Effect.tryPromise({
              try: () =>
                db.batch([
                  // A removed skill keeps its row, so Threads that loaded it can
                  // still read its files, but gives its name up for a new one.
                  db
                    .prepare(
                      `UPDATE skill SET name = id
                      WHERE scope = ? AND target_id = ? AND name = ?
                        AND removed_at IS NOT NULL`,
                    )
                    .bind(skill.target.scope, skill.target.id, skill.name),
                  db
                    .prepare(
                      `INSERT INTO skill (
                       id, scope, target_id, name, enabled, active_version,
                       pinned, plugin_id, created_at, updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .bind(
                      skill.id,
                      skill.target.scope,
                      skill.target.id,
                      skill.name,
                      skill.enabled ? 1 : 0,
                      skill.activeVersion,
                      skill.pinned ? 1 : 0,
                      skill.pluginId ?? null,
                      encodedTimestamp(skill.createdAt),
                      encodedTimestamp(skill.updatedAt),
                    ),
                  versionStatement(version),
                  ...resourceStatements(version, files),
                ]),
              catch: integrityConflictOrUnavailable("settings.skills.insert"),
            });
          },
        ),
        insertVersion: Effect.fn("SkillRepository.insertVersion")(
          function* (target, version, files, activate, updatedAt) {
            yield* checkFiles(version, files);
            yield* storeLargeFiles(files);
            // Writes only into a live skill of this target, and activates
            // only an unpinned one, in a single round trip.
            const guard: Guard = {
              sql: `EXISTS (
                SELECT 1 FROM skill
                 WHERE id = ? AND scope = ? AND target_id = ?
                   AND removed_at IS NULL AND (pinned = 0 OR ? = 0)
              )`,
              bindings: [
                version.skillId,
                target.scope,
                target.id,
                activate ? 1 : 0,
              ],
            };
            const results = yield* Effect.tryPromise({
              try: () =>
                db.batch([
                  versionStatement(version, guard),
                  ...resourceStatements(version, files, guard),
                  ...(activate
                    ? [
                        db
                          .prepare(
                            `UPDATE skill SET active_version = ?, updated_at = ?
                              WHERE id = ? AND scope = ? AND target_id = ?
                                AND removed_at IS NULL AND pinned = 0
                                AND EXISTS (
                                  SELECT 1 FROM skill_version
                                   WHERE skill_id = skill.id AND version = ?
                                )`,
                          )
                          .bind(
                            version.version,
                            encodedTimestamp(updatedAt),
                            version.skillId,
                            target.scope,
                            target.id,
                            version.version,
                          ),
                      ]
                    : []),
                ]),
              catch: integrityConflictOrUnavailable(
                "settings.skills.insertVersion",
              ),
            });
            if ((results[0]?.meta.changes ?? 0) === 1) return;
            // Nothing was written: say whether the skill is gone or pinned.
            yield* find(target, version.skillId);
            return yield* new SkillIntegrityConflict();
          },
        ),
        updateState: Effect.fn("SkillRepository.updateState")(
          function* (target, id, input, updatedAt) {
            // Unset fields keep their stored value, and a new active version
            // must exist, so the change is one statement.
            const result = yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `UPDATE skill
                      SET enabled = COALESCE(?, enabled),
                          active_version = COALESCE(?, active_version),
                          pinned = COALESCE(?, pinned),
                          updated_at = ?, removed_at = ?
                    WHERE id = ? AND scope = ? AND target_id = ?
                      AND removed_at IS NULL
                      AND (? IS NULL OR EXISTS (
                        SELECT 1 FROM skill_version
                         WHERE skill_id = skill.id AND version = ?
                      ))`,
                  )
                  .bind(
                    input.enabled === undefined ? null : input.enabled ? 1 : 0,
                    input.activeVersion ?? null,
                    input.pinned === undefined ? null : input.pinned ? 1 : 0,
                    encodedTimestamp(updatedAt),
                    input.removedAt === undefined
                      ? null
                      : encodedTimestamp(input.removedAt),
                    id,
                    target.scope,
                    target.id,
                    input.activeVersion ?? null,
                    input.activeVersion ?? null,
                  )
                  .run(),
              catch: unavailable("settings.skills.updateState"),
            });
            if (result.meta.changes !== 1) return yield* new SkillNotFound();
          },
        ),
        listThreadCandidates: Effect.fn("SkillRepository.listThreadCandidates")(
          function* (ownerUserId) {
            return yield* querySkills(
              `skill.enabled = 1 AND skill.removed_at IS NULL
                 AND (
                   skill.plugin_id IS NULL OR EXISTS (
                     SELECT 1 FROM trusted_plugin
                      WHERE trusted_plugin.id = skill.plugin_id
                        AND ${pluginRunsForOwnerSql("trusted_plugin", "?1")}
                   )
                 )
                 AND (
                   (
                     skill.scope = 'personal' AND skill.target_id = ?1
                     AND NOT ${personalBlockedSqlFor("?1")}
                   )
                   OR (
                     skill.scope = 'workspace' AND EXISTS (
                       SELECT 1 FROM member
                        WHERE member.userId = ?1
                          AND member.organizationId = skill.target_id
                     )
                   )
                 )`,
              "skill.name, skill.scope, skill.id",
              [ownerUserId],
              "settings.skills.listThreadCandidates",
            );
          },
        ),
        personalSkillsBlocked: Effect.fn(
          "SkillRepository.personalSkillsBlocked",
        )(function* (ownerUserId) {
          const row = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(`SELECT ${personalBlockedSql} AS blocked`)
                .bind(ownerUserId)
                .first<{ blocked: number }>(),
            catch: unavailable("settings.skills.personalSkillsBlocked"),
          });
          return row?.blocked === 1;
        }),
        getWorkspacePolicy: Effect.fn("SkillRepository.getWorkspacePolicy")(
          function* (workspaceId) {
            const row = yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    "SELECT allow_personal_skills FROM skill_workspace_policy WHERE workspace_id = ?",
                  )
                  .bind(workspaceId)
                  .first<{ allow_personal_skills: number }>(),
              catch: unavailable("settings.skills.getWorkspacePolicy"),
            });
            return row?.allow_personal_skills !== 0;
          },
        ),
        setWorkspacePolicy: Effect.fn("SkillRepository.setWorkspacePolicy")(
          function* (workspaceId, allowPersonal) {
            yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `INSERT INTO skill_workspace_policy (
                       workspace_id, allow_personal_skills
                     ) VALUES (?, ?)
                     ON CONFLICT(workspace_id) DO UPDATE SET
                       allow_personal_skills = excluded.allow_personal_skills`,
                  )
                  .bind(workspaceId, allowPersonal ? 1 : 0)
                  .run(),
              catch: unavailable("settings.skills.setWorkspacePolicy"),
            });
          },
        ),
      });
    }),
  );
