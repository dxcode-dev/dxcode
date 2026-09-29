import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

const adapter = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock("@earendil-works/pi-ai/api/openai-completions", () => ({
  stream: vi.fn(),
  streamSimple: vi.fn(async function* (
    _model: unknown,
    _context: unknown,
    options: unknown,
  ) {
    adapter.options.push(options);
    yield* [];
  }),
}));

import { AGENT_RUN_LIMIT_MS } from "../../runtime/agent-run-limit.js";
import { createDxModelRoutingProvider } from "./flue-provider.js";

describe("dx model routing transport", () => {
  it("lets Flue's run deadline, not SDK defaults, bound wire model calls", async () => {
    const { provider } = createDxModelRoutingProvider("openai", {
      namespace: {} as DurableObjectNamespace,
      identity: () => ({ name: "thr_test" }) as never,
      invocation: () => undefined,
    });
    const model = {
      id: "gpt-test",
      provider: "openai",
      api: "openai-completions",
      baseUrl: "https://api.example.test/v1",
    } as Model<Api>;

    for await (const _event of provider.streamSimple(
      model,
      { messages: [] } as never,
      { maxRetries: 3, timeoutMs: 1_000 } as never,
    ));

    expect(adapter.options).toEqual([
      expect.objectContaining({
        maxRetries: 0,
        timeoutMs: AGENT_RUN_LIMIT_MS,
      }),
    ]);
    expect(AGENT_RUN_LIMIT_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("never sends a failed tool result without text to the provider", async () => {
    const bodies: unknown[] = [];
    const { provider } = createDxModelRoutingProvider("anthropic", {
      namespace: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(await new Response(init.body).text()));
            return Response.json(
              { type: "error", error: { type: "invalid_request_error" } },
              { status: 400 },
            );
          },
        }),
      } as never,
      identity: () => ({ name: "thr_test" }) as never,
      invocation: () => undefined,
    });
    const model = {
      id: "claude-test",
      name: "claude-test",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 1_000,
    } as Model<Api>;
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    for await (const _event of provider.streamSimple(
      model,
      {
        messages: [
          { role: "user", content: "Open a pull request.", timestamp: 1 },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "toolu_1",
                name: "pull_request",
                arguments: {},
              },
            ],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "claude-test",
            usage,
            stopReason: "toolUse",
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "toolu_1",
            toolName: "pull_request",
            content: [{ type: "text", text: "" }],
            isError: true,
            timestamp: 3,
          },
        ],
      },
      {} as never,
    ));

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      messages: [
        { role: "user" },
        { role: "assistant" },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              is_error: true,
              content: "Tool pull_request failed without an error message.",
            },
          ],
        },
      ],
    });
  });
});
