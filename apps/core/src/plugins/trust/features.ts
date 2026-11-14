import {
  type PluginBundleCode,
  type PluginTier,
  type PluginTierLimits,
  pluginHostKinds,
  TRUSTED_TIER,
  tierAtLeast,
} from "@dx/domain";

/** A feature the manifest asks for that the granted tier drops. */
export interface BlockedPluginFeature {
  /** Short label for the Plugins page, such as "Orb host". */
  readonly feature: string;
  /** The lowest tier that has it. */
  readonly needs: PluginTier;
}

const HOST_LABELS = {
  worker: "Worker host",
  durable: "Durable Object host",
  orb: "Orb host",
  container: "Container host",
} as const;

const list = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : [];

/**
 * The features a plugin's manifest asks for that its tier doesn't get. dx
 * drops each one rather than refusing the plugin; the Plugins page shows
 * "Needs workspace trust" beside it. Fields other phases add (archived
 * `live`, pane `connect`, jobs, views, `wake`) are read loosely, so this
 * stays right as each lands.
 */
export const blockedPluginFeatures = (
  code: PluginBundleCode,
  tier: PluginTier,
  limits: PluginTierLimits,
): ReadonlyArray<BlockedPluginFeature> => {
  const blocked: Array<BlockedPluginFeature> = [];
  const rich = tierAtLeast(tier, TRUSTED_TIER);
  const add = (feature: string) =>
    blocked.push({ feature, needs: TRUSTED_TIER });
  for (const kind of pluginHostKinds(code))
    if (!limits.hosts.includes(kind)) add(HOST_LABELS[kind]);
  if (code.permissions.network.length > limits.networkHosts)
    add(`More than ${limits.networkHosts} network hosts`);
  const loose = code as unknown as Readonly<Record<string, unknown>>;
  if (!rich) {
    if (loose.archivedThreads === "live") add("Live in archived Threads");
    if (
      list(loose.panes).some(
        (pane) =>
          typeof pane === "object" && pane !== null && "connect" in pane,
      )
    )
      add("Pane network");
    const views = loose.views as Readonly<Record<string, unknown>> | undefined;
    if (
      views !== undefined &&
      (list(views.tabs).length > 0 ||
        list(views.pages).length > 0 ||
        list(views.threadTypes).length > 0)
    )
      add("Tabs, pages, and thread views");
    if (
      (loose.permissions as Readonly<Record<string, unknown>> | undefined)
        ?.wake === true
    )
      add("Waking Threads");
  }
  const jobs = list(loose.jobs).length;
  if (jobs > limits.jobs)
    add(
      limits.jobs === 0 ? "Background jobs" : `More than ${limits.jobs} jobs`,
    );
  return blocked;
};
