import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  MAX_PERSONAL_AGENT_INSTRUCTIONS_LENGTH,
  normalizePersonalAgentInstructions,
  PersonalAgentInstructionsContent,
  PersonalAgentInstructionsRevision,
  PersonalAgentInstructionsSnapshot,
} from "./personal-agent-instructions.js";

describe("personal agent instructions domain", () => {
  it("normalizes line endings without changing authored whitespace", () => {
    expect(normalizePersonalAgentInstructions("  first\r\nsecond\r  ")).toBe(
      "  first\nsecond\n  ",
    );
  });

  it("accepts empty and maximum-size content and rejects oversized content", () => {
    for (const content of [
      "",
      "x".repeat(MAX_PERSONAL_AGENT_INSTRUCTIONS_LENGTH),
    ]) {
      expect(
        Option.isSome(
          Schema.decodeUnknownOption(PersonalAgentInstructionsContent)(content),
        ),
      ).toBe(true);
    }
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(PersonalAgentInstructionsContent)(
          "x".repeat(MAX_PERSONAL_AGENT_INSTRUCTIONS_LENGTH + 1),
        ),
      ),
    ).toBe(true);
  });

  it("requires non-negative safe integer revisions and format version 1", () => {
    expect(
      Schema.decodeUnknownSync(PersonalAgentInstructionsSnapshot)({
        content: "Use deterministic tests.",
        revision: 7,
        version: 1,
      }),
    ).toMatchObject({ revision: 7, version: 1 });
    for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        Option.isNone(
          Schema.decodeUnknownOption(PersonalAgentInstructionsRevision)(
            revision,
          ),
        ),
      ).toBe(true);
    }
    expect(() =>
      Schema.decodeUnknownSync(PersonalAgentInstructionsSnapshot)({
        content: "",
        revision: 0,
        version: 2,
      }),
    ).toThrow();
  });
});
