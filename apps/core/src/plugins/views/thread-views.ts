import type { PluginTabEntry, PluginThreadTypeEntry } from "@dx/api";
import {
  archivedModeFor,
  effectiveArchivedMode,
  type PluginViewTab,
  pluginHostKinds,
} from "@dx/domain";
import { viewerPaneTier } from "../trust/resolve-tier.js";
import type { ResolvedCodePlugin } from "../worker-host/resolve.js";
import { installTier, showsViews } from "./tier.js";

/**
 * A Thread's plugin tabs and its plugin type, from the plugins the
 * Thread's plugin UI request already resolved: no D1 read of its own.
 */

/**
 * How a tab shows in an archived Thread, by the panes' rule: its own
 * `archivedThreads` over the plugin's, `hide` when neither says, and
 * `live` only where the tier and a live host allow it.
 */
const archivedMode = (plugin: ResolvedCodePlugin, tab: PluginViewTab) =>
  effectiveArchivedMode(
    archivedModeFor(plugin.code.archivedThreads, tab.archivedThreads),
    plugin.tier,
    pluginHostKinds(plugin.code),
  ).mode;

export interface ThreadViewState {
  readonly archived: boolean;
  /**
   * The person looking. A personal install's views are trusted only in its
   * owner's browser; anyone else sees them at the sandboxed tier, which
   * shows no tabs or Thread types (`viewerPaneTier`).
   */
  readonly viewerUserId: string | undefined;
}

/** The tier the viewer sees the install's views at. */
const viewerTier = (plugin: ResolvedCodePlugin, state: ThreadViewState) => ({
  tier: viewerPaneTier(
    installTier(plugin),
    plugin.scope,
    plugin.targetId,
    state.viewerUserId,
  ),
});

/** A tab view the Thread may show, with whether it is read-only now. */
export const findThreadTab = (
  plugin: ResolvedCodePlugin,
  id: string,
  state: ThreadViewState,
) => {
  if (plugin.loadError !== undefined || !showsViews(viewerTier(plugin, state)))
    return undefined;
  const tab = plugin.code.views?.tabs.find((candidate) => candidate.id === id);
  const view = plugin.views.find((candidate) => candidate.id === id);
  if (tab === undefined || view === undefined) return undefined;
  const mode = state.archived ? archivedMode(plugin, tab) : "live";
  if (mode === "hide") return undefined;
  return {
    pane: {
      id,
      title: tab.title,
      html: view.html,
      // A read-only tab in an archived Thread takes no messages.
      handlesMessages: view.handlesMessages && mode === "live",
    },
    readOnly: mode === "show",
    tab,
  };
};

export const threadTabs = (
  plugins: ReadonlyArray<ResolvedCodePlugin>,
  state: ThreadViewState,
): PluginTabEntry[] =>
  plugins.flatMap((plugin) =>
    (plugin.code.views?.tabs ?? []).flatMap((declared) => {
      const found = findThreadTab(plugin, declared.id, state);
      return found === undefined
        ? []
        : [
            {
              plugin: plugin.name,
              tab: declared.id,
              title: declared.title,
              pluginTitle: plugin.displayName,
              version: plugin.version,
              ...(declared.icon === undefined ? {} : { icon: declared.icon }),
              ...(found.readOnly ? { readOnly: true as const } : {}),
            },
          ];
    }),
  );

/**
 * The Thread's plugin type as it resolves now. Unavailable when its plugin
 * is off, removed, failed to start, below the trusted tier, or its view is
 * hidden in an archived Thread: the Thread then opens as a plain chat.
 */
export const threadTypeEntry = (
  ref: string | undefined,
  plugins: ReadonlyArray<ResolvedCodePlugin>,
  state: ThreadViewState,
): PluginThreadTypeEntry | undefined => {
  if (ref === undefined) return undefined;
  const [pluginName = "", type = ""] = ref.split("/");
  const plugin = plugins.find((candidate) => candidate.name === pluginName);
  const declared = plugin?.code.views?.threadTypes.find(
    ({ id }) => id === type,
  );
  const tab =
    plugin === undefined || declared === undefined
      ? undefined
      : findThreadTab(plugin, declared.view, state);
  return {
    ref,
    plugin: pluginName,
    type,
    // A removed plugin's type keeps a readable name: `incident-room` reads
    // "Incident room".
    title:
      declared?.title ??
      (type.charAt(0).toUpperCase() + type.slice(1).replace(/-/g, " ")).slice(
        0,
        40,
      ),
    ...(plugin === undefined ? {} : { pluginTitle: plugin.displayName }),
    ...(declared?.icon === undefined ? {} : { icon: declared.icon }),
    ...(declared === undefined
      ? {}
      : { view: declared.view, chat: declared.chat }),
    available: tab !== undefined,
  };
};
