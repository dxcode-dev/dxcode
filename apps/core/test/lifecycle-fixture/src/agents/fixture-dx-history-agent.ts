"use agent";

import { type AgentProps, useModel, useSandbox } from "@flue/runtime";
import { AGENT_RUN_LIMIT_MS } from "../../../../src/runtime/agent-run-limit.js";
import { screenshotTool } from "../claude-code-history.js";
import { fixtureSandboxFactory } from "../sandbox.js";

/** A dx-mode Thread's agent as far as its history of images goes. */
export function FixtureDxHistoryAgent(_props: AgentProps) {
  useModel("dx-fixture/fixture-dx");
  useSandbox({ ...fixtureSandboxFactory, tools: () => [screenshotTool] });
  return "View the screenshots each message asks for.";
}

FixtureDxHistoryAgent.agentName = "fixture-dx-history-agent";
FixtureDxHistoryAgent.durability = { timeoutMs: AGENT_RUN_LIMIT_MS };
