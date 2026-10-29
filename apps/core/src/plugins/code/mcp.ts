import { DEFAULT_MCP_CLIENT_NAME } from "@dx/domain";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createAuthorizedMcpFetch,
  resolveMcpCredential,
} from "../../settings/mcp-servers/execution.js";
import { McpNetworkRejected } from "../../settings/mcp-servers/transport.js";
import type { CodeHostCall } from "./providers/quickjs.js";
import { mcpResultValue } from "./results.js";

/** The rejection dx made of the server's answer, if that is what failed. */
const rejectionOf = (error: unknown): McpNetworkRejected | undefined => {
  for (let cause = error, depth = 0; depth < 5; depth += 1) {
    if (cause instanceof McpNetworkRejected) return cause;
    if (typeof cause !== "object" || cause === null) return undefined;
    cause = (cause as { cause?: unknown }).cause;
  }
  return undefined;
};

const rejectionMessage = (
  rejection: McpNetworkRejected,
  server: string,
  tool: string,
) =>
  rejection.code === "TOOL_REVIEW_REQUIRED"
    ? `${server}'s tool "${tool}" changed since it was allowed, so dx blocked it. Someone must allow it again in Settings > Integrations & MCP.`
    : `dx rejected ${server}'s answer for "${tool}" (${rejection.code}).`;

/**
 * Passes the response through, and reports a rejection dx made while
 * streaming it. The MCP client turns an SSE stream that errors into a wait
 * for its request timeout, so the call watches for it here instead.
 */
const watchedBody = (
  response: Response,
  onRejected: (rejection: McpNetworkRejected) => void,
) => {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (error) {
          const rejection = rejectionOf(error);
          if (rejection !== undefined) onRejected(rejection);
          controller.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    }),
    response,
  );
};

/**
 * Fresh connections keep credentials and review admission current on every
 * call. Core's authorized fetch adds the configured headers.
 */
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
      name,
    );
    let rejectStream!: (rejection: McpNetworkRejected) => void;
    const streamRejected = new Promise<never>((_, reject) => {
      rejectStream = reject;
    });
    streamRejected.catch(() => undefined);
    const settled = <T>(operation: Promise<T>) =>
      Promise.race([operation, streamRejected]);
    const client = new Client({
      name: connection.clientName ?? DEFAULT_MCP_CLIENT_NAME,
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(connection.endpoint),
      {
        fetch: async (input, init) =>
          watchedBody(
            await authorizedFetch(input, {
              ...init,
              signal: AbortSignal.any([
                signal,
                ...(init?.signal ? [init.signal] : []),
              ]),
            }),
            rejectStream,
          ),
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
      await settled(client.connect(transport));
      const listing = await settled(
        client.listTools(undefined, {
          signal,
          timeout: connection.timeoutMs,
        }),
      );
      const tool = listing.tools.find((tool) => tool.name === name);
      if (!tool) throw new Error("Reviewed MCP tool is no longer available.");
      // request avoids the SDK's callTool output validation so .raw is truly raw.
      const result = await settled(
        client.request(
          { method: "tools/call", params: { name, arguments: input } },
          { signal, timeout: connection.timeoutMs },
        ),
      );
      return mcpResultValue(result, tool.outputSchema, raw);
    } catch (error) {
      const rejection = rejectionOf(error);
      if (rejection === undefined) throw error;
      throw new Error(
        rejectionMessage(
          rejection,
          connection.displayName ?? connection.name,
          name,
        ),
        { cause: error },
      );
    } finally {
      await client.close();
    }
  };
