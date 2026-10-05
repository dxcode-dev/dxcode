import {
  configReferenceFor,
  type McpServerId,
  McpServerNotFound,
  McpServerRepository,
  type McpServerTarget,
  PersistenceUnavailable,
  StoredMcpServer,
  StoredMcpTool,
  Timestamp,
} from "@dx/domain";
import { Effect, Layer, Schema, SchemaTransformation } from "effect";
import { settingsPersistenceLogger } from "../../logging.js";

const McpServerRow = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  target_id: Schema.String,
  name: Schema.String,
  endpoint: Schema.String,
  transport: Schema.String,
  auth_environment_variable_id: Schema.NullOr(Schema.String),
  timeout_ms: Schema.Finite,
  enabled: Schema.Finite,
  project_ids_json: Schema.String,
  roles_json: Schema.String,
  health_status: Schema.String,
  health_checked_at: Schema.NullOr(Schema.String),
  health_error_code: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
  has_stored_credential: Schema.Finite,
});

const McpToolRow = Schema.Struct({
  server_id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  input_schema_json: Schema.String,
  schema_hash: Schema.String,
  approved_schema_hash: Schema.NullOr(Schema.String),
  discovered_at: Schema.String,
  reviewed_at: Schema.NullOr(Schema.String),
});

const columns = `
  id, scope, target_id, name, endpoint, transport,
  auth_environment_variable_id, timeout_ms, enabled,
  project_ids_json, roles_json, health_status, health_checked_at,
  health_error_code, created_at, updated_at,
  EXISTS (
    SELECT 1 FROM mcp_server_credential
     WHERE mcp_server_credential.server_id = mcp_server.id
  ) AS has_stored_credential
`;

const JsonString = Schema.String.pipe(
  Schema.decodeTo(Schema.Unknown, SchemaTransformation.fromJsonString()),
);

const decodeJson = Schema.decodeUnknownEffect(JsonString);

const decodeServers = (input: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(McpServerRow))(input).pipe(
    Effect.flatMap((rows) =>
      Effect.all(
        rows.map((row) =>
          Effect.gen(function* () {
            const projectIds = yield* decodeJson(row.project_ids_json);
            const roles = yield* decodeJson(row.roles_json);
            return yield* Schema.decodeUnknownEffect(StoredMcpServer)({
              id: row.id,
              target: { scope: row.scope, id: row.target_id },
              name: row.name,
              endpoint: row.endpoint,
              transport: row.transport,
              ...(row.auth_environment_variable_id === null
                ? {}
                : {
                    authReference: configReferenceFor(
                      row.auth_environment_variable_id as never,
                    ),
                  }),
              ...(row.has_stored_credential === 1
                ? { hasStoredCredential: true }
                : {}),
              timeoutMs: row.timeout_ms,
              enabled: row.enabled === 1,
              projectIds,
              roles,
              healthStatus: row.health_status,
              ...(row.health_checked_at === null
                ? {}
                : { healthCheckedAt: row.health_checked_at }),
              ...(row.health_error_code === null
                ? {}
                : { healthErrorCode: row.health_error_code }),
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            });
          }),
        ),
      ),
    ),
  );

const decodeTools = (input: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(McpToolRow))(input).pipe(
    Effect.flatMap((rows) =>
      Effect.all(
        rows.map((row) =>
          Effect.gen(function* () {
            yield* decodeJson(row.input_schema_json);
            return yield* Schema.decodeEffect(StoredMcpTool)({
              name: row.name,
              description: row.description,
              inputSchemaJson: row.input_schema_json,
              schemaHash: row.schema_hash,
              ...(row.approved_schema_hash === null
                ? {}
                : { approvedSchemaHash: row.approved_schema_hash }),
              discoveredAt: row.discovered_at,
              ...(row.reviewed_at === null
                ? {}
                : { reviewedAt: row.reviewed_at }),
            });
          }),
        ),
      ),
    ),
  );

const encodedTimestamp = (value: Timestamp) =>
  Schema.encodeSync(Timestamp)(value);

export const McpServerRepositoryD1 = (db: D1Database) =>
  Layer.effect(
    McpServerRepository,
    Effect.gen(function* () {
      const unavailable = (operation: string) => (cause: unknown) =>
        PersistenceUnavailable.new({ operation }, cause);

      const queryServers = Effect.fn("McpServerRepository.queryServers")(
        function* (
          suffix: string,
          bindings: ReadonlyArray<unknown>,
          operation: string,
        ) {
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(`SELECT ${columns} FROM mcp_server ${suffix}`)
                .bind(...bindings)
                .all(),
            catch: unavailable(operation),
          });
          return yield* decodeServers(result.results);
        },
      );

      const toolsFor = Effect.fn("McpServerRepository.toolsFor")(function* (
        serverIds: ReadonlyArray<McpServerId>,
      ) {
        if (serverIds.length === 0) return [];
        const placeholders = serverIds.map(() => "?").join(", ");
        const result = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `SELECT server_id, name, description, input_schema_json,
                        schema_hash, approved_schema_hash, discovered_at,
                        reviewed_at
                   FROM mcp_tool
                  WHERE server_id IN (${placeholders})
                  ORDER BY server_id, name`,
              )
              .bind(...serverIds)
              .all(),
          catch: unavailable("settings.mcpServers.listTools"),
        });
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(McpToolRow),
        )(result.results);
        const decoded = yield* decodeTools(rows);
        return rows.map((row, index) => ({
          serverId: row.server_id as McpServerId,
          tool: decoded[index] as StoredMcpTool,
        }));
      });

      const hydrate = Effect.fn("McpServerRepository.hydrate")(function* (
        servers: ReadonlyArray<StoredMcpServer>,
      ) {
        const tools = yield* toolsFor(servers.map(({ id }) => id));
        return servers.map((server) => ({
          server,
          tools: tools
            .filter(({ serverId }) => serverId === server.id)
            .map(({ tool }) => tool),
        }));
      });

      const list = Effect.fn("McpServerRepository.list")(function* (
        target: McpServerTarget,
      ) {
        const servers = yield* queryServers(
          "WHERE scope = ? AND target_id = ? ORDER BY name, id",
          [target.scope, target.id],
          "settings.mcpServers.list",
        );
        return yield* hydrate(servers);
      });

      const find = Effect.fn("McpServerRepository.find")(function* (
        target: McpServerTarget,
        id: McpServerId,
      ) {
        const servers = yield* queryServers(
          "WHERE scope = ? AND target_id = ? AND id = ? LIMIT 1",
          [target.scope, target.id, id],
          "settings.mcpServers.find",
        );
        const server = servers[0];
        if (server === undefined) return yield* new McpServerNotFound();
        return (yield* hydrate([server]))[0] as {
          readonly server: StoredMcpServer;
          readonly tools: ReadonlyArray<StoredMcpTool>;
        };
      });

      return McpServerRepository.of({
        list,
        find,
        insert: Effect.fn("McpServerRepository.insert")(function* (value) {
          yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `INSERT INTO mcp_server (
                     id, scope, target_id, name, endpoint, transport,
                     auth_environment_variable_id, timeout_ms, enabled,
                     project_ids_json, roles_json, health_status,
                     health_checked_at, health_error_code, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                  value.id,
                  value.target.scope,
                  value.target.id,
                  value.name,
                  value.endpoint,
                  value.transport,
                  value.authReference?.id ?? null,
                  value.timeoutMs,
                  value.enabled ? 1 : 0,
                  JSON.stringify(value.projectIds),
                  JSON.stringify(value.roles),
                  value.healthStatus,
                  value.healthCheckedAt === undefined
                    ? null
                    : encodedTimestamp(value.healthCheckedAt),
                  value.healthErrorCode ?? null,
                  encodedTimestamp(value.createdAt),
                  encodedTimestamp(value.updatedAt),
                )
                .run(),
            catch: unavailable("settings.mcpServers.insert"),
          });
          settingsPersistenceLogger.info("MCP server persistence succeeded.", {
            event: "mcp_server_persistence_created",
            mcpServerId: value.id,
            scope: value.target.scope,
          });
        }),
        replace: Effect.fn("McpServerRepository.replace")(function* (value) {
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `UPDATE mcp_server
                      SET name = ?, endpoint = ?, auth_environment_variable_id = ?,
                          timeout_ms = ?, enabled = ?, project_ids_json = ?,
                          roles_json = ?, health_status = ?, health_checked_at = ?,
                          health_error_code = ?, updated_at = ?
                    WHERE scope = ? AND target_id = ? AND id = ?`,
                )
                .bind(
                  value.name,
                  value.endpoint,
                  value.authReference?.id ?? null,
                  value.timeoutMs,
                  value.enabled ? 1 : 0,
                  JSON.stringify(value.projectIds),
                  JSON.stringify(value.roles),
                  value.healthStatus,
                  value.healthCheckedAt === undefined
                    ? null
                    : encodedTimestamp(value.healthCheckedAt),
                  value.healthErrorCode ?? null,
                  encodedTimestamp(value.updatedAt),
                  value.target.scope,
                  value.target.id,
                  value.id,
                )
                .run(),
            catch: unavailable("settings.mcpServers.replace"),
          });
          if (result.meta.changes !== 1) return yield* new McpServerNotFound();
        }),
        remove: Effect.fn("McpServerRepository.remove")(function* (target, id) {
          // Delete the token explicitly too, independent of foreign-key cascade.
          const [, result] = yield* Effect.tryPromise({
            try: () =>
              db.batch([
                db
                  .prepare(
                    "DELETE FROM mcp_server_credential WHERE server_id = ? AND scope = ? AND target_id = ?",
                  )
                  .bind(id, target.scope, target.id),
                db
                  .prepare(
                    "DELETE FROM mcp_server WHERE scope = ? AND target_id = ? AND id = ?",
                  )
                  .bind(target.scope, target.id, id),
              ]),
            catch: unavailable("settings.mcpServers.remove"),
          });
          if ((result?.meta.changes ?? 0) === 0)
            return yield* new McpServerNotFound();
        }),
        replaceDiscovery: Effect.fn("McpServerRepository.replaceDiscovery")(
          function* (id, tools) {
            const statements: Array<D1PreparedStatement> = [
              tools.length === 0
                ? db
                    .prepare("DELETE FROM mcp_tool WHERE server_id = ?")
                    .bind(id)
                : db
                    .prepare(
                      `DELETE FROM mcp_tool
                        WHERE server_id = ?
                          AND name NOT IN (${tools.map(() => "?").join(", ")})`,
                    )
                    .bind(id, ...tools.map(({ name }) => name)),
              ...tools.map((tool) =>
                db
                  .prepare(
                    `INSERT INTO mcp_tool (
                       server_id, name, description, input_schema_json,
                       schema_hash, discovered_at
                     ) VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(server_id, name) DO UPDATE SET
                       description = excluded.description,
                       input_schema_json = excluded.input_schema_json,
                       schema_hash = excluded.schema_hash,
                       discovered_at = excluded.discovered_at`,
                  )
                  .bind(
                    id,
                    tool.name,
                    tool.description,
                    tool.inputSchemaJson,
                    tool.schemaHash,
                    encodedTimestamp(tool.discoveredAt),
                  ),
              ),
            ];
            yield* Effect.tryPromise({
              try: () => db.batch(statements),
              catch: unavailable("settings.mcpServers.replaceDiscovery"),
            });
          },
        ),
        reviewTool: Effect.fn("McpServerRepository.reviewTool")(
          function* (
            target,
            id,
            name,
            schemaHash,
            approved,
            reviewedAt,
            reviewedBy,
          ) {
            const result = yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `UPDATE mcp_tool
                        SET approved_schema_hash = ?, reviewed_at = ?, reviewed_by = ?
                      WHERE server_id = ? AND name = ? AND schema_hash = ?
                        AND EXISTS (
                          SELECT 1 FROM mcp_server
                           WHERE id = ? AND scope = ? AND target_id = ?
                        )`,
                  )
                  .bind(
                    approved ? schemaHash : null,
                    encodedTimestamp(reviewedAt),
                    reviewedBy,
                    id,
                    name,
                    schemaHash,
                    id,
                    target.scope,
                    target.id,
                  )
                  .run(),
              catch: unavailable("settings.mcpServers.reviewTool"),
            });
            if (result.meta.changes !== 1)
              return yield* new McpServerNotFound();
          },
        ),
        getWorkspacePolicy: Effect.fn("McpServerRepository.getWorkspacePolicy")(
          function* (workspaceId) {
            const row = yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    "SELECT allow_personal_servers FROM mcp_workspace_policy WHERE workspace_id = ?",
                  )
                  .bind(workspaceId)
                  .first<{ allow_personal_servers: number }>(),
              catch: unavailable("settings.mcpServers.getWorkspacePolicy"),
            });
            return row?.allow_personal_servers !== 0;
          },
        ),
        setWorkspacePolicy: Effect.fn("McpServerRepository.setWorkspacePolicy")(
          function* (workspaceId, allowPersonal) {
            yield* Effect.tryPromise({
              try: () =>
                db
                  .prepare(
                    `INSERT INTO mcp_workspace_policy (
                       workspace_id, allow_personal_servers
                     ) VALUES (?, ?)
                     ON CONFLICT(workspace_id) DO UPDATE SET
                       allow_personal_servers = excluded.allow_personal_servers`,
                  )
                  .bind(workspaceId, allowPersonal ? 1 : 0)
                  .run(),
              catch: unavailable("settings.mcpServers.setWorkspacePolicy"),
            });
          },
        ),
        listForExecution: Effect.fn("McpServerRepository.listForExecution")(
          function* (ownerUserId, projectId) {
            const servers = yield* queryServers(
              `WHERE enabled = 1
                 AND (
                   (
                     scope = 'personal' AND target_id = ?
                     AND NOT EXISTS (
                       SELECT 1
                         FROM member
                         JOIN mcp_workspace_policy policy
                           ON policy.workspace_id = member.organizationId
                        WHERE member.userId = ?
                          AND policy.allow_personal_servers = 0
                     )
                   )
                   OR (
                     scope = 'workspace'
                     AND EXISTS (
                       SELECT 1 FROM member
                        WHERE member.userId = ?
                          AND member.organizationId = mcp_server.target_id
                          AND member.role IN (
                            SELECT value FROM json_each(mcp_server.roles_json)
                          )
                     )
                   )
                 )
                 AND (
                   json_array_length(project_ids_json) = 0
                   OR ? IN (SELECT value FROM json_each(project_ids_json))
                 )
               ORDER BY scope, name, id`,
              [ownerUserId, ownerUserId, ownerUserId, projectId],
              "settings.mcpServers.listForExecution",
            );
            const hydrated = yield* hydrate(servers);
            return hydrated.map(({ server, tools }) => ({
              server,
              tools: tools.filter(
                (tool) =>
                  tool.approvedSchemaHash !== undefined &&
                  tool.approvedSchemaHash === tool.schemaHash,
              ),
            }));
          },
        ),
      });
    }),
  );
