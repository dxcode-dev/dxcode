"use agent";

import {
  type AgentProps,
  useInitialData,
  useModel,
  useSandbox,
} from "@flue/runtime";
import {
  type DxAgentInitialData,
  DxAgentInitialDataSchema,
} from "../../../../src/agents/dx-agent-initial-data.js";
import { fixtureSandboxFactory } from "../sandbox.js";

export function FixtureLifecycleAgent(_props: AgentProps) {
  useModel("faux/faux-1");
  useSandbox(fixtureSandboxFactory);
  const initialData = useInitialData<DxAgentInitialData>();
  return `Follow the scripted lifecycle and use the requested workspace tools.\n\n${initialData.personalInstructions}`;
}

FixtureLifecycleAgent.agentName = "fixture-lifecycle-agent";
FixtureLifecycleAgent.initialData = DxAgentInitialDataSchema;
