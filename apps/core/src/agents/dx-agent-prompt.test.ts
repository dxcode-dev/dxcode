import { describe, expect, it } from "vitest";
import { composeDxAgentPrompt, dxAgentPrompt } from "./dx-agent-prompt.js";

describe("dx agent prompt v1", () => {
  it.each([
    "software development assistant",
    "reading the relevant code",
    "When tools are available, use them",
    "Preserve unrelated user work",
    "Report tool, command, and model failures honestly",
    "Do not perform destructive or shared external actions without explicit authorization",
    "Never expose credentials or secret values",
    "Run relevant validation when practical",
    "remaining limitations accurately",
  ])("contains the required behavior: %s", (requirement) => {
    expect(dxAgentPrompt).toContain(requirement);
  });

  it("directs pull requests to gh and names no unregistered tool", () => {
    expect(dxAgentPrompt).toContain(
      "Use gh to read, create, or update a pull request",
    );
    expect(dxAgentPrompt).not.toContain("pull_request");
  });

  it("is deterministic dx-authored text without volatile interpolation", () => {
    expect(dxAgentPrompt).not.toMatch(
      /Date\(|Date\.now|new Date|Math\.random|randomUUID|requestId|timestamp/i,
    );
  });

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

  it("applies each resolved immutable skill exactly once at the top-level boundary", () => {
    const instruction = "ONE-IMMUTABLE-SKILL-INSTRUCTION";
    const composed = composeDxAgentPrompt("", [
      {
        id: "skl_00000000-0000-4000-8000-000000000044",
        version: 2,
        name: "review-guidelines",
        scope: "workspace",
        integrity: "a".repeat(64),
        description: "Review guidance.",
        instructions: instruction,
        resources: [{ path: "resources/checklist.md" }],
      },
    ]);

    expect(composed.split(instruction)).toHaveLength(2);
    expect(composed).toContain(
      '<skill-instructions id="skl_00000000-0000-4000-8000-000000000044" version="2">',
    );
    expect(composed).toContain("read_dx_skill_resource");
    expect(composed).toContain("resources/checklist.md");
    expect(composed).toContain(
      "do not automatically apply to delegated agents",
    );
  });
});
