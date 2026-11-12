import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import * as React from "react";
import { McpAppView } from "../../shared/ui/mcp-app-view.js";
import { mcpAppViewsQueryOptions } from "./mcp-app-queries.js";
import { ThreadPresentationContext } from "./thread-session-context.js";

function McpAppCardList({
  threadId,
  cardSetId,
}: {
  readonly threadId: ThreadId;
  readonly cardSetId: string;
}) {
  const views = useQuery(mcpAppViewsQueryOptions(threadId, cardSetId));
  if (views.isError)
    return (
      <p className="markdown-view-note" role="status">
        This MCP App card could not load.
      </p>
    );
  if (views.data === undefined)
    return <div className="markdown-view-pending" />;
  return (
    <>
      {views.data.map((view) => (
        <McpAppView
          key={view.ordinal}
          view={view}
          cardKey={`${cardSetId}:${view.ordinal}`}
        />
      ))}
    </>
  );
}

/**
 * The MCP App cards of one `code_exec` call, under its tool row: each tool
 * that named a `ui://` view shows it, sandboxed as a dx-view is.
 */
export function McpAppCards({ cardSetId }: { readonly cardSetId: string }) {
  const params = useParams({ strict: false }) as { threadId?: string };
  const threadId =
    React.useContext(ThreadPresentationContext)?.id ??
    (params.threadId as ThreadId | undefined);
  if (threadId === undefined) return null;
  return (
    <div className="transcript-mcp-app-cards">
      <McpAppCardList threadId={threadId} cardSetId={cardSetId} />
    </div>
  );
}
