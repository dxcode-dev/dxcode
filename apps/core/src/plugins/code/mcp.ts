import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createAuthorizedMcpFetch,
  resolveMcpCredential,
} from "../../settings/mcp-servers/execution.js";
import type { CodeHostCall } from "./providers/quickjs.js";
import { mcpResultValue } from "./results.js";

/** Fresh connections keep credentials and review admission current on every call. */
export const codeMcpCall =
  (threadId: string): CodeHostCall =>
  async (module, name, input, raw, signal) => {
    const connection = module.connection;
    if (!connection.tools.includes(name))
      throw new Error("MCP tool is not reviewed for this Thread.");
    signal.throwIfAborted();
    const credential = connection.authenticated
      ? await resolveMcpCredential(threadId, connection.id)
      : undefined;
    const authorizedFetch = createAuthorizedMcpFetch(
      threadId,
      connection.id,
      connection.endpoint,
      connection.timeoutMs,
    );
    const client = new Client({ name: "dx-code", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(connection.endpoint),
      {
        fetch: (input, init) =>
          authorizedFetch(input, {
            ...init,
            signal: AbortSignal.any([
              signal,
              ...(init?.signal ? [init.signal] : []),
            ]),
          }),
        ...(credential === undefined
          ? {}
          : {
              requestInit: {
                headers: { Authorization: `Bearer ${credential}` },
              },
            }),
      },
    );
    try {
      await client.connect(transport);
      const listing = await client.listTools(undefined, {
        signal,
        timeout: connection.timeoutMs,
      });
      const tool = listing.tools.find((tool) => tool.name === name);
      if (!tool) throw new Error("Reviewed MCP tool is no longer available.");
      // request avoids the SDK's callTool output validation so .raw is truly raw.
      const result = await client.request(
        { method: "tools/call", params: { name, arguments: input } },
        { signal, timeout: connection.timeoutMs },
      );
      return mcpResultValue(result, tool.outputSchema, raw);
    } finally {
      await client.close();
    }
  };
