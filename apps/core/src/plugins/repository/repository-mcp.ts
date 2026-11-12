import {
  flueMcpServerName,
  isStdioMcpServer,
  type McpServerId,
  mcpModuleIdFor,
  type PluginBundleMcpServer,
  type StoredMcpServer,
  type StoredMcpTool,
} from "@dx/domain";
import { Effect, Result } from "effect";
import type { McpAgentConnectionData } from "../../settings/mcp-servers/execution.js";
import {
  discoverMcpTools,
  type McpNetworkOptions,
} from "../../settings/mcp-servers/transport.js";

/**
 * The remote MCP servers a repository plugin declares (plugin plan M1);
 * its local (stdio) servers run in the Orb (`repository-local-mcp.ts`).
 * Each submission lists every server's tools, records them for the Thread in
 * `thread_repository_mcp_server`, and offers them to Code beside the
 * owner's servers. The repository is the trust, so its tools need no review;
 * a call goes out only while the Thread's latest submission recorded the
 * server and the tool's contract still matches what it listed then. A server
 * that wants a bearer token is skipped: nobody installed it, so no secret is
 * its.
 */

const DISCOVERY_TIMEOUT_MS = 6_000;
const CALL_TIMEOUT_MS = 60_000;

const sha256Hex = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

/** A stable server ID per Project, plugin, and server, shaped like dx's. */
export const repositoryMcpServerId = async (
  projectId: string,
  pluginName: string,
  serverName: string,
): Promise<McpServerId> => {
  const hex = await sha256Hex(
    `repository-mcp\0${projectId}\0${pluginName}\0${serverName}`,
  );
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(
    16,
  );
  return `mcp_${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}` as McpServerId;
};

export interface RepositoryMcpPlugin {
  readonly name: string;
  readonly servers: ReadonlyArray<PluginBundleMcpServer>;
}

interface RecordedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchemaJson: string;
  readonly schemaHash: string;
}

/**
 * Lists each repository server's tools, records the Thread's servers, and
 * returns them as Code connections. A server that can't be listed is
 * skipped with a reason; it never fails the submission.
 */
export const discoverRepositoryMcpServers = async (
  db: D1Database,
  threadId: string,
  projectId: string,
  plugins: ReadonlyArray<RepositoryMcpPlugin>,
  networkOptions: McpNetworkOptions = {},
): Promise<{
  readonly connections: ReadonlyArray<McpAgentConnectionData>;
  readonly skipped: ReadonlyArray<{ folder: string; reason: string }>;
}> => {
  const skipped: Array<{ folder: string; reason: string }> = [];
  const found = await Promise.all(
    plugins.flatMap((plugin) =>
      plugin.servers.map(async (server) => {
        // Local (stdio) servers run in the Orb: repository-local-mcp.ts.
        if (isStdioMcpServer(server)) return undefined;
        if (server.authType !== "none") {
          skipped.push({
            folder: `${plugin.name}/mcp/${server.name}`,
            reason: `MCP server ${server.name} wants a token, and a repository plugin gets no secrets; install the plugin to use it.`,
          });
          return undefined;
        }
        const headers = Object.fromEntries(
          server.headers.map(({ name, value }) => [name, value]),
        );
        const listed = await Effect.runPromise(
          Effect.result(
            discoverMcpTools(
              {
                endpoint: server.endpoint,
                timeoutMs: DISCOVERY_TIMEOUT_MS,
              } as Pick<
                StoredMcpServer,
                "endpoint" | "timeoutMs" | "clientName"
              >,
              undefined,
              networkOptions,
              headers,
            ).pipe(
              // A slow server must not hold up the submission.
              Effect.timeoutOrElse({
                duration: DISCOVERY_TIMEOUT_MS,
                orElse: () => Effect.fail({ code: "TIMEOUT" }),
              }),
            ),
          ),
        );
        if (Result.isFailure(listed)) {
          const code = (listed.failure as { code?: unknown }).code;
          skipped.push({
            folder: `${plugin.name}/mcp/${server.name}`,
            reason: `MCP server ${server.name} could not be listed (${typeof code === "string" ? code : "failed"}).`,
          });
          return undefined;
        }
        const tools: ReadonlyArray<RecordedTool> = listed.success.map(
          (tool: StoredMcpTool) => ({
            name: tool.name,
            description: tool.description,
            inputSchemaJson: tool.inputSchemaJson,
            schemaHash: tool.schemaHash,
          }),
        );
        return {
          id: await repositoryMcpServerId(projectId, plugin.name, server.name),
          plugin: plugin.name,
          server,
          headers,
          tools,
        };
      }),
    ),
  );
  const servers = found.filter((value) => value !== undefined);
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare("DELETE FROM thread_repository_mcp_server WHERE thread_id = ?")
      .bind(threadId),
    ...servers.map(({ id, plugin, server, headers, tools }) =>
      db
        .prepare(
          `INSERT INTO thread_repository_mcp_server (
             thread_id, server_id, plugin_name, name, endpoint, headers_json,
             tools_json, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          threadId,
          id,
          plugin,
          server.name,
          server.endpoint,
          JSON.stringify(headers),
          JSON.stringify(tools),
          now,
        ),
    ),
  ]);
  return {
    connections: servers
      .filter(({ tools }) => tools.length > 0)
      .map(({ id, server, tools }) => ({
        id,
        name: flueMcpServerName(id),
        displayName: server.name,
        moduleId: mcpModuleIdFor(server.name),
        toolDefinitions: tools.map(
          ({ name, description, inputSchemaJson }) => ({
            name,
            description,
            inputSchemaJson,
          }),
        ),
        endpoint: server.endpoint,
        timeoutMs: CALL_TIMEOUT_MS,
        authenticated: false,
        tools: tools.map(({ name }) => name),
      })),
    skipped,
  };
};

/**
 * A repository server the Thread's latest submission recorded, shaped as
 * an authorized connection for `authorizeMcpCall`, or undefined.
 */
export const readRepositoryMcpConnection = async (
  db: D1Database,
  threadId: string,
  serverId: string,
) => {
  const row = await db
    .prepare(
      `SELECT endpoint, headers_json, tools_json
         FROM thread_repository_mcp_server
        WHERE thread_id = ? AND server_id = ?`,
    )
    .bind(threadId, serverId)
    .first<{ endpoint: string; headers_json: string; tools_json: string }>();
  if (row === null) return undefined;
  const tools = JSON.parse(row.tools_json) as ReadonlyArray<RecordedTool>;
  return {
    db,
    server: {
      id: serverId,
      endpoint: row.endpoint,
      timeoutMs: CALL_TIMEOUT_MS,
    } as unknown as StoredMcpServer,
    // The repository is the trust: each listed contract counts as approved.
    tools: tools.map((tool) => ({
      ...tool,
      approvedSchemaHash: tool.schemaHash,
    })) as unknown as ReadonlyArray<StoredMcpTool>,
    headers: JSON.parse(row.headers_json) as Readonly<Record<string, string>>,
  };
};

/** Forgets the Thread's repository servers: none load this submission. */
export const clearRepositoryMcpServers = (db: D1Database, threadId: string) =>
  db
    .prepare("DELETE FROM thread_repository_mcp_server WHERE thread_id = ?")
    .bind(threadId)
    .run()
    .then(() => undefined);
