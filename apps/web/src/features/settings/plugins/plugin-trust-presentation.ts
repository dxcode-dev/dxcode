import type { PluginTrustData } from "@dx/api";
import type { PluginTier } from "@dx/domain";

export const tierLabel = {
  sandboxed: "Sandboxed",
  "personal-dev": "Dev",
  "workspace-trusted": "Workspace trusted",
  verified: "Verified",
} as const satisfies Record<PluginTier, string>;

/** Why the install runs at its tier, in a few words. */
export const tierReason = (trust: PluginTrustData) => {
  switch (trust.reason) {
    case "signature":
      return "Signed by a key the workspace trusts";
    case "requested":
      return "The plugin asks for this tier";
    case "cap":
      return "The workspace caps plugins at this tier";
    case "not-owner":
      return "Its powers apply only in your own Threads";
    case "scope":
      return trust.tier === "personal-dev"
        ? "Your own plugin, in your own Threads"
        : trust.tier === "workspace-trusted"
          ? "Installed by the workspace"
          : "Runs with the default limits";
  }
};

/** A short label beside the name, only where it changes what runs. */
export const tierBadge = (trust: PluginTrustData | undefined) =>
  trust?.tier === "personal-dev"
    ? "Dev"
    : trust?.tier === "verified"
      ? "Verified"
      : undefined;

export const NEEDS_WORKSPACE_TRUST = "Needs workspace trust";
