import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_CONTEXT_WINDOW,
  effectiveContextWindow,
  OPENAI_CONTEXT_WINDOW,
} from "./context-window.js";

describe("effective context window", () => {
  it.each([
    ["openai/gpt-5.6-sol", 1_050_000, OPENAI_CONTEXT_WINDOW],
    ["github-copilot/gpt-5.2-codex", 400_000, OPENAI_CONTEXT_WINDOW],
    ["azure-openai-responses/gpt-4.1", 1_047_576, OPENAI_CONTEXT_WINDOW],
    ["openrouter/openai/o3", 200_000, 200_000],
    [
      "amazon-bedrock/global.openai.gpt-5.6-sol",
      1_050_000,
      OPENAI_CONTEXT_WINDOW,
    ],
    ["anthropic/claude-opus-4-8", 1_000_000, ANTHROPIC_CONTEXT_WINDOW],
    [
      "amazon-bedrock/anthropic.claude-fable-5",
      1_000_000,
      ANTHROPIC_CONTEXT_WINDOW,
    ],
    ["github-copilot/claude-sonnet-4", 1_000_000, ANTHROPIC_CONTEXT_WINDOW],
    ["anthropic/claude-haiku-4-5", 200_000, 200_000],
    ["google/gemini-3.8-flash", 1_048_576, 1_048_576],
    ["xai/grok-4.6", 2_000_000, 2_000_000],
    ["cloudflare/@cf/zai-org/glm-5.3-flash", 1_048_576, 1_048_576],
  ])("%s: %i → %i", (canonical, native, expected) => {
    expect(effectiveContextWindow(canonical, native)).toBe(expected);
  });
});
