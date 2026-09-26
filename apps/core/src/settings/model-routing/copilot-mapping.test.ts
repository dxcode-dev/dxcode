import { describe, expect, it } from "vitest";
import {
  COPILOT_SERVED_MODELS,
  copilotCanonicalFor,
  copilotModelForCanonical,
  copilotUpstreamFor,
} from "./copilot-mapping.js";

describe("copilot canonical mapping", () => {
  it("maps gpt models to openai canonicals", () => {
    expect(copilotUpstreamFor("openai/gpt-6-astra")).toBe("gpt-6-astra");
    expect(copilotUpstreamFor("openai/gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

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

  it("maps gemini and kimi ids to their vendor catalogs", () => {
    expect(copilotUpstreamFor("google/gemini-3.5-flash")).toBe(
      "gemini-3.5-flash",
    );
    expect(copilotUpstreamFor("moonshotai/kimi-k2.7-code")).toBe(
      "kimi-k2.7-code",
    );
  });

  it("keeps copilot-only ids under github-copilot", () => {
    expect(copilotUpstreamFor("github-copilot/mai-code-1-flash-picker")).toBe(
      "mai-code-1-flash-picker",
    );
  });

  it("never duplicates canonicals", () => {
    const canonicals = [...COPILOT_SERVED_MODELS.keys()];
    expect(new Set(canonicals).size).toBe(canonicals.length);
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
