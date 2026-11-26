import type { PluginBundleData } from "@dx/api";
import { plural } from "./plugin-bundle-presentation.js";

/** What removing a bundle also removes, for the confirmation. */
export const removalSummary = (bundle: PluginBundleData) =>
  [
    bundle.skills.length > 0
      ? plural(bundle.skills.length, "skill", "skills")
      : undefined,
    bundle.mcpServers.length + bundle.localMcpServers.length > 0
      ? plural(
          bundle.mcpServers.length + bundle.localMcpServers.length,
          "MCP server",
          "MCP servers",
        )
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" and ");
