"use agent";

import { type AgentProps, useModel, useSandbox } from "@flue/runtime";
import { AGENT_RUN_LIMIT_MS } from "../../../../src/runtime/agent-run-limit.js";
import { screenshotTool } from "../claude-code-history.js";
import { fixtureSandboxFactory } from "../sandbox.js";

/** A Claude Code Thread's agent as far as its history goes. */
export function FixtureClaudeCodeAgent(_props: AgentProps) {
  useModel("claude-code/fixture-claude-code");
  useSandbox({ ...fixtureSandboxFactory, tools: () => [screenshotTool] });
  return "Read the screenshot each message asks for.";
}

FixtureClaudeCodeAgent.agentName = "fixture-claude-code-agent";
FixtureClaudeCodeAgent.durability = { timeoutMs: AGENT_RUN_LIMIT_MS };
