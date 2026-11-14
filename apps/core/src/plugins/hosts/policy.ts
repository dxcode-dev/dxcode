import type { PluginHostKind } from "@dx/domain";
import { type PluginTier, TRUSTED_TIER, tierAtLeast } from "./tier.js";

/**
 * Whether a tier may use a host: the Worker host for every tier, the others
 * from {@link TRUSTED_TIER} up. `pluginTierLimits(tier).hosts` replaces
 * this once it lands.
 */
export const tierAllowsHost = (tier: PluginTier, kind: PluginHostKind) =>
  kind === "worker" || tierAtLeast(tier, TRUSTED_TIER);
