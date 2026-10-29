import { env, waitUntil } from "cloudflare:workers";
import { Effect } from "effect";
import type { Bindings } from "../http/types.js";
import { resolveMcpAgentConnections } from "../settings/mcp-servers/execution.js";
import type { PluginHostContext } from "./host.js";
import { resolveSubmissionPluginTools } from "./submission-tools.js";

/** The Worker bindings first-party plugin tools resolve against at call time. */
export const agentPluginHostContext = (): PluginHostContext => {
  const bindings = env as Bindings;
  if (bindings.DB === undefined)
    throw new Error("Plugin host requires the D1 binding.");
  return { db: bindings.DB, bindings };
};

/**
 * What the Thread tools resolve against: the plugin host context, plus the
 * runtime's `waitUntil` for work a route starts and finishes later.
 */
export const agentThreadToolsContext = () => ({
  ...agentPluginHostContext(),
  waitUntil,
});

/**
 * The plugin tool set for one agent submission, recorded with it, and the
 * MCP servers Code offers in it. Both come from current settings, never from
 * the agent's creation data, so a server connected or signed in to after the
 * Thread started reaches its next submission.
 */
export const resolveAgentPluginTools = async (
  threadId: string,
  submissionId: string,
) => {
  const context = agentPluginHostContext();
  const [tools, mcpConnections] = await Promise.all([
    resolveSubmissionPluginTools(context, threadId, submissionId),
    Effect.runPromise(resolveMcpAgentConnections(context.db, threadId)),
  ]);
  return { submissionId, tools, mcpConnections };
};
