import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import type { PluginPaneTab } from "../panes/pane-layout.js";
import type { PluginPaneMenuProps } from "../panes/pane-views.js";
import { pluginUiQueryOptions } from "../thread-queries.js";
import { PluginPanelBody } from "./plugin-data-panel.js";
import "./plugin-ui.css";

/**
 * An installed plugin's view in a Thread tab: a view described as data that
 * shows as a panel, or a Thread type's app. Loads when its tab is first
 * shown, and the Views menu's items when the menu first opens.
 */

/** A plugin's view; nothing loads until its tab is first shown. */
export function PluginPane({
  threadId,
  tab,
  active,
  canPost,
}: {
  readonly threadId: ThreadId;
  readonly tab: PluginPaneTab;
  readonly active: boolean;
  /** People who can only view the Thread see the view but cannot act. */
  readonly canPost: boolean;
}) {
  const [shown, setShown] = React.useState(active);
  if (active && !shown) setShown(true);
  if (!shown) return null;
  return (
    <div className="plugin-pane">
      <PluginPanelBody threadId={threadId} tab={tab} canPost={canPost} />
    </div>
  );
}

/** The Views menu's items for the views the Thread's plugins show as panels. */
export function PluginPaneMenuItems({
  threadId,
  renderItem,
}: PluginPaneMenuProps & { readonly threadId: ThreadId }) {
  const data = useQuery(pluginUiQueryOptions(threadId)).data;
  const panels = (data?.dataViews ?? []).flatMap((entry) =>
    entry.show.includes("panel")
      ? [
          {
            plugin: entry.plugin,
            pane: entry.view,
            title: entry.title,
            pluginTitle: entry.pluginTitle,
            ...(entry.icon === undefined ? {} : { icon: entry.icon }),
          },
        ]
      : [],
  );
  return <>{panels.map(renderItem)}</>;
}
