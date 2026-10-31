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
  source.type === "zip"
    ? source.label
    : `${source.repository}${source.path === "" ? "" : `/${source.path}`} @ ${source.commit.slice(0, 7)}`;

/** The row hint: only when the plugin cannot fully work as shown. */
export const bundleHint = (bundle: PluginBundleData) =>
  bundle.enabled && bundle.mcpServers.some(({ reviewed }) => !reviewed)
    ? "Review MCP tools"
    : undefined;
