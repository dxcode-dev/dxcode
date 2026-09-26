import {
  PersistenceUnavailable,
  SkillIntegrityConflict,
  SkillNotFound,
  SkillRepository,
  StoredSkill,
  StoredSkillVersion,
  Timestamp,
  type SkillId,
  type SkillTarget,
  type SkillVersion,
} from "@dx/domain";
import { Effect, Layer, Schema, SchemaTransformation } from "effect";

const SkillRow = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  target_id: Schema.String,
  name: Schema.String,
  enabled: Schema.Finite,
  active_version: Schema.Finite,
  pinned: Schema.Finite,
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
  integrity: Schema.String,
  created_at: Schema.String,
  created_by_user_id: Schema.String,
});

type SkillVersionRow = typeof SkillVersionRow.Type;

const SkillResourceRow = Schema.Struct({
  path: Schema.String,
  media_type: Schema.String,
  content: Schema.String,
  size_bytes: Schema.Finite,
  integrity: Schema.String,
});

const skillColumns = `
  id, scope, target_id, name, enabled, active_version, pinned,
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

const decodeSkill = (row: SkillRow) =>
  Schema.decodeUnknownEffect(StoredSkill)({
    id: row.id,
    target: { scope: row.scope, id: row.target_id },
    name: row.name,
    enabled: row.enabled === 1,
    activeVersion: row.active_version,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.removed_at === null ? {} : { removedAt: row.removed_at }),
  });

export const SkillRepositoryD1 = (db: D1Database) =>
  Layer.effect(
    SkillRepository,
    Effect.gen(function* () {
      const querySkills = Effect.fn("SkillRepository.querySkills")(function* (
        suffix: string,
        bindings: ReadonlyArray<unknown>,
        operation: string,
      ) {
        const result = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(`SELECT ${skillColumns} FROM skill ${suffix}`)
              .bind(...bindings)
              .all(),
          catch: unavailable(operation),
        });
        const rows = yield* Schema.decodeUnknownEffect(Schema.Array(SkillRow))(
          result.results,
        );
        return yield* Effect.all(rows.map(decodeSkill));
      });

      const resourceRows = Effect.fn("SkillRepository.resourceRows")(function* (
        skillId: SkillId,
        version: SkillVersion,
      ) {
        const result = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `SELECT path, media_type, content, size_bytes, integrity
                     FROM skill_resource
                    WHERE skill_id = ? AND version = ?
                    ORDER BY path`,
              )
              .bind(skillId, version)
              .all(),
          catch: unavailable("settings.skills.resources"),
        });
        return yield* Schema.decodeUnknownEffect(
          Schema.Array(SkillResourceRow),
        )(result.results);
      });

      const decodeVersion = Effect.fn("SkillRepository.decodeVersion")(
        function* (row: SkillVersionRow) {
          const manifest = yield* decodeJson(row.manifest_json).pipe(
            Effect.mapError(unavailable("settings.skills.decodeManifest")),
          );
          const mcpServerIds = yield* decodeJson(row.mcp_server_ids_json).pipe(
            Effect.mapError(unavailable("settings.skills.decodeMcpReferences")),
          );
          const resources = yield* resourceRows(
            row.skill_id as SkillId,
            row.version as SkillVersion,
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
              content: resource.content,
              sizeBytes: resource.size_bytes,
              integrity: resource.integrity,
            })),
            source: { type: row.source_type, label: row.source_label },
            integrity: row.integrity,
            createdAt: row.created_at,
            createdByUserId: row.created_by_user_id,
          });
        },
      );

      const findVersion = Effect.fn("SkillRepository.findVersion")(function* (
        id: SkillId,
        version: SkillVersion,
      ) {
        const row = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `SELECT skill_id, version, description, instructions,
                          manifest_json, mcp_server_ids_json, source_type,
                          source_label, integrity, created_at, created_by_user_id
                     FROM skill_version
                    WHERE skill_id = ? AND version = ? LIMIT 1`,
              )
              .bind(id, version)
              .first(),
          catch: unavailable("settings.skills.findVersion"),
        });
        if (row === null) return yield* new SkillNotFound();
        const decoded = yield* Schema.decodeUnknownEffect(SkillVersionRow)(row);
        return yield* decodeVersion(decoded);
      });

      const hydrate = Effect.fn("SkillRepository.hydrate")(function* (
        skills: ReadonlyArray<typeof StoredSkill.Type>,
      ) {
        return yield* Effect.all(
          skills.map((skill) =>
            Effect.gen(function* () {
              const active = yield* findVersion(
                skill.id,
                skill.activeVersion,
              ).pipe(
                Effect.catchTag("SkillNotFound", (cause) =>
                  Effect.fail(
                    PersistenceUnavailable.new(
                      { operation: "settings.skills.hydrateActiveVersion" },
                      cause,
                    ),
                  ),
                ),
              );
              const result = yield* Effect.tryPromise({
                try: () =>
                  db
                    .prepare(
                      "SELECT version FROM skill_version WHERE skill_id = ? ORDER BY version DESC",
                    )
                    .bind(skill.id)
                    .all<{ version: number }>(),
                catch: unavailable("settings.skills.listVersions"),
              });
              return {
                skill,
                active,
                versions: result.results.map(
                  ({ version }) => version as SkillVersion,
                ),
              };
            }),
          ),
        );
      });

      const list = Effect.fn("SkillRepository.list")(function* (
        target: SkillTarget,
      ) {
        const skills = yield* querySkills(
          `WHERE scope = ? AND target_id = ? AND removed_at IS NULL
           ORDER BY name, id`,
          [target.scope, target.id],
          "settings.skills.list",
        );
        return yield* hydrate(skills);
      });

      const find = Effect.fn("SkillRepository.find")(function* (
        target: SkillTarget,
        id: SkillId,
      ) {
        const skills = yield* querySkills(
          `WHERE scope = ? AND target_id = ? AND id = ?
             AND removed_at IS NULL LIMIT 1`,
          [target.scope, target.id, id],
          "settings.skills.find",
        );
        if (skills[0] === undefined) return yield* new SkillNotFound();
        const hydrated = yield* hydrate([skills[0]]);
        if (hydrated[0] === undefined) return yield* new SkillNotFound();
        return hydrated[0];
      });

      const versionStatement = (version: typeof StoredSkillVersion.Type) =>
        db
          .prepare(
            `INSERT INTO skill_version (
               skill_id, version, description, instructions, manifest_json,
               mcp_server_ids_json, source_type, source_label, integrity,
               created_at, created_by_user_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            version.integrity,
            encodedTimestamp(version.createdAt),
            version.createdByUserId,
          );

      const resourceStatements = (version: typeof StoredSkillVersion.Type) =>
        version.resources.map((resource) =>
          db
            .prepare(
              `INSERT INTO skill_resource (
                 skill_id, version, path, media_type, content, size_bytes, integrity
               ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              version.skillId,
              version.version,
              resource.path,
              resource.mediaType,
              resource.content,
              resource.sizeBytes,
              resource.integrity,
            ),
        );

      return SkillRepository.of({
        list,
        find,
        findVersion,
        insert: Effect.fn("SkillRepository.insert")(function* (skill, version) {
          yield* Effect.tryPromise({
            try: () =>
              db.batch([
                db
                  .prepare(
                    `INSERT INTO skill (
                       id, scope, target_id, name, enabled, active_version,
                       pinned, created_at, updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  )
                  .bind(
                    skill.id,
                    skill.target.scope,
                    skill.target.id,
                    skill.name,
                    skill.enabled ? 1 : 0,
                    skill.activeVersion,
                    skill.pinned ? 1 : 0,
                    encodedTimestamp(skill.createdAt),
                    encodedTimestamp(skill.updatedAt),
                  ),
                versionStatement(version),
                ...resourceStatements(version),
              ]),
            catch: integrityConflictOrUnavailable("settings.skills.insert"),
          });
        }),
        insertVersion: Effect.fn("SkillRepository.insertVersion")(
          function* (target, version, activate, updatedAt) {
            const current = yield* find(target, version.skillId);
            if (current.skill.pinned && activate) {
              return yield* new SkillIntegrityConflict();
            }
            yield* Effect.tryPromise({
              try: () =>
                db.batch([
                  versionStatement(version),
                  ...resourceStatements(version),
                  ...(activate
                    ? [
                        db
                          .prepare(
                            `UPDATE skill SET active_version = ?, updated_at = ?
                              WHERE id = ? AND scope = ? AND target_id = ?
                                AND removed_at IS NULL`,
                          )
                          .bind(
                            version.version,
                            encodedTimestamp(updatedAt),
                            version.skillId,
                            target.scope,
                            target.id,
                          ),
                      ]
                    : []),
                ]),
              catch: integrityConflictOrUnavailable(
                "settings.skills.insertVersion",
              ),
            });
          },
        ),
        updateState: Effect.fn("SkillRepository.updateState")(
          function* (target, id, input, updatedAt) {
            const current = yield* find(target, id);
            if (input.activeVersion !== undefined) {
              yield* findVersion(id, input.activeVersion);
            }
            const result = yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `UPDATE skill
                      SET enabled = ?, active_version = ?, pinned = ?,
                          updated_at = ?, removed_at = ?
                    WHERE id = ? AND scope = ? AND target_id = ?
                      AND removed_at IS NULL`,
                  )
                  .bind(
                    (input.enabled ?? current.skill.enabled) ? 1 : 0,
                    input.activeVersion ?? current.skill.activeVersion,
                    (input.pinned ?? current.skill.pinned) ? 1 : 0,
                    encodedTimestamp(updatedAt),
                    input.removedAt === undefined
                      ? null
                      : encodedTimestamp(input.removedAt),
                    id,
                    target.scope,
                    target.id,
                  )
                  .run(),
              catch: unavailable("settings.skills.updateState"),
            });
            if (result.meta.changes !== 1) return yield* new SkillNotFound();
          },
        ),
        listEffectiveForThread: Effect.fn(
          "SkillRepository.listEffectiveForThread",
        )(function* (ownerUserId, _projectId) {
          const skills = yield* querySkills(
            `WHERE enabled = 1 AND removed_at IS NULL
               AND (
                 (
                   scope = 'workspace' AND EXISTS (
                     SELECT 1 FROM member
                      WHERE member.userId = ?
                        AND member.organizationId = skill.target_id
                   )
                 )
                 OR (
                   scope = 'personal' AND target_id = ?
                   AND NOT EXISTS (
                     SELECT 1 FROM member
                     JOIN skill_workspace_policy policy
                       ON policy.workspace_id = member.organizationId
                    WHERE member.userId = ?
                      AND policy.allow_personal_skills = 0
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM member
                     JOIN skill workspace_skill
                       ON workspace_skill.scope = 'workspace'
                      AND workspace_skill.target_id = member.organizationId
                      AND workspace_skill.name = skill.name
                      AND workspace_skill.enabled = 1
                      AND workspace_skill.removed_at IS NULL
                    WHERE member.userId = ?
                   )
                 )
               )
             ORDER BY name, scope DESC, id`,
            [ownerUserId, ownerUserId, ownerUserId, ownerUserId],
            "settings.skills.listEffectiveForThread",
          );
          return yield* hydrate(skills);
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
