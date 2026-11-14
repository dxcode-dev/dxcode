import type { PluginArchivedMode } from "./plugin-bundle.js";
import type { PluginHostKind } from "./plugin-host-kind.js";
import { type PluginTier, TRUSTED_TIER, tierAtLeast } from "./plugin-trust.js";

/**
 * What a plugin shows in an archived Thread (`archivedThreads`). One place
 * decides it, so the Durable Object host changes only
 * `effectiveArchivedMode`.
 */

/** An item's own setting wins over the plugin's; `hide` when neither says. */
export const archivedModeFor = (
  pluginMode: PluginArchivedMode | undefined,
  itemMode?: PluginArchivedMode,
): PluginArchivedMode => itemMode ?? pluginMode ?? "hide";

export interface EffectiveArchivedMode {
  readonly mode: PluginArchivedMode;
  /** Set when `live` was asked for and could not be granted. */
  readonly downgraded?: "live-needs-trusted-tier" | "live-needs-durable-host";
}

/**
 * The mode dx grants. `live` runs plugin code for an archived Thread, which
 * needs a trusted tier and the Durable Object host, which never wakes the
 * Orb; without both it is served as `hide`, and the caller logs why.
 */
export const effectiveArchivedMode = (
  declared: PluginArchivedMode,
  tier: PluginTier | undefined,
  hostKinds: ReadonlyArray<PluginHostKind>,
): EffectiveArchivedMode => {
  if (declared !== "live") return { mode: declared };
  if (tier === undefined || !tierAtLeast(tier, TRUSTED_TIER))
    return { mode: "hide", downgraded: "live-needs-trusted-tier" };
  if (!hostKinds.includes("durable"))
    return { mode: "hide", downgraded: "live-needs-durable-host" };
  return { mode: "live" };
};
