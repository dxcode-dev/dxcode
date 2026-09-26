import type { StoredModelConnection } from "@dx/domain";
import { describe, expect, it } from "vitest";
import { connectionModel } from "./submission.js";

const connection = (kind: "custom" | "subscription"): StoredModelConnection =>
  ({
    kind,
    baseUrl: kind === "custom" ? "https://models.example.test/v1" : undefined,
    format: kind === "custom" ? "openai-responses" : undefined,
    fields: {},
  }) as StoredModelConnection;

describe("connectionModel", () => {
  it("describes a Copilot-only model for a subscription", () => {
    expect(
      connectionModel(
        connection("subscription"),
        "github-copilot/mai-code-1-flash-picker",
      ),
    ).toMatchObject({
      id: "mai-code-1-flash-picker",
      provider: "github-copilot",
      api: "openai-responses",
      baseUrl: "https://api.githubcopilot.com",
      reasoning: true,
      input: ["text"],
      contextWindow: 256_000,
      maxTokens: 128_000,
    });
  });

  it("describes a Copilot-only canonical model for a custom endpoint", () => {
    expect(
      connectionModel(
        connection("custom"),
        "github-copilot/mai-code-1-flash-picker",
      ),
    ).toMatchObject({
      id: "mai-code-1-flash-picker",
      provider: "github-copilot",
      api: "openai-responses",
      baseUrl: "https://models.example.test/v1",
      reasoning: true,
      input: ["text"],
      contextWindow: 256_000,
      maxTokens: 128_000,
    });
  });
});
