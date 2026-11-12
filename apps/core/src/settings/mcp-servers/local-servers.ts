import {
  isStdioMcpServer,
  mcpModuleIdFor,
  PluginBundleManifest,
  type PluginBundlePackage,
  type PluginBundleStdioMcpServer,
} from "@dx/domain";
import { Option, Schema } from "effect";
import type { McpAgentConnectionData } from "./execution.js";

/**
 * Local (stdio) MCP servers: the ones an enabled plugin bundle declares,
 * which dxd runs in the Thread's Orb. They live in the bundle's manifest,
 * not the MCP server store: installing the plugin, after reviewing its
 * command and its files' integrity, is what allows them, and each runs only
 * inside the Thread owner's own Orb. A Thread reaches the bundles its owner
 * installed and those of the workspaces they belong to, under the same
 * policy as remote servers: a workspace that turns off personal MCP servers
 * hides personal ones, and a workspace server overrides a personal server
 * with the same name. Removing or disabling the plugin stops the next call.
 * A repository plugin's local servers are recorded per Thread instead, by
 * `plugins/repository/repository-local-mcp.ts`.
 */

export interface LocalMcpServerData {
  /** Digests the plugin, the server, and its files; dxd keys processes by it. */
  readonly key: string;
  readonly pluginId: string;
  readonly server: PluginBundleStdioMcpServer;
  readonly package: PluginBundlePackage;
}

const Row = Schema.Struct({
  id: Schema.String,
  scope: Schema.Literals(["personal", "workspace"]),
  manifest_json: Schema.String,
});

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const listQuery = `
  SELECT trusted_plugin.id AS id,
         trusted_plugin.scope AS scope,
         version.manifest_json AS manifest_json
    FROM threads
    JOIN trusted_plugin
      ON trusted_plugin.kind = 'bundle'
     AND trusted_plugin.enabled = 1
     AND trusted_plugin.removed_at IS NULL
    JOIN trusted_plugin_version version
      ON version.plugin_id = trusted_plugin.id
     AND version.version = trusted_plugin.active_version
   WHERE threads.id = ?1
     AND (
       (
         trusted_plugin.scope = 'personal'
         AND trusted_plugin.target_id = threads.owner_user_id
         AND NOT EXISTS (
           SELECT 1
             FROM member
             JOIN mcp_workspace_policy policy
               ON policy.workspace_id = member.organizationId
            WHERE member.userId = threads.owner_user_id
              AND policy.allow_personal_servers = 0
         )
       )
       OR (
         trusted_plugin.scope = 'workspace'
         AND EXISTS (
           SELECT 1 FROM member
            WHERE member.userId = threads.owner_user_id
              AND member.organizationId = trusted_plugin.target_id
         )
       )
     )
     AND version.manifest_json LIKE '%"stdio"%'
   ORDER BY trusted_plugin.scope DESC, trusted_plugin.name, trusted_plugin.id`;

/** The local servers a Thread may run, workspace ones first. */
export const listLocalMcpServers = async (
  db: D1Database,
  threadId: string,
): Promise<ReadonlyArray<LocalMcpServerData>> => {
  const rows = await db.prepare(listQuery).bind(threadId).all();
  const servers: Array<LocalMcpServerData> = [];
  const taken = new Set<string>();
  for (const raw of rows.results) {
    const row = Schema.decodeUnknownOption(Row)(raw);
    if (Option.isNone(row)) continue;
    let manifest: PluginBundleManifest;
    try {
      manifest = Schema.decodeUnknownSync(PluginBundleManifest)(
        JSON.parse(row.value.manifest_json),
      );
    } catch {
      continue;
    }
    const pkg = manifest.package;
    if (pkg === undefined) continue;
    for (const server of manifest.mcpServers.filter(isStdioMcpServer)) {
      // Workspace rows come first, so they win a name over personal ones.
      const moduleId = mcpModuleIdFor(server.name);
      if (taken.has(moduleId)) continue;
      taken.add(moduleId);
      servers.push({
        key: await localMcpServerKey(row.value.id, server, pkg),
        pluginId: row.value.id,
        server,
        package: pkg,
      });
    }
  }
  return servers;
};

/** The key dxd runs a local server's process under. */
export const localMcpServerKey = (
  pluginId: string,
  server: PluginBundleStdioMcpServer,
  pkg: PluginBundlePackage,
) => sha256(JSON.stringify({ pluginId, server, package: pkg }));

/** Code's connection for a local server; its tools come from dxd. */
export const localMcpConnection = (
  local: LocalMcpServerData,
): McpAgentConnectionData => ({
  id: `local_${local.key.slice(0, 24)}`,
  name: local.server.name,
  displayName: local.server.name,
  moduleId: mcpModuleIdFor(local.server.name),
  endpoint: "",
  timeoutMs: 60_000,
  authenticated: false,
  tools: [],
  local,
});

/** Code's connections for the Thread's local servers; tools come from dxd. */
export const resolveLocalMcpAgentConnections = async (
  db: D1Database,
  threadId: string,
): Promise<ReadonlyArray<McpAgentConnectionData>> =>
  (await listLocalMcpServers(db, threadId)).map(localMcpConnection);

/**
 * Whether the Thread may run the local server under `key` now: an enabled
 * install of its owner's declares it, or its latest submission recorded it
 * from a repository plugin (`plugins/repository/repository-local-mcp.ts`).
 */
export const mayRunLocalMcpServer = async (
  db: D1Database,
  threadId: string,
  key: string,
) => {
  const recorded = await db
    .prepare(
      `SELECT 1 FROM thread_repository_local_mcp_server
        WHERE thread_id = ? AND server_key = ? LIMIT 1`,
    )
    .bind(threadId, key)
    .first();
  if (recorded !== null) return true;
  return (await listLocalMcpServers(db, threadId)).some(
    (server) => server.key === key,
  );
};
