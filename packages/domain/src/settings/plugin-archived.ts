import type { PluginArchivedMode } from "./plugin-bundle.js";

/**
 * What a plugin shows in an archived Thread (`archivedThreads`). One place
 * decides it.
 */

/** An item's own setting wins over the plugin's; `hide` when neither says. */
export const archivedModeFor = (
  pluginMode: PluginArchivedMode | undefined,
  itemMode?: PluginArchivedMode,
): PluginArchivedMode => itemMode ?? pluginMode ?? "hide";

export interface EffectiveArchivedMode {
  readonly mode: PluginArchivedMode;
  /** Set when `live` was asked for and could not be granted. */
  readonly downgraded?: "live-needs-install";
}

/**
 * The mode dx grants. `live` runs plugin code for an archived Thread, which
 * a personal or workspace install gets; a plugin a repository carries,
 * which nobody installed, is served as `hide`.
 */
export const effectiveArchivedMode = (
  declared: PluginArchivedMode,
  scope: "personal" | "workspace" | "repository",
): EffectiveArchivedMode =>
  declared === "live" && scope === "repository"
    ? { mode: "hide", downgraded: "live-needs-install" }
    : { mode: declared };
