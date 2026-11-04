import { env, waitUntil } from "cloudflare:workers";
import { Effect } from "effect";
import { mayUseBugReportTools } from "../bug-reports/agent-tools.js";
import type { Bindings } from "../http/types.js";
import { resolveMcpAgentConnections } from "../settings/mcp-servers/execution.js";
import { loadThreadWorkspaceAgentInstructions } from "../settings/workspace-agent-instructions/thread.js";
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

/**
 * Whether this submission's Thread gets the bug report tools: its owner is
 * one of the deployment's report readers. A failed read mounts none.
 */
export const resolveAgentBugReportReader = async (threadId: string) => {
  try {
    return await mayUseBugReportTools(agentPluginHostContext(), threadId);
  } catch {
    return false;
  }
};

/**
 * The workspace's AGENTS.md for this submission, read from current settings
 * so an admin's change reaches the next message in every member's Thread.
 * Async, so a missing binding rejects with the other reads instead of
 * throwing while they are already in flight.
 */
export const resolveAgentWorkspaceInstructions = async (threadId: string) =>
  loadThreadWorkspaceAgentInstructions(agentPluginHostContext().db, threadId);
