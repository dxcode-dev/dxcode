import { MAX_MCP_TOOLS_PER_SERVER, type ThreadId } from "@dx/domain";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { attachmentTransfer } from "../../attachments/transfer.js";
import type { Bindings } from "../../http/types.js";
import {
  type McpAgentConnectionData,
  McpInvocationForbidden,
} from "../../settings/mcp-servers/execution.js";
import {
  type LocalMcpServerData,
  mayRunLocalMcpServer,
} from "../../settings/mcp-servers/local-servers.js";
import { pluginPackageKey } from "../../settings/plugins/bundles/plugin-package.js";
import {
  DaemonUnavailable,
  McpDaemonOutdated,
  requestThreadMcp,
} from "../../threads/daemon-client.js";
import { mcpResultValue } from "./results.js";

/**
 * Code's calls to a plugin's local (stdio) MCP server. Each request checks
 * that the Thread may still run the server (its plugin is installed and
 * enabled, unchanged, or its latest submission recorded it from a
 * repository plugin), signs a short-lived URL for the plugin's files, and
 * relays the MCP request through the Thread's execution object to dxd,
 * which starts the server in the Orb when it is not running.
 */

interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
}

const MAX_SCHEMA_CHARACTERS = 32_768;

const request = async (
  bindings: Bindings,
  threadId: string,
  local: LocalMcpServerData,
  method: "tools/list" | "tools/call",
  params: unknown,
  timeoutMs: number,
): Promise<unknown> => {
  if (bindings.DB === undefined) throw new McpInvocationForbidden();
  if (!(await mayRunLocalMcpServer(bindings.DB, threadId, local.key)))
    throw new McpInvocationForbidden();
  const transfer = attachmentTransfer(bindings);
  if (transfer === undefined)
    throw new Error(
      "This dx deployment cannot hand plugin files to the Orb, so local MCP servers are unavailable.",
    );
  const url = await transfer.readUrl(pluginPackageKey(local.package.sha256), {
    contentType: "application/octet-stream",
    disposition: "attachment",
  });
  const { server } = local;
  let result: Awaited<ReturnType<typeof requestThreadMcp>>;
  try {
    result = await requestThreadMcp(bindings, threadId as ThreadId, {
      operation: "mcp.request",
      server: {
        key: local.key,
        name: server.name,
        pluginId: local.pluginId,
        command: server.command,
        args: server.args,
        env: server.env,
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
        package: {
          url,
          sha256: local.package.sha256,
          size: local.package.size,
        },
      },
      method,
      params,
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof McpDaemonOutdated)
      throw new Error(
        `${server.name} runs in the Orb, and its dx daemon has not updated yet. Try again in a minute.`,
      );
    if (error instanceof DaemonUnavailable)
      throw new Error(
        `${server.name} runs in the Orb, which is not reachable right now.`,
      );
    throw error;
  }
  if (result.kind === "result") return result.result;
  if (result.kind === "error")
    throw new Error(`${server.name} answered with an error: ${result.message}`);
  throw new Error(`${server.name}: ${result.message}`);
};

/** The server's tools, as it lists them now (one page, bounded). */
export const listLocalTools = async (
  bindings: Bindings,
  threadId: string,
  connection: McpAgentConnectionData,
): Promise<ReadonlyArray<ListedTool>> => {
  const local = connection.local;
  if (local === undefined) return [];
  const listing = await request(
    bindings,
    threadId,
    local,
    "tools/list",
    {},
    connection.timeoutMs,
  );
  const tools =
    typeof listing === "object" &&
    listing !== null &&
    Array.isArray((listing as { tools?: unknown }).tools)
      ? (listing as { tools: Array<unknown> }).tools
      : [];
  const listed: Array<ListedTool> = [];
  for (const tool of tools.slice(0, MAX_MCP_TOOLS_PER_SERVER)) {
    if (typeof tool !== "object" || tool === null) continue;
    const { name, description, inputSchema, outputSchema } = tool as Record<
      string,
      unknown
    >;
    if (typeof name !== "string" || name === "" || name.length > 128) continue;
    const schema = inputSchema ?? { type: "object" };
    if (JSON.stringify(schema).length > MAX_SCHEMA_CHARACTERS) continue;
    if (
      outputSchema !== undefined &&
      (JSON.stringify(outputSchema)?.length ?? 0) > MAX_SCHEMA_CHARACTERS
    )
      continue;
    listed.push({
      name,
      description:
        typeof description === "string" ? description.slice(0, 4_096) : "",
      inputSchema: schema,
      ...(outputSchema === undefined ? {} : { outputSchema }),
    });
  }
  return listed;
};

/** The connection with the tools the running server lists. */
export const withLocalTools = async (
  bindings: Bindings,
  threadId: string,
  connection: McpAgentConnectionData,
): Promise<McpAgentConnectionData> => {
  const tools = await listLocalTools(bindings, threadId, connection);
  return {
    ...connection,
    tools: tools.map(({ name }) => name),
    toolDefinitions: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchemaJson: JSON.stringify(inputSchema),
    })),
  };
};

/** One `tools/call`, checked against the server's current listing. */
export const callLocalTool = async (
  bindings: Bindings,
  threadId: string,
  connection: McpAgentConnectionData,
  name: string,
  input: unknown,
  raw: boolean,
  signal: AbortSignal,
): Promise<unknown> => {
  const local = connection.local;
  if (local === undefined) throw new McpInvocationForbidden();
  signal.throwIfAborted();
  const tools = await listLocalTools(bindings, threadId, connection);
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined)
    throw new Error(`${local.server.name} no longer lists the tool "${name}".`);
  signal.throwIfAborted();
  const result = await request(
    bindings,
    threadId,
    local,
    "tools/call",
    { name, arguments: input },
    connection.timeoutMs,
  );
  return mcpResultValue(
    result as CallToolResult,
    tool.outputSchema as Parameters<typeof mcpResultValue>[1],
    raw,
  );
};
