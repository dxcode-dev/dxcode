import {
  PluginHostKind,
  type PluginTier,
  type PluginTierLimits,
  pluginTierLimits,
} from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Schema } from "effect";

const logger = getLogger(["dx", "plugins", "trust"]);

// Kept out of @dx/domain so the web bundle doesn't carry these schemas.
const Limit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** One tier's overrides, as config states them. */
export const PluginTierLimitsOverride = Schema.Struct({
  callMs: Schema.optional(Limit),
  paneMessagesPerMinute: Schema.optional(Limit),
  streamBytesPerSecond: Schema.optional(Limit),
  storageSqlBytes: Schema.optional(Limit),
  blobBytes: Schema.optional(Limit),
  codeBytes: Schema.optional(Limit),
  binaryAssetBytes: Schema.optional(Limit),
  networkHosts: Schema.optional(Limit),
  jobs: Schema.optional(Limit),
  hosts: Schema.optional(Schema.Array(PluginHostKind)),
});

/** `PLUGIN_TIER_LIMITS`: overrides keyed by tier, as JSON. */
export const PluginTierLimitsConfig = Schema.Struct({
  sandboxed: Schema.optional(PluginTierLimitsOverride),
  "personal-dev": Schema.optional(PluginTierLimitsOverride),
  "workspace-trusted": Schema.optional(PluginTierLimitsOverride),
  verified: Schema.optional(PluginTierLimitsOverride),
});
export type PluginTierLimitsConfig = typeof PluginTierLimitsConfig.Type;

let cached: { raw: string; config: PluginTierLimitsConfig } | undefined;

/**
 * The deployment's tier limit overrides (`DX_PLUGIN_TIER_LIMITS`), parsed
 * once per isolate. The deploy already validated them; a value that still
 * fails to parse keeps the defaults and logs an error.
 */
const configured = (raw: string | undefined): PluginTierLimitsConfig => {
  if (raw === undefined || raw === "") return {};
  if (cached?.raw === raw) return cached.config;
  let config: PluginTierLimitsConfig = {};
  try {
    config = Schema.decodeUnknownSync(PluginTierLimitsConfig)(JSON.parse(raw));
  } catch (error) {
    logger.error("DX_PLUGIN_TIER_LIMITS is malformed; using the defaults.", {
      event: "plugin_tier_limits_malformed",
      error: String(error).slice(0, 300),
    });
  }
  cached = { raw, config };
  return config;
};

/** A tier's limits: the plan §4.6 defaults with the deployment's overrides. */
export const configuredTierLimits = (
  bindings: { readonly DX_PLUGIN_TIER_LIMITS?: string },
  tier: PluginTier,
): PluginTierLimits =>
  pluginTierLimits(tier, configured(bindings.DX_PLUGIN_TIER_LIMITS)[tier]);
