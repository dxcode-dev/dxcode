import {
  type AgentProps,
  type FlueObservation,
  init,
  observe,
  useModel,
} from "@flue/runtime";
import { start } from "@flue/runtime/node";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { afterAll, beforeAll, expect, it } from "vitest";

const provider = fauxProvider();
const observations: FlueObservation[] = [];

function FirstOutputAgent(_props: AgentProps) {
  useModel("faux/faux-1");
  return "Respond normally.";
}
FirstOutputAgent.agentName = "first-output-test";

let runtime: Awaited<ReturnType<typeof start>>;

beforeAll(async () => {
  observe((event) => {
    observations.push(event);
  });
  runtime = await start({
    agents: [FirstOutputAgent],
    providers: [provider.provider],
  });
});

afterAll(async () => {
  await runtime[Symbol.asyncDispose]();
});

it("observes the first meaningful thinking, text, or tool-call delta once without content", async () => {
  provider.setResponses([
    fauxAssistantMessage([
      fauxThinking("private reasoning"),
      fauxText("private answer"),
    ]),
  ]);
  const handle = init(FirstOutputAgent, { id: "first-output" });
  const receipt = await handle.dispatch("private prompt");
  await handle.read(receipt);

  const firstOutput = observations.filter(
    (event) => event.type === "turn_first_output",
  );
  expect(firstOutput).toHaveLength(1);
  expect(firstOutput[0]).toMatchObject({
    type: "turn_first_output",
    instanceId: "first-output",
    submissionId: receipt.submissionId,
    purpose: "agent",
    outputKind: "thinking",
    durationMs: expect.any(Number),
  });
  expect(JSON.stringify(firstOutput)).not.toContain("private");

  const types = observations.map((event) => event.type);
  expect(types.indexOf("turn_request")).toBeLessThan(
    types.indexOf("turn_first_output"),
  );
  expect(types.indexOf("turn_first_output")).toBeLessThan(
    types.indexOf("turn"),
  );
});

it.each([
  {
    id: "first-text-output",
    outputKind: "text",
    responses: [fauxAssistantMessage([fauxText("private answer")])],
  },
  {
    id: "first-tool-output",
    outputKind: "tool-call",
    responses: [
      fauxAssistantMessage(
        [fauxToolCall("task", { agent: "missing", prompt: "private task" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ],
  },
])(
  "classifies the first $outputKind delta",
  async ({ id, outputKind, responses }) => {
    observations.length = 0;
    provider.setResponses(responses);
    const handle = init(FirstOutputAgent, { id });
    const receipt = await handle.dispatch("private prompt");
    await handle.read(receipt);

    const firstOutputs = observations.filter(
      (event) => event.type === "turn_first_output",
    );
    expect(firstOutputs[0]).toEqual(
      expect.objectContaining({
        type: "turn_first_output",
        instanceId: id,
        outputKind,
      }),
    );
    expect(new Set(firstOutputs.map((event) => event.turnId)).size).toBe(
      firstOutputs.length,
    );
  },
);

it("does not await a first-output observation subscriber", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const unsubscribe = observe((event) => {
    if (
      event.type === "turn_first_output" &&
      event.instanceId === "nonblocking-first-output"
    )
      return blocked;
  });
  try {
    provider.setResponses([fauxAssistantMessage("done")]);
    const handle = init(FirstOutputAgent, { id: "nonblocking-first-output" });
    const receipt = await handle.dispatch("respond");

    await expect(
      Promise.race([
        handle.read(receipt),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("observation blocked the turn")),
            250,
          ),
        ),
      ]),
    ).resolves.toBeDefined();
  } finally {
    release();
    unsubscribe();
  }
});
