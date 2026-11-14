/**
 * The trust tier the hosts read. The trust tiers live in
 * `@dx/domain` (`plugin-trust.ts`); this module re-exports them so the hosts
 * have one import site.
 */
export {
  PLUGIN_TIERS,
  type PluginTier,
  TRUSTED_TIER,
  tierAtLeast,
} from "@dx/domain";

/**
 * worker-host/host.ts's `callTier`, without importing the capability
 * object (and `cloudflare:workers` with it) into modules that only read
 * tiers: the call's tier, else the install's, else sandboxed.
 */
export const callTierOf = (call: {
  readonly tier?: import("@dx/domain").PluginTier | undefined;
  readonly install: {
    readonly tier?: import("@dx/domain").PluginTier | undefined;
  };
}): import("@dx/domain").PluginTier =>
  call.tier ?? call.install.tier ?? "sandboxed";
