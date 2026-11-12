import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

export {
  MCP_APP_OUTPUT_NOTE,
  mcpAppCardSetId,
} from "../views/mcp-app-note.mjs";

/** A `code_exec` call's set of cards. */
export const McpAppCardSetId = Schema.String.check(
  Schema.isPattern(/^mcpa_[0-9a-f]{32}$/),
);

/** The resource MIME type MCP Apps views use. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** The largest view HTML dx keeps for a card. */
export const MCP_APP_MAX_HTML_BYTES = 512 * 1_024;
/** The largest tool input or result, as JSON, a card hands its view. */
export const MCP_APP_MAX_DATA_BYTES = 256 * 1_024;
/** Cards one `code_exec` call can show. */
export const MCP_APP_MAX_VIEWS_PER_CALL = 8;

/** One card: the view's HTML and the call it shows. */
export const McpAppViewSchema = Schema.Struct({
  /** The server's name as Settings shows it. */
  server: Schema.String,
  tool: Schema.String,
  resourceUri: Schema.String,
  html: Schema.String,
  /** The tool call's arguments (`ui/notifications/tool-input`). */
  toolInput: Schema.Unknown,
  /** The raw `CallToolResult` (`ui/notifications/tool-result`). */
  toolResult: Schema.Unknown,
  prefersBorder: Schema.optional(Schema.Boolean),
});
export type McpAppView = typeof McpAppViewSchema.Type;

/** A saved card: its view and its place in the call's card set. */
export const McpAppCardSchema = Schema.Struct({
  ...McpAppViewSchema.fields,
  ordinal: Schema.Int,
});
export type McpAppCard = typeof McpAppCardSchema.Type;

export const McpAppViewsParamsSchema = Schema.Struct({
  threadId: ThreadId,
  cardSetId: McpAppCardSetId,
});

/** `GET /v1/threads/:threadId/mcp-apps/:cardSetId` */
export const McpAppViewsResponseSchema = successResponse(
  Schema.Struct({ views: Schema.Array(McpAppCardSchema) }),
);
export type McpAppViewsResponse = typeof McpAppViewsResponseSchema.Type;

export const McpAppViewsErrorResponseSchema = Schema.Union([
  errorResponse("INVALID_REQUEST", "Request validation failed."),
  errorResponse("THREAD_NOT_FOUND", "Thread was not found."),
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  ),
]);
