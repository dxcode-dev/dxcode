import { createModels } from "@earendil-works/pi-ai";
import type { CloudflareAIBinding } from "@flue/runtime/cloudflare/workers-ai";
import {
  resetModelsForTests,
  resolveModel,
  setProvider,
} from "@flue/runtime/internal";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDxCloudflareModelProvider,
  GLM_5_3_FLASH_MODEL_ID,
} from "./cloudflare-model-provider.js";

const modelId = GLM_5_3_FLASH_MODEL_ID;

describe("Flue Cloudflare binding provider", () => {
  afterEach(() => resetModelsForTests());

  it("resolves reviewed metadata and dispatches its exact id without network", async () => {
    const run = vi.fn<CloudflareAIBinding["run"]>(
      async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const provider = createDxCloudflareModelProvider({ run });
    setProvider(provider);
    const models = createModels();
    models.setProvider(provider);

    const resolved = resolveModel(`cloudflare/${modelId}`);
    expect(resolved).toMatchObject({
      id: modelId,
      provider: "cloudflare",
      api: "cloudflare-ai-binding",
      contextWindow: 1_048_576,
      maxTokens: 0,
      reasoning: true,
      input: ["text", "image"],
    });
    expect(resolveModel("cloudflare/@cf/future-model")).toMatchObject({
      id: "@cf/future-model",
      provider: "cloudflare",
      api: "cloudflare-ai-binding",
    });
    const model = models.getModel("cloudflare", modelId);
    expect(model).toBe(resolved);
    if (model === undefined) throw new Error("Registered model is missing.");

    const events = [];
    for await (const event of models.streamSimple(
      model,
      { messages: [{ role: "user", content: "synthetic", timestamp: 0 }] },
      { reasoning: "high" },
    )) {
      events.push(event);
    }

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenNthCalledWith(
      1,
      modelId,
      expect.objectContaining({
        stream: true,
        stream_options: { include_usage: true },
        reasoning_effort: "high",
      }),
      expect.objectContaining({ returnRawResponse: true }),
    );
    const payload = run.mock.calls[0]?.[1];
    expect(payload).not.toHaveProperty("max_completion_tokens");
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });

    for await (const _event of models.streamSimple(
      model,
      { messages: [{ role: "user", content: "synthetic", timestamp: 0 }] },
      { maxTokens: 64 },
    )) {
      // Consuming the stream executes Pi's lazy provider dispatch.
    }
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(
      2,
      modelId,
      expect.objectContaining({
        stream: true,
        max_completion_tokens: 64,
      }),
      expect.objectContaining({ returnRawResponse: true }),
    );
  });
});
