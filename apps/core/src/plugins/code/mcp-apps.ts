import {
  MCP_APP_MAX_DATA_BYTES,
  MCP_APP_MAX_HTML_BYTES,
  MCP_APP_MAX_VIEWS_PER_CALL,
  MCP_APP_MIME_TYPE,
  MCP_APP_OUTPUT_NOTE,
  type McpAppCard,
  type McpAppView,
} from "@dx/api";
import type { Client } from "@modelcontextprotocol/client";
import { mcpAppsLogger } from "../../logging.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const uiUri = (meta: unknown): string | undefined => {
  const value = record(meta);
  // `_meta.ui.resourceUri`; early MCP Apps drafts used a flat key.
  const uri = record(value?.ui)?.resourceUri ?? value?.["ui/resourceUri"];
  return typeof uri === "string" &&
    uri.startsWith("ui://") &&
    uri.length <= 2048
    ? uri
    : undefined;
};

/**
 * The `ui://` view a tool call should show, if any: the result's own
 * `_meta.ui.resourceUri` first, then the one its tool definition declares.
 */
export const mcpAppResourceUri = (tool: unknown, result: unknown) =>
  uiUri(record(result)?._meta) ?? uiUri(record(tool)?._meta);

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

const decodeBase64 = (blob: string) => {
  const bytes = Uint8Array.from(atob(blob), (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};

const fits = (json: string) => byteLength(json) <= MCP_APP_MAX_DATA_BYTES;

/** The call's arguments as JSON, or none when they are too large. */
const boundedInput = (value: unknown) => {
  const json = JSON.stringify(record(value) ?? {});
  return fits(json) ? json : "{}";
};

/**
 * The result as JSON. A result too large keeps a valid `CallToolResult`:
 * its structured content, else its error flag alone, so the view still
 * gets `ui/notifications/tool-result`.
 */
const boundedResult = (value: unknown) => {
  const result = record(value) ?? {};
  const full = JSON.stringify(result);
  if (fits(full)) return full;
  const trimmed = JSON.stringify({
    content: [],
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent }),
    ...(result.isError === true ? { isError: true } : {}),
  });
  return fits(trimmed)
    ? trimmed
    : JSON.stringify({
        content: [],
        ...(result.isError === true ? { isError: true } : {}),
      });
};

/** A new id for one call's card set. */
export const newMcpAppCardSetId = () =>
  `mcpa_${crypto.randomUUID().replaceAll("-", "")}`;

/**
 * Reads the view over the call's own connection. A view is optional: a
 * server that cannot serve it, or serves something other than HTML, leaves
 * the call's result as it is, without a card.
 */
export const readMcpAppView = async (
  client: Client,
  uri: string,
  options: { readonly signal: AbortSignal; readonly timeout: number },
): Promise<{ html: string; prefersBorder?: boolean } | undefined> => {
  try {
    const read = await client.readResource({ uri }, options);
    const content = read.contents.find((item) => item.uri === uri);
    if (content === undefined) return undefined;
    const mimeType = content.mimeType?.replaceAll(" ", "").toLowerCase();
    if (mimeType !== MCP_APP_MIME_TYPE && mimeType !== "text/html")
      return undefined;
    const html =
      "text" in content && typeof content.text === "string"
        ? content.text
        : "blob" in content && typeof content.blob === "string"
          ? decodeBase64(content.blob)
          : undefined;
    if (html === undefined || byteLength(html) > MCP_APP_MAX_HTML_BYTES)
      return undefined;
    const prefersBorder = record(record(content._meta)?.ui)?.prefersBorder;
    return typeof prefersBorder === "boolean"
      ? { html, prefersBorder }
      : { html };
  } catch (cause) {
    mcpAppsLogger.warn("MCP App view could not be read.", {
      event: "mcp_app_view_read_failed",
      uri,
      cause,
    });
    return undefined;
  }
};

/** The line `code_exec` adds to its output for the cards it showed. */
export const mcpAppOutputNote = (
  views: ReadonlyArray<McpAppView>,
  cardSetId: string,
) =>
  `${MCP_APP_OUTPUT_NOTE} ${[
    ...new Set(views.map((view) => `${view.server} ${view.tool}`)),
  ].join(", ")} (${cardSetId})]`;

/**
 * The views one `code_exec` call collects: the first eight, so a loop of
 * calls neither holds more HTML nor reads more resources.
 */
export const collectMcpAppViews = () => {
  const views: McpAppView[] = [];
  return {
    views,
    wants: () => views.length < MCP_APP_MAX_VIEWS_PER_CALL,
    add: (view: McpAppView) => {
      if (views.length < MCP_APP_MAX_VIEWS_PER_CALL) views.push(view);
    },
  };
};
export type McpAppViewCollector = ReturnType<typeof collectMcpAppViews>;

/**
 * Keeps a call's cards for its tool row; the first eight, in call order.
 * Reports whether they were kept: a card that cannot be saved is left out
 * and the call's result stands.
 */
export const storeMcpAppViews = async (
  db: D1Database,
  threadId: string,
  cardSetId: string,
  views: ReadonlyArray<McpAppView>,
  now = new Date(),
) => {
  const kept = views.slice(0, MCP_APP_MAX_VIEWS_PER_CALL);
  if (kept.length === 0) return false;
  try {
    await db.batch(
      kept.map((view, ordinal) =>
        db
          .prepare(
            `INSERT INTO mcp_app_view (thread_id, card_set_id, ordinal, server,
             tool, resource_uri, html, tool_input, tool_result, prefers_border,
             created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
          )
          .bind(
            threadId,
            cardSetId,
            ordinal,
            view.server.slice(0, 256),
            view.tool.slice(0, 256),
            view.resourceUri,
            view.html,
            boundedInput(view.toolInput),
            boundedResult(view.toolResult),
            view.prefersBorder === undefined
              ? null
              : view.prefersBorder
                ? 1
                : 0,
            now.toISOString(),
          ),
      ),
    );
    return true;
  } catch (cause) {
    mcpAppsLogger.error("MCP App views could not be saved.", {
      event: "mcp_app_view_store_failed",
      threadId,
      cause,
    });
    return false;
  }
};

export const readMcpAppViews = async (
  db: D1Database,
  threadId: string,
  cardSetId: string,
): Promise<McpAppCard[]> => {
  const { results } = await db
    .prepare(
      `SELECT ordinal, server, tool, resource_uri, html, tool_input, tool_result,
              prefers_border
         FROM mcp_app_view WHERE thread_id = ?1 AND card_set_id = ?2
        ORDER BY ordinal`,
    )
    .bind(threadId, cardSetId)
    .all<{
      ordinal: number;
      server: string;
      tool: string;
      resource_uri: string;
      html: string;
      tool_input: string;
      tool_result: string;
      prefers_border: number | null;
    }>();
  return results.map((row) => ({
    ordinal: row.ordinal,
    server: row.server,
    tool: row.tool,
    resourceUri: row.resource_uri,
    html: row.html,
    toolInput: JSON.parse(row.tool_input) as unknown,
    toolResult: JSON.parse(row.tool_result) as unknown,
    ...(row.prefers_border === null
      ? {}
      : { prefersBorder: row.prefers_border === 1 }),
  }));
};
