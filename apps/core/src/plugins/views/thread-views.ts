import type { PluginThreadTypeEntry } from "@dx/api";
import type { ResolvedCodePlugin } from "../worker-host/resolve.js";

/**
 * A Thread's plugin type, from the plugins the Thread's plugin UI request
 * already resolved: no D1 read of its own.
 */

export interface ThreadViewState {
  readonly archived: boolean;
}

/**
 * The Thread's plugin type as it resolves now. A view described as data
 * that shows as an app draws the main area, with the chat beside it.
 * Unavailable when its plugin is off, removed, no longer has the view, or
 * the Thread is archived: the Thread then opens as a plain chat.
 */
export const threadTypeEntry = (
  ref: string | undefined,
  plugins: ReadonlyArray<ResolvedCodePlugin>,
  state: ThreadViewState,
): PluginThreadTypeEntry | undefined => {
  if (ref === undefined) return undefined;
  const [pluginName = "", type = ""] = ref.split("/");
  const plugin = plugins.find((candidate) => candidate.name === pluginName);
  const app = plugin?.code.dataViews?.find(
    ({ id, show }) => id === type && show.includes("app"),
  );
  if (
    plugin !== undefined &&
    app !== undefined &&
    plugin.scope !== "repository"
  )
    return {
      ref,
      plugin: pluginName,
      type,
      title: app.title,
      pluginTitle: plugin.displayName,
      ...(app.icon === undefined ? {} : { icon: app.icon }),
      view: app.id,
      chat: "side",
      // An archived Thread shows no views described as data.
      available: !state.archived,
    };
  return {
    ref,
    plugin: pluginName,
    type,
    // A removed plugin's type keeps a readable name: `incident-room` reads
    // "Incident room".
    title: (
      type.charAt(0).toUpperCase() + type.slice(1).replace(/-/g, " ")
    ).slice(0, 40),
    ...(plugin === undefined ? {} : { pluginTitle: plugin.displayName }),
    available: false,
  };
};
