import type { StoredModelConnection } from "@dx/domain";
import type { Model, Tool } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { describe, expect, it } from "vitest";
import { connectionModel, withEffectiveContextWindow } from "./submission.js";

const connection = (kind: "custom" | "subscription"): StoredModelConnection =>
  ({
    kind,
    baseUrl: kind === "custom" ? "https://models.example.test/v1" : undefined,
    format: kind === "custom" ? "openai-responses" : undefined,
    fields: {},
  }) as StoredModelConnection;

describe("connectionModel", () => {
  it("gives Flue dx's effective window for OpenAI and Anthropic models", () => {
    expect(
      connectionModel(connection("subscription"), "openai/gpt-5.6-sol"),
    ).toMatchObject({ contextWindow: 270_000 });
    expect(
      connectionModel(connection("custom"), "anthropic/claude-opus-5"),
    ).toMatchObject({ contextWindow: 872_000 });
    const pinned = {
      ...connectionModel(connection("subscription"), "openai/gpt-5.6-sol"),
      contextWindow: 1_050_000,
    };
    expect(withEffectiveContextWindow(pinned).contextWindow).toBe(270_000);
  });

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

  it("normalizes an Anthropic base saved with the SDK's own /v1", () => {
    expect(
      connectionModel(
        {
          kind: "custom",
          baseUrl: "https://ai.example.test/v1",
          format: "anthropic-messages",
          fields: {},
        } as StoredModelConnection,
        "anthropic/claude-sonnet-4-5",
      ),
    ).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://ai.example.test",
    });
  });

  // A custom URL (LiteLLM, Copilot-backed gateways) speaks standard Messages
  // only; first-party betas made every dxcode.dev call fail with
  // `messages.N.output_config: Extra inputs are not permitted`.
  it("sends only the standard Anthropic request to a custom endpoint", async () => {
    const model = connectionModel(
      {
        kind: "custom",
        baseUrl: "https://ai.example.test/v1",
        format: "anthropic-messages",
        fields: {},
      } as StoredModelConnection,
      "anthropic/claude-opus-5",
    );
    const sent: { url: string; headers: Headers; body: AnthropicBody }[] = [];
    const now = Date.now();
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const events = streamSimple(
      model as Model<"anthropic-messages">,
      {
        systemPrompt: "Be terse.",
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            } as unknown as Tool["parameters"],
          },
        ],
        messages: [
          { role: "user", content: "Read README.md", timestamp: now },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "toolu_01",
                name: "read",
                arguments: { path: "README.md" },
              },
            ],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "claude-opus-5",
            providerThinkingLevel: "medium",
            usage,
            stopReason: "toolUse",
            timestamp: now,
          },
          {
            role: "toolResult",
            toolCallId: "toolu_01",
            toolName: "read",
            content: [{ type: "text", text: "# dx" }],
            isError: false,
            timestamp: now,
          },
          { role: "user", content: "Summarize.", timestamp: now },
        ],
      },
      {
        apiKey: "test-key",
        reasoning: "medium",
        maxRetries: 0,
        fetch: async (url, init) => {
          sent.push({
            url: String(url),
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body)),
          });
          return new Response("{}", { status: 500 });
        },
      },
    );
    for await (const _event of events);

    expect(sent).toHaveLength(1);
    const [{ url, headers, body }] = sent;
    expect(new URL(url).pathname).toBe("/v1/messages");
    expect(headers.get("anthropic-beta")).toBeNull();
    expect(body.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "user",
    ]);
    expect(JSON.stringify(body.messages)).not.toContain("output_config");
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.temperature).toBeUndefined();
  });
});

interface AnthropicBody {
  readonly messages: ReadonlyArray<{ readonly role: string }>;
  readonly thinking?: unknown;
  readonly output_config?: unknown;
  readonly temperature?: unknown;
}
