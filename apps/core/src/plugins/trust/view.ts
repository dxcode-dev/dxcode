import type { PluginTrustData } from "@dx/api";
import { type PluginBundleCode, pluginTierLimits } from "@dx/domain";
import { blockedPluginFeatures } from "./features.js";
import type { PluginTrustPolicy } from "./policy.js";
import { resolveInstallTier } from "./resolve-tier.js";

/**
 * An install's tier as its owner's Threads resolve it, for the Plugins
 * page: the tier, why, and the features it drops. Limits are the defaults;
 * the page names features, not numbers a deployment may change.
 */
export const pluginTrustData = (
  scope: "personal" | "workspace",
  code: PluginBundleCode,
  policy: PluginTrustPolicy,
  fingerprint: string | undefined,
): PluginTrustData => {
  const { tier, reason } = resolveInstallTier(scope, code.tier, {
    workspaceCap: policy.tierCap,
    signedByTrustedKey:
      scope === "workspace" &&
      fingerprint !== undefined &&
      policy.trustedSigners.includes(fingerprint),
  });
  return {
    tier,
    reason,
    blocked: blockedPluginFeatures(code, tier, pluginTierLimits(tier)),
  };
};
