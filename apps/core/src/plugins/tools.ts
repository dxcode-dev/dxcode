import type { PluginToolSet } from "@dx/domain";
import type { ToolDefinition } from "@flue/runtime";
import type { McpAgentConnectionData } from "../settings/mcp-servers/execution.js";
import { createCodeTools } from "./code/tools.js";
import type { PluginHostContext, PluginSubmission } from "./host.js";
import { createWebTools, webCapabilityInvoker } from "./web/tools.js";

/**
 * Agent tools contributed by first-party plugins for one submission's
 * resolved tool set. Agents mount this list; none reaches into a plugin
 * module directly. The host context is read only when a tool runs, and every
 * call resolves the current provider and credential.
 */
export const firstPartyPluginTools = (
  submission: PluginSubmission,
  toolSet: PluginToolSet,
  getContext: () => PluginHostContext,
  connections: ReadonlyArray<McpAgentConnectionData> = [],
): ToolDefinition[] =>
  toolSet.flatMap<ToolDefinition>((threadPlugin) =>
    threadPlugin.pluginId === "search"
      ? createWebTools(
          threadPlugin.capabilities,
          webCapabilityInvoker(getContext, submission, threadPlugin),
        )
      : threadPlugin.pluginId === "code"
        ? createCodeTools(connections, submission, threadPlugin, getContext)
        : [],
  );
