import { GetMcpAppViewsEndpoint } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { dxClient } from "../../shared/api/client.js";
import { retryQuery } from "../../shared/query/query-retry.js";

/**
 * The MCP App views of one tool call's card set. Only the lazily loaded
 * transcript cards import this, so it loads with the first card.
 */
const getMcpAppViews = async (
  threadId: ThreadId,
  cardSetId: string,
  signal?: AbortSignal,
) =>
  (
    await dxClient.call(
      GetMcpAppViewsEndpoint,
      { params: { threadId, cardSetId } },
      { signal },
    )
  ).data.views;

/** A card set never changes once its call's result is written. */
export const mcpAppViewsQueryOptions = (
  threadId: ThreadId,
  cardSetId: string,
) =>
  queryOptions({
    queryKey: ["mcp-app-views", threadId, cardSetId] as const,
    queryFn: ({ signal }) => getMcpAppViews(threadId, cardSetId, signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: retryQuery,
  });
