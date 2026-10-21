import { describe, expect, it } from "vitest";
import {
  COPILOT_SERVED_MODELS,
  copilotCanonicalFor,
  copilotModelForCanonical,
  copilotUpstreamFor,
} from "./copilot-mapping.js";

describe("copilot canonical mapping", () => {
  it("normalizes claude dot versions to anthropic dash ids", () => {
    expect(copilotUpstreamFor("anthropic/claude-fable-5-1")).toBe(
      "claude-fable-5.1",
    );
    expect(copilotUpstreamFor("anthropic/claude-opus-4-5")).toBe(
      "claude-opus-4.5",
    );
    expect(copilotUpstreamFor("anthropic/claude-fable-5")).toBe(
      "claude-fable-5",
    );
  });

  it("keeps copilot-only ids under github-copilot", () => {
    expect(copilotUpstreamFor("github-copilot/mai-code-1-flash-picker")).toBe(
      "mai-code-1-flash-picker",
    );
  });

  it("serves pi's Copilot models with their thinking traits", () => {
    const opus = copilotModelForCanonical("anthropic/claude-opus-5-5");
    expect(opus?.upstream).toBe("claude-opus-5.5");
    expect(opus?.compatibility).toEqual({
      forceAdaptiveThinking: true,
      supportsTemperature: false,
    });
    expect(copilotUpstreamFor("openai/gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(copilotUpstreamFor("openai/gpt-4.1")).toBe("gpt-4.1");
  });

  it("round-trips canonical lookups", () => {
    for (const model of COPILOT_SERVED_MODELS.values()) {
      expect(copilotCanonicalFor(model.upstream)).toBe(model.canonical);
      expect(copilotModelForCanonical(model.canonical)?.upstream).toBe(
        model.upstream,
      );
    }
  });
});
