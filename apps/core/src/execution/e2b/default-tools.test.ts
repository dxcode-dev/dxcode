import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { type AgentProps, init, useModel, useSandbox } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import type { Sandbox as E2BSandbox } from "e2b";
import { expect, it, vi } from "vitest";
import { e2b } from "./adapter.js";

it("exposes only DX's four coding tools to the model", async () => {
  const provider = fauxProvider();
  let toolNames: string[] = [];
  provider.setResponses([
    (context) => {
      toolNames = context.tools?.map((tool) => tool.name) ?? [];
      return fauxAssistantMessage("done");
    },
  ]);
  const sandbox = {
    files: {
      read: vi.fn(),
      write: vi.fn(),
      getInfo: vi.fn(),
      list: vi.fn(),
      exists: vi.fn(),
      makeDir: vi.fn(),
      remove: vi.fn(),
    },
    commands: {
      run: vi.fn(async () => ({
        // An empty workspace: no records, then the end marker.
        stdout: btoa("E\0"),
        stderr: "",
        exitCode: 0,
      })),
    },
  } as unknown as E2BSandbox;
  const factory = e2b(sandbox);
  expect(factory).toHaveProperty("tools");

  function HarnessAgent(_props: AgentProps) {
    useModel("faux/faux-1");
    useSandbox(factory);
    return "Use the workspace tools when needed.";
  }
  HarnessAgent.agentName = "e2b-default-tools-test";

  await using _runtime = await start({
    agents: [HarnessAgent],
    providers: [provider.provider],
  });
  const handle = init(HarnessAgent, { id: "default-tools" });
  const receipt = await handle.dispatch("Inspect the workspace.");

  await expect(handle.read(receipt)).resolves.toMatchObject({ text: "done" });
  expect(toolNames).toEqual(["read", "write", "edit", "bash"]);
});
