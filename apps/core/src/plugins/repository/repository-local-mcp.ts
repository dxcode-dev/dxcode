import {
  isStdioMcpServer,
  type PluginBundleMcpServer,
  type PluginBundlePackage,
} from "@dx/domain";
import type { McpAgentConnectionData } from "../../settings/mcp-servers/execution.js";
import {
  type LocalMcpServerData,
  localMcpConnection,
  localMcpServerKey,
} from "../../settings/mcp-servers/local-servers.js";
import { pluginPackageKey } from "../../settings/plugins/bundles/plugin-package.js";

/**
 * The local (stdio) MCP servers a repository plugin declares (plugin plan
 * M1). They run as an installed plugin's do: dxd lays out the plugin's files
 * as `PLUGIN_ROOT` and starts the server in the Orb (`plugins/code/
 * local-mcp.ts`, `apps/dxd/src/mcp.rs`). The files are the plugin folder as
 * committed at HEAD, the same bytes the submission read it from, kept in R2
 * by digest; an edit in the working tree runs nothing until it is
 * committed. `PLUGIN_DATA` is one folder per Project and plugin name, so it
 * survives new commits. The repository is the trust, so nobody approves
 * them; a call goes out only while the Thread's latest submission recorded
 * the server under the same key.
 */

export interface RepositoryLocalMcpPlugin {
  readonly name: string;
  readonly servers: ReadonlyArray<PluginBundleMcpServer>;
  /** The plugin's committed files, built by the reader for its stdio servers. */
  readonly package?: {
    readonly bytes: Uint8Array;
    readonly summary: PluginBundlePackage;
  };
}

const sha256Hex = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

/** A plugin ID dxd accepts, stable per Project and plugin name. */
export const repositoryLocalPluginId = async (
  projectId: string,
  pluginName: string,
) =>
  `plg_repository-${(
    await sha256Hex(`repository-local-mcp\0${projectId}\0${pluginName}`)
  ).slice(0, 32)}`;

/**
 * Keeps each plugin's committed files, records the Thread's repository
 * stdio servers, and returns them as Code connections. A server whose files
 * cannot be kept is skipped with a reason; it never fails the submission.
 */
export const recordRepositoryLocalMcpServers = async (
  db: D1Database,
  storage: R2Bucket | undefined,
  threadId: string,
  projectId: string,
  plugins: ReadonlyArray<RepositoryLocalMcpPlugin>,
): Promise<{
  readonly connections: ReadonlyArray<McpAgentConnectionData>;
  readonly skipped: ReadonlyArray<{ folder: string; reason: string }>;
}> => {
  const skipped: Array<{ folder: string; reason: string }> = [];
  const recorded: Array<{ plugin: string; local: LocalMcpServerData }> = [];
  for (const plugin of plugins) {
    const servers = plugin.servers.filter(isStdioMcpServer);
    if (servers.length === 0) continue;
    const skipAll = (reason: string) => {
      for (const server of servers)
        skipped.push({ folder: `${plugin.name}/mcp/${server.name}`, reason });
    };
    const pkg = plugin.package;
    if (pkg === undefined) {
      skipAll("The plugin's files could not be read for its local servers.");
      continue;
    }
    if (storage === undefined) {
      skipAll(
        "This dx deployment has no file storage, so it cannot run local MCP servers.",
      );
      continue;
    }
    try {
      const key = pluginPackageKey(pkg.summary.sha256);
      if ((await storage.head(key)) === null)
        await storage.put(key, pkg.bytes, {
          sha256: pkg.summary.sha256,
          httpMetadata: { contentType: "application/octet-stream" },
        });
    } catch {
      skipAll("dx could not keep the plugin's files for its local servers.");
      continue;
    }
    const pluginId = await repositoryLocalPluginId(projectId, plugin.name);
    for (const server of servers) {
      recorded.push({
        plugin: plugin.name,
        local: {
          key: await localMcpServerKey(pluginId, server, pkg.summary),
          pluginId,
          server,
          package: pkg.summary,
        },
      });
    }
  }
  const now = new Date().toISOString();
  try {
    await db.batch([
      db
        .prepare(
          "DELETE FROM thread_repository_local_mcp_server WHERE thread_id = ?",
        )
        .bind(threadId),
      ...recorded.map(({ plugin, local }) =>
        db
          .prepare(
            `INSERT INTO thread_repository_local_mcp_server (
               thread_id, server_key, plugin_name, server_name, updated_at
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (thread_id, server_key) DO NOTHING`,
          )
          .bind(threadId, local.key, plugin, local.server.name, now),
      ),
    ]);
  } catch {
    // Recording failed: none of these servers may run, and the
    // repository's other plugins still load.
    await clearRepositoryLocalMcpServers(db, threadId).catch(() => undefined);
    return {
      connections: [],
      skipped: [
        ...skipped,
        ...recorded.map(({ plugin, local }) => ({
          folder: `${plugin}/mcp/${local.server.name}`,
          reason: "dx could not record this local MCP server for the Thread.",
        })),
      ],
    };
  }
  return {
    connections: recorded.map(({ local }) => localMcpConnection(local)),
    skipped,
  };
};

/** Forgets the Thread's repository stdio servers: none run this submission. */
export const clearRepositoryLocalMcpServers = (
  db: D1Database,
  threadId: string,
) =>
  db
    .prepare(
      "DELETE FROM thread_repository_local_mcp_server WHERE thread_id = ?",
    )
    .bind(threadId)
    .run()
    .then(() => undefined);
