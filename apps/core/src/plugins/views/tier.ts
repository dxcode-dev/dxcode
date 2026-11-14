import { type PluginTier, TRUSTED_TIER, tierAtLeast } from "@dx/domain";

/**
 * The trust tier views and plugin calls check: the install's resolved tier (resolution fills
 * `install.tier` from rows resolution already loads; absent is sandboxed).
 * Tabs, pages, and Thread types need at least `TRUSTED_TIER`; a plugin call
 * needs the caller's tier at least the callee's.
 */

export { type PluginTier, tierAtLeast };

export const installTier = (install: {
  readonly tier?: PluginTier | undefined;
}): PluginTier => install.tier ?? "sandboxed";

/** Whether the install may show tabs, pages, and Thread types. */
export const showsViews = (install: {
  readonly tier?: PluginTier | undefined;
}) => tierAtLeast(installTier(install), TRUSTED_TIER);
