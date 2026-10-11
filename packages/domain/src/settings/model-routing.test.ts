import { describe, expect, it } from "vitest";
import {
  customModelBaseUrlForFormatChange,
  customModelEndpoint,
  normalizeCustomModelBaseUrl,
} from "./model-routing.js";

describe("custom model endpoints", () => {
  it.each([
    // Anthropic's SDK appends /v1/messages, so a typed /v1 is removed.
    [
      "anthropic-messages",
      "https://llm.example.com",
      "https://llm.example.com",
      "https://llm.example.com/v1/messages",
    ],
    [
      "anthropic-messages",
      "https://llm.example.com/v1",
      "https://llm.example.com",
      "https://llm.example.com/v1/messages",
    ],
    [
      "anthropic-messages",
      "https://llm.example.com/v1/",
      "https://llm.example.com",
      "https://llm.example.com/v1/messages",
    ],
    [
      "anthropic-messages",
      "https://llm.example.com/V1",
      "https://llm.example.com",
      "https://llm.example.com/v1/messages",
    ],
    [
      "anthropic-messages",
      "https://llm.example.com/v1/messages",
      "https://llm.example.com",
      "https://llm.example.com/v1/messages",
    ],
    [
      "anthropic-messages",
      "https://llm.example.com/proxy/anthropic/v1",
      "https://llm.example.com/proxy/anthropic",
      "https://llm.example.com/proxy/anthropic/v1/messages",
    ],
    // The OpenAI SDK adds no version segment, so a typed /v1 is kept.
    [
      "openai-completions",
      "https://llm.example.com/v1",
      "https://llm.example.com/v1",
      "https://llm.example.com/v1/chat/completions",
    ],
    [
      "openai-completions",
      "https://llm.example.com",
      "https://llm.example.com",
      "https://llm.example.com/chat/completions",
    ],
    [
      "openai-completions",
      "https://llm.example.com/v1/chat/completions/",
      "https://llm.example.com/v1",
      "https://llm.example.com/v1/chat/completions",
    ],
    [
      "openai-responses",
      "https://llm.example.com/v1",
      "https://llm.example.com/v1",
      "https://llm.example.com/v1/responses",
    ],
    [
      "openai-responses",
      " https://llm.example.com/v1/responses ",
      "https://llm.example.com/v1",
      "https://llm.example.com/v1/responses",
    ],
  ] as const)("%s %s", (format, input, base, endpoint) => {
    expect(normalizeCustomModelBaseUrl(format, input)).toBe(base);
    expect(customModelEndpoint(format, input)).toBe(endpoint);
    expect(normalizeCustomModelBaseUrl(format, base)).toBe(base);
  });

  it("keeps a proxy path named like another format's endpoint", () => {
    expect(
      customModelEndpoint(
        "openai-completions",
        "https://proxy.example.com/responses",
      ),
    ).toBe("https://proxy.example.com/responses/chat/completions");
  });

  it.each([
    // A full endpoint for the previous format becomes a base for the next.
    [
      "openai-completions",
      "anthropic-messages",
      "https://llm.example.com/v1/chat/completions",
      "https://llm.example.com/v1/messages",
    ],
    [
      "anthropic-messages",
      "openai-completions",
      "https://llm.example.com/v1/messages/",
      "https://llm.example.com/v1/chat/completions",
    ],
    [
      "openai-completions",
      "openai-responses",
      "https://llm.example.com/v1/chat/completions",
      "https://llm.example.com/v1/responses",
    ],
    // Anything else, including proxy paths, is kept as typed.
    [
      "openai-completions",
      "openai-responses",
      "https://proxy.example.com/messages/v1",
      "https://proxy.example.com/messages/v1/responses",
    ],
    [
      "anthropic-messages",
      "openai-completions",
      "https://llm.example.com/v1",
      "https://llm.example.com/v1/chat/completions",
    ],
  ] as const)(
    "format change %s -> %s from %s",
    (previous, next, input, endpoint) => {
      expect(
        customModelEndpoint(
          next,
          customModelBaseUrlForFormatChange(previous, input),
        ),
      ).toBe(endpoint);
    },
  );
});
