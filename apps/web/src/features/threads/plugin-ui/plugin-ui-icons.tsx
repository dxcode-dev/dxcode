import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import * as React from "react";
import {
  PluginIcon,
  type PluginIconSize,
} from "../../../shared/ui/plugin-icon.js";
import { pluginUiQueryOptions } from "../thread-queries.js";
import { ThreadPresentationContext } from "../thread-session-context.js";
import "./plugin-ui.css";
import { iconByName, iconForItem } from "./plugin-ui-icon-lookup.js";

/**
 * The Thread's plugin icons, from the plugin UI query
 * every plugin surface already reads: items name their plugin by display
 * name (`plugin`), panes by manifest name.
 */

/** A plugin pane's tab or menu icon: the pane's own, else its plugin's. */
export function PluginPaneIcon({
  threadId,
  plugin,
  pane,
  title,
  size = 16,
}: {
  readonly threadId: ThreadId;
  readonly plugin: string;
  readonly pane: string;
  readonly title: string;
  readonly size?: PluginIconSize;
}) {
  const found = useQuery({
    ...pluginUiQueryOptions(threadId),
    select: (data) => ({
      icon: iconByName(data, plugin),
      item:
        data.panes?.find(
          (entry) => entry.plugin === plugin && entry.pane === pane,
        )?.icon ??
        // A plugin tab's own icon.
        data.tabs?.find(
          (entry) => entry.plugin === plugin && entry.tab === pane,
        )?.icon,
      pluginTitle:
        data.plugins?.find((entry) => entry.name === plugin)?.title ?? plugin,
    }),
  }).data;
  return (
    <PluginIcon
      name={found?.pluginTitle ?? title}
      icon={found?.icon}
      item={found?.item}
      size={size}
      className="plugin-pane-tab-icon"
    />
  );
}

/** The same icon where only the route knows the open Thread. */
export function RoutePluginPaneIcon(props: {
  readonly plugin: string;
  readonly pane: string;
  readonly title: string;
  readonly size?: PluginIconSize;
}) {
  const threadId = useParams({
    strict: false,
    select: (params) => (params as { threadId?: string }).threadId,
  });
  return threadId === undefined ? null : (
    <PluginPaneIcon threadId={threadId as ThreadId} {...props} />
  );
}

/**
 * A plugin tool's icon on its transcript row; nothing for dx's own tools.
 * The Thread comes from the transcript's own Thread session, not the route:
 * a transcript renders without a router in its tests, and an embedded
 * Thread's transcript is not the route's Thread.
 */
export function PluginToolIcon({ toolName }: { readonly toolName: string }) {
  const threadId = React.useContext(ThreadPresentationContext)?.id;
  return threadId === undefined ? null : (
    <ThreadPluginToolIcon threadId={threadId} toolName={toolName} />
  );
}

function ThreadPluginToolIcon({
  threadId,
  toolName,
}: {
  readonly threadId: ThreadId;
  readonly toolName: string;
}) {
  const found = useQuery({
    ...pluginUiQueryOptions(threadId),
    select: (data) => {
      const tool = data.tools?.find(({ name }) => name === toolName);
      return tool === undefined
        ? undefined
        : { tool, icon: iconForItem(data, tool) };
    },
  }).data;
  if (found === undefined) return null;
  return (
    <PluginIcon
      name={found.tool.plugin}
      icon={found.icon}
      item={found.tool.icon}
      size={16}
      className="plugin-tool-icon"
      label={found.tool.plugin}
    />
  );
}
