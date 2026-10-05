import { env } from "cloudflare:workers";
import type { Bindings } from "../http/types.js";
import type { PluginHostContext } from "./host.js";
import { resolveSubmissionPluginTools } from "./submission-tools.js";

/** The Worker bindings first-party plugin tools resolve against at call time. */
export const agentPluginHostContext = (): PluginHostContext => {
  const bindings = env as Bindings;
  if (bindings.DB === undefined)
    throw new Error("Plugin host requires the D1 binding.");
  return { db: bindings.DB, bindings };
};

/** The plugin tool set for one agent submission, recorded with it. */
export const resolveAgentPluginTools = async (
  threadId: string,
  submissionId: string,
) => ({
  submissionId,
  tools: await resolveSubmissionPluginTools(
    agentPluginHostContext(),
    threadId,
    submissionId,
  ),
});
