import { type Api, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { encode as encodePng } from "fast-png";
import { describe, expect, it, vi } from "vitest";
import { imageInfo } from "../../plugins/execution/media/image.js";

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

import { createDxModelRoutingProvider } from "./flue-provider.js";

describe("dx model routing transport", () => {
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
      normalizeContext({
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
      }),
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

  /**
   * Failure modes: an image over the many-image edge stays in a request
   * of more than 20 images, so the provider refuses this turn and every
   * later one, because Flue keeps the image in history; a request of 20
   * or fewer loses an image it could have sent; other images are changed;
   * the agent is not told an image was left out, or which one.
   */
  describe("images in a long conversation", () => {
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const base64Png = (width: number, height: number) =>
      Buffer.from(
        encodePng({
          width,
          height,
          depth: 1,
          channels: 1,
          data: new Uint8Array(Math.ceil(width / 8) * height),
        }),
      ).toString("base64");
    const tall = base64Png(1920, 5190);
    const small = base64Png(1440, 900);

    /** One view_media call per image, as a long browser-checking Thread has. */
    const conversation = (images: ReadonlyArray<string>) =>
      normalizeContext({
        messages: [
          { role: "user", content: "Check the page.", timestamp: 1 },
          ...images.flatMap((data, index) => [
            {
              role: "assistant" as const,
              content: [
                {
                  type: "toolCall" as const,
                  id: `toolu_${index}`,
                  name: "view_media",
                  arguments: { path: `/tmp/shot-${index}.png` },
                },
              ],
              api: "anthropic-messages" as const,
              provider: "anthropic",
              model: "claude-test",
              usage,
              stopReason: "toolUse" as const,
              timestamp: 2,
            },
            {
              role: "toolResult" as const,
              toolCallId: `toolu_${index}`,
              toolName: "view_media",
              content: [
                { type: "text" as const, text: `/tmp/shot-${index}.png: PNG` },
                { type: "image" as const, data, mimeType: "image/png" },
              ],
              isError: false,
              timestamp: 3,
            },
          ]),
        ],
      });

    /** What the provider would receive for this conversation. */
    const send = async (images: ReadonlyArray<string>) => {
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
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 1_000,
      } as Model<Api>;
      for await (const _event of provider.streamSimple(
        model,
        conversation(images),
        {} as never,
      ));
      expect(bodies).toHaveLength(1);
      const sent: Array<{ width: number; height: number }> = [];
      const texts: string[] = [];
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(walk);
          return;
        }
        if (typeof value !== "object" || value === null) return;
        const block = value as Record<string, unknown>;
        if (block.type === "image") {
          const { data } = block.source as { data: string };
          const info = imageInfo(Buffer.from(data, "base64"));
          if (info !== undefined) sent.push(info);
        }
        if (block.type === "text" && typeof block.text === "string")
          texts.push(block.text);
        if (block.type === "tool_result" && typeof block.content === "string")
          texts.push(block.content);
        Object.values(block).forEach(walk);
      };
      walk(bodies[0]);
      return { sent, texts };
    };

    it("leaves out an image over 2000 px once the request holds more than 20", async () => {
      const { sent, texts } = await send([
        ...Array.from({ length: 12 }, () => small),
        tall,
        ...Array.from({ length: 8 }, () => small),
      ]);
      expect(sent).toHaveLength(20);
      expect(
        sent.every(({ width, height }) => width === 1440 && height === 900),
      ).toBe(true);
      expect(texts.filter((text) => text.includes("1920×5190"))).toHaveLength(
        1,
      );
    });

    it("keeps every image while the request holds 20 or fewer", async () => {
      const { sent, texts } = await send([
        ...Array.from({ length: 12 }, () => small),
        tall,
        ...Array.from({ length: 7 }, () => small),
      ]);
      expect(sent).toHaveLength(20);
      expect(sent[12]).toEqual({ format: "png", width: 1920, height: 5190 });
      expect(texts.some((text) => text.includes("1920×5190"))).toBe(false);
    });
  });
});
