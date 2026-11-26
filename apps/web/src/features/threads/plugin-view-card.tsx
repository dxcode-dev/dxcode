import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import * as React from "react";
import { DataViewSlot } from "../../shared/realtime/live.js";
import { Card } from "../../shared/ui/card.js";
import { pluginUiQueryOptions } from "./thread-queries.js";
import { ThreadPresentationContext } from "./thread-session-context.js";

/**
 * A plugin's view described as data, as a card under the tool call that
 * named it. The card is the view itself: live, with the same state the
 * view's page and panel show.
 */
export function PluginViewCard({
  toolName,
  view,
}: {
  readonly toolName: string;
  readonly view: string;
}) {
  const params = useParams({ strict: false }) as { threadId?: string };
  const threadId =
    React.useContext(ThreadPresentationContext)?.id ??
    (params.threadId as ThreadId | undefined);
  const View = React.use(DataViewSlot);
  const entry = useQuery({
    ...pluginUiQueryOptions(threadId ?? ("" as ThreadId)),
    enabled: threadId !== undefined,
    select: (data) => {
      const plugin = data.tools?.find(
        ({ name }) => name === toolName,
      )?.pluginName;
      return data.dataViews?.find(
        (candidate) =>
          candidate.plugin === plugin &&
          candidate.view === view &&
          candidate.show.includes("card"),
      );
    },
  }).data;
  if (threadId === undefined || entry === undefined || View === undefined)
    return null;
  return (
    <Card padding="md" className="transcript-plugin-view-card">
      <React.Suspense fallback={null}>
        <View
          address={{
            source: { kind: "thread", threadId },
            plugin: entry.plugin,
            view: entry.view,
            installId: entry.installId,
            integrity: entry.integrity,
          }}
          showTitle
        />
      </React.Suspense>
    </Card>
  );
}
