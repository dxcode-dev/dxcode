import { describe, expect, it } from "vitest";
import { parseCustomModels } from "./custom-models-parser.js";

describe("parseCustomModels", () => {
  it("parses plain canonical lines", () => {
    const { models, errors } = parseCustomModels(
      "openai/gpt-6-astra\nanthropic/claude-fable-5-1",
    );
    expect(errors).toEqual([]);
    expect(models).toEqual([
      { canonical: "openai/gpt-6-astra" },
      { canonical: "anthropic/claude-fable-5-1" },
    ]);
  });

  it("parses upstream renames", () => {
    const { models, errors } = parseCustomModels(
      "anthropic/claude-fable-5-1 -> claude-fable-5.1-litellm",
    );
    expect(errors).toEqual([]);
    expect(models).toEqual([
      {
        canonical: "anthropic/claude-fable-5-1",
        upstream: "claude-fable-5.1-litellm",
      },
    ]);
  });

  it("rejects extra upstream separators", () => {
    const { models, errors } = parseCustomModels(
      "openai/gpt-6-astra -> astra -> ignored",
    );
    expect(models).toEqual([]);
    expect(errors).toEqual([
      { line: 1, message: "Expected at most one `->` separator." },
    ]);
  });

  it("rejects unknown canonical ids with line numbers", () => {
    const { models, errors } = parseCustomModels(
      "openai/gpt-6-astra\nopenai/not-a-model\n# comment\n\nanthropic/claude-fable-5-1",
    );
    expect(models).toEqual([
      { canonical: "openai/gpt-6-astra" },
      { canonical: "anthropic/claude-fable-5-1" },
    ]);
    expect(errors).toEqual([
      { line: 2, message: expect.stringContaining("openai/not-a-model") },
    ]);
  });

  it("rejects duplicates with the original line", () => {
    const { models, errors } = parseCustomModels(
      "openai/gpt-6-astra\nopenai/gpt-6-astra",
    );
    expect(models).toEqual([{ canonical: "openai/gpt-6-astra" }]);
    expect(errors).toEqual([
      { line: 2, message: expect.stringContaining("1") },
    ]);
  });

  it("rejects malformed ids", () => {
    const { errors } = parseCustomModels("not-a-canonical");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(1);
  });
});
