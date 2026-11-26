import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { DataViewSlot } from "../../../shared/realtime/live.js";
import type { PluginPaneTab } from "../panes/pane-layout.js";
import { pluginUiQueryOptions } from "../thread-queries.js";

/**
 * A plugin tab's view described as data. A saved layout may still hold a tab
 * whose plugin no longer offers a view here; it says so.
 */
export function PluginPanelBody({
  threadId,
  tab,
  canPost,
}: {
  readonly threadId: ThreadId;
  readonly tab: PluginPaneTab;
  readonly canPost: boolean;
}) {
  const dataView = useQuery({
    ...pluginUiQueryOptions(threadId),
    select: (data) =>
      data.dataViews?.find(
        (entry) =>
          entry.plugin === tab.plugin &&
          entry.view === tab.pane &&
          (entry.show.includes("panel") || entry.show.includes("app")),
      ),
  });
  const View = React.use(DataViewSlot);
  if (dataView.isPending) return null;
  const entry = dataView.data;
  if (entry === undefined || View === undefined)
    return (
      <p className="plugin-pane-state" role="status">
        {tab.title} is not available in this Thread.
      </p>
    );
  return (
    <div className="plugin-data-panel">
      <React.Suspense fallback={null}>
        <View
          address={{
            source: { kind: "thread", threadId },
            plugin: entry.plugin,
            view: entry.view,
            installId: entry.installId,
            integrity: entry.integrity,
          }}
          {...(canPost
            ? {}
            : {
                disabledReason:
                  "People who can only view this Thread cannot use its plugins.",
              })}
        />
      </React.Suspense>
    </div>
  );
}
