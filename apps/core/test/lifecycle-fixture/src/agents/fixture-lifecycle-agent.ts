"use agent";

import {
  type AgentProps,
  defineTool,
  useInitialData,
  useModel,
  useSandbox,
  useTool,
} from "@flue/runtime";
import * as v from "valibot";
import {
  type DxAgentInitialData,
  DxAgentInitialDataSchema,
} from "../../../../src/agents/dx-agent-initial-data.js";
import { AGENT_RUN_LIMIT_MS } from "../../../../src/runtime/agent-run-limit.js";
import { fixtureText } from "../heavy-history.js";
import { fixtureSandboxFactory } from "../sandbox.js";

/** An untruncated text output, as an MCP server or a web fetch returns. */
const fixtureFetch = defineTool({
  name: "fixture_fetch",
  description: "Fetch a deterministic document of the requested size.",
  input: v.object({ bytes: v.number(), seed: v.number() }),
  run: async ({ data }) => ({ output: fixtureText(data.bytes, data.seed) }),
});

export function FixtureLifecycleAgent(_props: AgentProps) {
  useModel("faux/faux-1");
  useSandbox(fixtureSandboxFactory);
  useTool(fixtureFetch);
  const initialData = useInitialData<DxAgentInitialData>();
  return `Follow the scripted lifecycle and use the requested workspace tools.\n\n${initialData.personalInstructions}`;
}

FixtureLifecycleAgent.agentName = "fixture-lifecycle-agent";
// dx's run limit, which the unready deadline must not inherit.
FixtureLifecycleAgent.durability = { timeoutMs: AGENT_RUN_LIMIT_MS };
FixtureLifecycleAgent.initialData = DxAgentInitialDataSchema;
