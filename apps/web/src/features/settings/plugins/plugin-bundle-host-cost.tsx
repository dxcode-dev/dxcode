import type { PluginBundleData, PluginHostUsageLineData } from "@dx/api";
import { type PluginId, pluginHostKinds } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import type { PluginsTarget } from "../../../shared/api/client.js";
import { PluginBundleGroup } from "./plugin-bundle-group.js";
import { pluginHostUsageQueryOptions } from "./plugin-bundle-queries.js";

const hostName = {
  worker: "Worker",
  durable: "Durable Object",
  orb: "Orb",
  container: "Container",
} as const satisfies Record<PluginHostUsageLineData["host"], string>;

const duration = (ms: number) => {
  if (ms < 60_000) return `${Math.round(ms / 1_000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
};

/** List price to the cent, or "< $0.01" for a little use. */
const hostCost = (microUsd: number) =>
  microUsd === 0
    ? "$0.00"
    : microUsd < 10_000
      ? "< $0.01"
      : `$${(microUsd / 1_000_000).toFixed(2)}`;

const lineDetail = (line: PluginHostUsageLineData) =>
  [
    duration(line.unitsMs),
    `${line.requests.toLocaleString()} ${line.requests === 1 ? "call" : "calls"}`,
    line.blocked > 0 ? `${line.blocked.toLocaleString()} blocked` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

/**
 * The plugin's cost line (decision D4): what its Durable Object, Orb, and
 * container hosts used this month, charged to the installer's workspace.
 * Shown only for plugins with code beyond the Worker; read when the
 * details open.
 */
export function PluginBundleHostCost({
  bundle,
  target,
}: {
  readonly bundle: PluginBundleData;
  readonly target: PluginsTarget;
}) {
  const hosts =
    bundle.code === undefined
      ? []
      : pluginHostKinds(bundle.code).filter((kind) => kind !== "worker");
  const usage = useQuery({
    ...pluginHostUsageQueryOptions(target, bundle.id as PluginId),
    enabled: hosts.length > 0,
  });
  if (hosts.length === 0) return null;
  const lines = usage.data?.lines ?? [];
  const items = hosts.map((host) => {
    const line = lines.find((candidate) => candidate.host === host);
    return {
      key: host,
      name: hostName[host],
      detail: usage.isPending
        ? "Loading…"
        : usage.isError
          ? "Usage unavailable"
          : line === undefined
            ? "Not used this month"
            : lineDetail(line),
      ...(line === undefined
        ? {}
        : { status: hostCost(line.costMicroUsd), tone: "unchanged" as const }),
    };
  });
  return (
    <div className="plugin-bundle-items">
      <PluginBundleGroup
        icon={<Gauge aria-hidden />}
        title="Host usage this month"
        items={items}
      />
    </div>
  );
}
