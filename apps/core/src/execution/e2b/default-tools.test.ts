import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type AgentProps,
  defineTool,
  init,
  useModel,
  useSandbox,
  useTool,
} from "@flue/runtime";
import { start } from "@flue/runtime/node";
import type { Sandbox as E2BSandbox } from "e2b";
import * as v from "valibot";
import { expect, it, vi } from "vitest";
import { e2b } from "./adapter.js";

const pullRequest = defineTool({
  name: "pull_request",
  description: "Provider-authorized pull request operation.",
  input: v.object({}),
  async run() {
    return { output: {} };
  },
});

it("exposes only DX's four coding tools and pull_request to the model", async () => {
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
        stdout: JSON.stringify({
          kind: "snapshot",
          version: 1,
          snapshot: {
            instructionFiles: {},
            skillFiles: [],
            directoryListing: [],
          },
        }),
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
    useTool(pullRequest);
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
  expect(toolNames).toEqual(["read", "write", "edit", "bash", "pull_request"]);
});
