import type { PluginBundleData, PluginBundlePreviewData } from "@dx/api";
import type {
  PluginBundleAction,
  PluginBundleUpload,
} from "./plugin-bundle-mutations.js";

export type BundleRun = (
  action: PluginBundleAction,
  success: string,
) => Promise<boolean>;

export type BundlePreview = (
  upload: PluginBundleUpload,
) => Promise<PluginBundlePreviewData>;

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

export const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

export const sourceLabel = (source: PluginBundleData["source"]) =>
  source.type !== "github"
    ? source.label
    : `${source.catalog === undefined ? "" : `${source.catalog.name} catalog · `}${source.repository}${source.path === "" ? "" : `/${source.path}`} @ ${source.commit.slice(0, 7)}`;

/**
 * The hint beside a plugin's source: only when it cannot work as shown.
 * Tiers are gone: what is left is a copy paused by the workspace's, tools
 * waiting for approval, and a plugin a workspace admin turned off.
 */
export const bundleHint = (bundle: PluginBundleData, canMutate: boolean) => {
  if (bundle.overlap?.kind === "paused") {
    return `Paused: ${bundle.overlap.workspaceName} provides it`;
  }
  if (bundle.enabled && bundle.mcpServers.some(({ reviewed }) => !reviewed)) {
    return "Review MCP tools";
  }
  if (!bundle.enabled && bundle.scope === "workspace" && !canMutate) {
    return "Your workspace admin turned this off";
  }
  return bundle.overlap?.kind === "replacing"
    ? `Used instead of ${bundle.overlap.workspaceName}'s copy`
    : undefined;
};
