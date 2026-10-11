import { describe, expect, it } from "vitest";
import { normalizePersonalAgentInstructions } from "./personal-agent-instructions.js";

describe("personal agent instructions domain", () => {
  it("normalizes line endings without changing authored whitespace", () => {
    expect(normalizePersonalAgentInstructions("  first\r\nsecond\r  ")).toBe(
      "  first\nsecond\n  ",
    );
  });
});
