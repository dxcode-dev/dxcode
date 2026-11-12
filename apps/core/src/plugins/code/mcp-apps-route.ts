import {
  McpAppViewsErrorResponseSchema,
  McpAppViewsParamsSchema,
  McpAppViewsResponseSchema,
} from "@dx/api";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../http/types.js";
import { mcpAppsLogger } from "../../logging.js";
import { readMcpAppViews } from "./mcp-apps.js";

const errorJson = (
  context: Context<AppEnv>,
  code: "INVALID_REQUEST" | "PERSISTENCE_UNAVAILABLE",
  message: string,
  status: 400 | 503,
) =>
  context.json(
    Schema.encodeUnknownSync(McpAppViewsErrorResponseSchema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );

/**
 * `/v1/threads/:threadId/mcp-apps/:cardSetId`: the MCP Apps
 * cards a `code_exec` call showed. `authorizeThread` admits whoever can
 * read the Thread.
 */
export const mcpAppViewRoutes = new Hono<AppEnv>().get(
  "/:threadId/mcp-apps/:cardSetId",
  async (context) => {
    const params = Schema.decodeUnknownOption(McpAppViewsParamsSchema)({
      threadId: context.req.param("threadId"),
      cardSetId: context.req.param("cardSetId"),
    });
    if (Option.isNone(params))
      return errorJson(
        context,
        "INVALID_REQUEST",
        "Request validation failed.",
        400,
      );
    const db = context.env.DB;
    if (db === undefined)
      return errorJson(
        context,
        "PERSISTENCE_UNAVAILABLE",
        "Persistence is temporarily unavailable.",
        503,
      );
    const { threadId, cardSetId } = params.value;
    try {
      const views = await readMcpAppViews(db, threadId, cardSetId);
      // A card set never changes once its call's result is written.
      context.header("cache-control", "private, max-age=3600");
      return context.json(
        Schema.encodeUnknownSync(McpAppViewsResponseSchema)({
          status: "success",
          data: { views },
        }),
        200,
      );
    } catch (cause) {
      mcpAppsLogger.error("MCP App views request failed.", {
        event: "mcp_app_views_request_failed",
        requestId: context.get("requestId"),
        cause,
      });
      return errorJson(
        context,
        "PERSISTENCE_UNAVAILABLE",
        "Persistence is temporarily unavailable.",
        503,
      );
    }
  },
);
