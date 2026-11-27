import {
  type Api,
  type AssistantMessageEvent,
  isContextOverflow,
  type Model,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { classifyRunFailure } from "../../runtime/run-failure.js";
import { createDxModelRoutingProvider } from "./flue-provider.js";
import { classifyUpstreamRejection } from "./upstream-rejection.js";

/**
 * A provider that caps its request body in bytes (thr_703635f3). Ways it fails:
 * - a 413 is final, so the turn fails and every retry and later turn sends
 *   the same history and fails again (the stuck Thread);
 * - one provider's spelling of "too large" goes unrecognized;
 * - recovery drops the newest image, which the agent is looking at, or
 *   drops images silently, so the agent cannot tell what is missing;
 * - every later call is refused once before it fits;
 * - a request too large without images never reaches Flue's compaction;
 * - a rate limit that says "Request too large" stops being retried.
 */

const LIMIT = 600_000;
const IMAGE = 200_000;
/** Distinct base64 per image, so the test can tell which ones were sent. */
const image = (index: number) =>
  `${String(index).padStart(4, "0")}${"A".repeat(IMAGE - 4)}`;

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A browser-checking Thread: one view_media screenshot per tool call. */
const conversation = (images: number) =>
  normalizeContext({
    messages: [
      { role: "user", content: "Redesign the landing page.", timestamp: 1 },
      ...Array.from({ length: images }, (_, index) => [
        {
          role: "assistant" as const,
          content: [
            {
              type: "toolCall" as const,
              id: `call_${index}`,
              name: "view_media",
              arguments: { path: `/tmp/shot-${index}.png` },
            },
          ],
          api: "openai-completions" as const,
          provider: "test",
          model: "test",
          usage,
          stopReason: "toolUse" as const,
          timestamp: 2,
        },
        {
          role: "toolResult" as const,
          toolCallId: `call_${index}`,
          toolName: "view_media",
          content: [
            { type: "text" as const, text: `/tmp/shot-${index}.png: PNG` },
            {
              type: "image" as const,
              data: image(index),
              mimeType: "image/png",
            },
          ],
          isError: false,
          timestamp: 3,
        },
      ]).flat(),
    ],
  });

/** Which screenshots a request body carries, by their index. */
const imagesIn = (body: string) =>
  Array.from({ length: 64 }, (_, index) => index).filter((index) =>
    body.includes(image(index).slice(0, 64)),
  );

const proxied = (failure: ReturnType<typeof classifyUpstreamRejection>) =>
  Response.json(
    {
      code: failure.code,
      class: failure.class,
      upstreamStatus: failure.status,
      message: failure.message,
    },
    { status: failure.retryable ? 502 : 400 },
  );

/** A wire format, how its provider refuses a large body, and how it answers. */
interface Provider {
  readonly api: string;
  readonly provider: string;
  /** The coordinator's answer to a body over the limit. */
  readonly refuse: () => Response;
  /** The coordinator's answer to a body within it. */
  readonly accept: () => Response;
  /** dx's classification of the provider's refusal. */
  readonly code: () => string;
}

const ndjson = (events: ReadonlyArray<unknown>) =>
  new Response(events.map((event) => `${JSON.stringify(event)}\n`).join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });

const assistant = (model: string, api: string, provider: string) => ({
  role: "assistant",
  content: [{ type: "text", text: "Fitted." }],
  api,
  provider,
  model,
  usage,
  stopReason: "stop",
  timestamp: 4,
});

/** In-DO adapters relay the SDK's own error text as an event. */
const inDo = (api: string, provider: string, sdkError: string): Provider => ({
  api,
  provider,
  code: () => classifyRunFailure({ message: sdkError }).code,
  refuse: () =>
    ndjson([
      {
        type: "error",
        reason: "error",
        error: {
          ...assistant("test", api, provider),
          content: [],
          stopReason: "error",
          errorMessage: sdkError,
        },
      },
    ]),
  accept: () =>
    ndjson([
      { type: "start", partial: assistant("test", api, provider) },
      {
        type: "done",
        reason: "stop",
        message: assistant("test", api, provider),
      },
    ]),
});

/**
 * Wire formats the coordinator proxies; it classifies the upstream answer
 * with `classifyUpstreamRejection`. A body within the limit is refused with
 * a different, unrelated error, which shows that request was the one sent.
 */
const proxiedApi = (
  api: string,
  provider: string,
  status: number,
  body: string,
): Provider => ({
  api,
  provider,
  code: () => classifyUpstreamRejection(status, body).code,
  refuse: () => proxied(classifyUpstreamRejection(status, body)),
  accept: () =>
    proxied(classifyUpstreamRejection(400, '{"error":{"message":"FITTED"}}')),
});

const PROVIDERS: ReadonlyArray<Provider> = [
  // The stuck Thread: Gemini through a GitHub Copilot subscription.
  proxiedApi(
    "openai-completions",
    "github-copilot",
    413,
    "Request Entity Too Large\n",
  ),
  proxiedApi(
    "anthropic-messages",
    "anthropic",
    413,
    '{"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
  ),
  proxiedApi(
    "openai-responses",
    "openai",
    413,
    '{"error":{"message":"Request body too large.","type":"invalid_request_error"}}',
  ),
  proxiedApi(
    "azure-openai-responses",
    "azure-openai-responses",
    413,
    '{"error":{"code":"RequestEntityTooLarge","message":"Payload Too Large"}}',
  ),
  proxiedApi(
    "mistral-conversations",
    "mistral",
    413,
    "<html><head><title>413 Request Entity Too Large</title></head></html>",
  ),
  inDo(
    "google-generative-ai",
    "google",
    'got status: 413 Request Entity Too Large. {"error":{"code":413}}',
  ),
  inDo(
    "bedrock-converse-stream",
    "amazon-bedrock",
    "ValidationException: 413 Request Entity Too Large",
  ),
  inDo(
    "cloudflare-ai-binding",
    "cloudflare-workers-ai",
    "AiError: Payload Too Large",
  ),
];

const harness = (spec: Provider) => {
  const sent: string[] = [];
  const { provider } = createDxModelRoutingProvider(spec.provider, {
    namespace: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          const body = await new Response(init.body).text();
          sent.push(body);
          return body.length > LIMIT ? spec.refuse() : spec.accept();
        },
      }),
    } as never,
    identity: () => ({ name: "thr_test" }) as never,
    invocation: () => undefined,
  });
  const model = {
    id: "test-model",
    name: "test-model",
    provider: spec.provider,
    api: spec.api,
    baseUrl: "https://provider.test/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 1_000,
  } as Model<Api>;
  const call = async (context: Parameters<typeof provider.streamSimple>[1]) => {
    const before = sent.length;
    let last: AssistantMessageEvent | undefined;
    for await (const event of provider.streamSimple(model, context, {
      sessionId: "thr_test",
    } as never))
      if (event.type === "done" || event.type === "error") last = event;
    return { last, sent: sent.slice(before) };
  };
  return { call };
};

describe.each(PROVIDERS)("a request too large for $provider ($api)", (spec) => {
  it("is classified as too large, not as a rejected request", () => {
    expect(spec.code()).toBe("REQUEST_TOO_LARGE");
  });

  it("is sent again without the oldest images until it fits", async () => {
    const { call } = harness(spec);
    const { last, sent } = await call(conversation(12));

    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0]?.length).toBeGreaterThan(LIMIT);
    const final = sent.at(-1) ?? "";
    expect(final.length).toBeLessThanOrEqual(LIMIT);
    // The newest screenshots are the ones kept, oldest left out first.
    const kept = imagesIn(final);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(
      Array.from({ length: kept.length }, (_, i) => 12 - kept.length + i),
    );
    // The agent is told what was left out.
    expect(final).toContain("An image was left out");
    // The call reaches the provider's answer to the fitted request.
    if (last?.type === "error")
      expect(last.error.errorMessage).toContain("FITTED");
    else expect(last?.type).toBe("done");
  });

  it("starts later calls within the size the provider accepted", async () => {
    const { call } = harness(spec);
    await call(conversation(12));
    const { sent } = await call(conversation(13));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.length).toBeLessThanOrEqual(LIMIT);
    expect(imagesIn(sent[0] ?? "")).toContain(12);
  });

  it("hands a request too large without images to Flue's compaction", async () => {
    const { call } = harness(spec);
    const { last, sent } = await call(
      normalizeContext({
        messages: [
          { role: "user", content: "x".repeat(LIMIT + 1), timestamp: 1 },
        ],
      }),
    );
    expect(sent).toHaveLength(1);
    expect(last?.type).toBe("error");
    if (last?.type !== "error") return;
    expect(
      classifyRunFailure({ message: last.error.errorMessage ?? "" }).code,
    ).toBe("REQUEST_TOO_LARGE");
    expect(isContextOverflow(last.error)).toBe(true);
  });
});

describe("request size classification", () => {
  it("keeps a rate limit that says 'Request too large' retried", () => {
    const failure = classifyUpstreamRejection(
      429,
      '{"error":{"message":"Request too large for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Requested 52000."}}',
    );
    expect(failure.class).toBe("transient");
    expect(failure.retryable).toBe(true);
  });
});
