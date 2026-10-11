import { describe, expect, it } from "vitest";
import { composeDxAgentPrompt, dxAgentPrompt } from "./dx-agent-prompt.js";

describe("dx agent prompt v1", () => {
  it("composes empty content as the unchanged baseline and nonempty content once", () => {
    expect(composeDxAgentPrompt("")).toBe(dxAgentPrompt);
    const instruction = "ONE-OWNER-INSTRUCTION";
    const composed = composeDxAgentPrompt(instruction);
    expect(composed.startsWith(dxAgentPrompt)).toBe(true);
    expect(composed.split(instruction)).toHaveLength(2);
    expect(composed).toContain("<personal-agent-instructions>");
    expect(composed).toContain(
      "delegated agents, specialized agents, or system tasks",
    );
  });
});
