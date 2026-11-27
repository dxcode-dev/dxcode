import type { PluginBundleData } from "@dx/api";
import type { PluginId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { PackageBrowserSection } from "../../../shared/ui/package-browser.js";
import { pluginHostUsageQueryOptions } from "./plugin-bundle-queries.js";
import type { PluginsTarget } from "./plugins-queries.js";

/** Money to the cent, or "under $0.01" for a little use. */
const money = (microUsd: number) =>
  microUsd === 0
    ? "$0.00"
    : microUsd < 10_000
      ? "under $0.01"
      : `$${(microUsd / 1_000_000).toFixed(2)}`;

/**
 * What a plugin with code did this month: its calls and what they cost, as
 * money. Read when the plugin is chosen, never with the list. A plugin of
 * only skills and MCP servers runs inside Threads and has nothing here.
 */
export function PluginActivity({
  bundle,
  target,
}: {
  readonly bundle: PluginBundleData;
  readonly target: PluginsTarget;
}) {
  const code = bundle.code;
  const usage = useQuery({
    ...pluginHostUsageQueryOptions(target, bundle.id as PluginId),
    enabled: code !== undefined,
  });
  if (code === undefined) return null;
  const lines = usage.data?.lines ?? [];
  const calls = lines.reduce((sum, line) => sum + line.requests, 0);
  const cost = lines.reduce((sum, line) => sum + line.costMicroUsd, 0);
  return (
    <PackageBrowserSection title="This month">
      <dl className="plugin-activity">
        <dt>Cost</dt>
        <dd>
          {usage.isPending
            ? "Loading…"
            : usage.isError
              ? "Not available"
              : money(cost)}
        </dd>
        {usage.isSuccess && calls > 0 ? (
          <>
            <dt>Calls</dt>
            <dd>{calls.toLocaleString()}</dd>
          </>
        ) : null}
      </dl>
    </PackageBrowserSection>
  );
}
