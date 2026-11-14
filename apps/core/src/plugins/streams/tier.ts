import { type PluginTier, TRUSTED_TIER, tierAtLeast } from "@dx/domain";
import type { Bindings } from "../../http/types.js";
import { configuredTierLimits } from "../trust/limits.js";
import { viewerPaneTier } from "../trust/resolve-tier.js";

/**
 * What streams read of a plugin's trust tier: the tier
 * resolution recorded on the install, from rows already loaded, and the
 * deployment's limits for it. No D1 read.
 */

export type { PluginTier };

/** The install's resolved tier; sandboxed when resolution recorded none. */
export const pluginTier = (install: { readonly tier?: PluginTier }) =>
  install.tier ?? "sandboxed";

/** Streams, WebRTC, pane connect, and raised limits start here. */
export const tierIsTrusted = (tier: PluginTier) =>
  tierAtLeast(tier, TRUSTED_TIER);

/** The tier's stream bandwidth and pane message cap. */
export const streamLimits = (bindings: Bindings, tier: PluginTier) => {
  const limits = configuredTierLimits(bindings, tier);
  return {
    streamBytesPerSecond: tierIsTrusted(tier) ? limits.streamBytesPerSecond : 0,
    paneMessagesPerMinute: limits.paneMessagesPerMinute,
  };
};

/** Whether the tier may stream: trusted, with bandwidth configured. */
export const tierStreams = (bindings: Bindings, tier: PluginTier) =>
  streamLimits(bindings, tier).streamBytesPerSecond > 0;

/**
 * The tier a pane runs at for the person viewing it (`viewerPaneTier`): a
 * personal install's trusted powers apply only in its owner's own browser.
 * From what resolution already loaded: no D1 read.
 */
export const viewerTier = (
  install: {
    readonly scope: "personal" | "workspace" | "repository";
    readonly targetId: string;
    readonly tier?: PluginTier;
  },
  viewerUserId: string,
): PluginTier =>
  viewerPaneTier(
    pluginTier(install),
    install.scope,
    install.targetId,
    viewerUserId,
  );
