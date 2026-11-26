import { defineEndpoint } from "../http/endpoint.js";
import {
  McpAppViewsErrorResponseSchema,
  McpAppViewsParamsSchema,
  McpAppViewsResponseSchema,
} from "./mcp-apps.js";
import { ThreadAccessRefusals } from "./thread-access-refusals.js";

/** The MCP App views endpoint, apart from `mcp-apps.ts`'s schemas. */
export const GetMcpAppViewsEndpoint = defineEndpoint({
  id: "threads.mcpApps.views",
  summary: "Read a Thread's MCP app views",
  method: "GET",
  path: "/v1/threads/:threadId/mcp-apps/:cardSetId",
  params: McpAppViewsParamsSchema,
  success: McpAppViewsResponseSchema,
  // One union of codes, each sent with its own status.
  refusals: [
    ...ThreadAccessRefusals,
    { status: 400, schema: McpAppViewsErrorResponseSchema },
    { status: 503, schema: McpAppViewsErrorResponseSchema },
  ],
});
