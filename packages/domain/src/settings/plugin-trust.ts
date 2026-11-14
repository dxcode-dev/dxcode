import { Schema } from "effect";
import { PLUGIN_HOST_KINDS, type PluginHostKind } from "./plugin-host-kind.js";

/**
 * Plugin trust tiers, lowest to highest. A plugin's tier decides which hosts
 * its code may run on and how far its limits reach; the invariants hold in
 * every tier (the `tool.call` gate fails closed, secrets never reach panes,
 * a workspace `disabled` wins, and every capability use is audited).
 *
 * - `sandboxed`: repository plugins, unreviewed shares, anything else.
 *   Today's rules: Worker host only, sealed panes, today's limits.
 * - `personal-dev`: the caller's own personal install, in Threads they own.
 *   Workspace-trusted powers, labelled "dev", hot reloaded.
 * - `workspace-trusted`: installed by a workspace admin, or carried by a
 *   repository an admin marked trusted.
 * - `verified`: a workspace install signed by a key the workspace trusts.
 */
export const PLUGIN_TIERS = [
  "sandboxed",
  "personal-dev",
  "workspace-trusted",
  "verified",
] as const;

export const PluginTier = Schema.Literals(PLUGIN_TIERS);
export type PluginTier = (typeof PLUGIN_TIERS)[number];

const rank = (tier: PluginTier) => PLUGIN_TIERS.indexOf(tier);

/** Whether `tier` is `min` or higher. */
export const tierAtLeast = (tier: PluginTier, min: PluginTier): boolean =>
  rank(tier) >= rank(min);

/** The lower of two tiers. */
export const lowerTier = (a: PluginTier, b: PluginTier): PluginTier =>
  rank(a) <= rank(b) ? a : b;

/** The lowest tier that gets rich features (hosts, streams, jobs, storage). */
export const TRUSTED_TIER: PluginTier = "personal-dev";

/** What a tier may use. A zero turns the feature off. */
export interface PluginTierLimits {
  /** Wall-clock time per tool call, command, or pane message. */
  readonly callMs: number;
  readonly paneMessagesPerMinute: number;
  /** Stream channel bandwidth per pane; 0 means no stream channel. */
  readonly streamBytesPerSecond: number;
  /** `ctx.sql`; 0 means none. */
  readonly storageSqlBytes: number;
  /** `ctx.blobs`; 0 means none. */
  readonly blobBytes: number;
  /** The code modules' total size. */
  readonly codeBytes: number;
  /** Native binaries shipped for the Orb or container host; 0 means none. */
  readonly binaryAssetBytes: number;
  /** Hosts `permissions.network` may list. */
  readonly networkHosts: number;
  /** Background jobs; 0 means none. */
  readonly jobs: number;
  readonly hosts: ReadonlyArray<PluginHostKind>;
}

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const MB = 1_000_000;

const SANDBOXED: PluginTierLimits = {
  callMs: 60_000,
  paneMessagesPerMinute: 60,
  streamBytesPerSecond: 0,
  storageSqlBytes: 0,
  blobBytes: 0,
  codeBytes: 512 * KIB,
  binaryAssetBytes: 0,
  networkHosts: 32,
  jobs: 0,
  hosts: ["worker"],
};

const TRUSTED: PluginTierLimits = {
  callMs: 300_000,
  paneMessagesPerMinute: 600,
  streamBytesPerSecond: 5 * MB,
  storageSqlBytes: GIB,
  blobBytes: 5 * GIB,
  codeBytes: 5 * MIB,
  binaryAssetBytes: 100 * MIB,
  networkHosts: 128,
  jobs: 20,
  hosts: PLUGIN_HOST_KINDS,
};

/**
 * The starting limits per tier (plan §4.6). Deployments change them with
 * config (`PLUGIN_TIER_LIMITS`), not code: pass the configured tier's
 * overrides to {@link pluginTierLimits}.
 */
export const DEFAULT_PLUGIN_TIER_LIMITS: Readonly<
  Record<PluginTier, PluginTierLimits>
> = {
  sandboxed: SANDBOXED,
  "personal-dev": TRUSTED,
  "workspace-trusted": TRUSTED,
  verified: {
    ...TRUSTED,
    streamBytesPerSecond: 10 * MB,
    blobBytes: 20 * GIB,
    jobs: 50,
  },
};

export const pluginTierLimits = (
  tier: PluginTier,
  overrides?: Partial<PluginTierLimits>,
): PluginTierLimits => ({
  ...DEFAULT_PLUGIN_TIER_LIMITS[tier],
  ...overrides,
});
