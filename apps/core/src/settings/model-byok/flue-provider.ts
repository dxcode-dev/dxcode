import {
  type Api,
  type AssistantMessageEvent,
  type Context,
  createAssistantMessageEventStream,
  type ImageContent,
  type Model,
  type Provider,
  type TextContent,
} from "@earendil-works/pi-ai";
import type {
  ProviderOptions as FlueProviderOptions,
  getModelInvocationContext,
  ModelResolutionContext,
} from "@flue/runtime";
import type { FlueDurableObjectIdentity } from "@flue/runtime/cloudflare";
import { decodeBase64 } from "../../encoding/base64.js";
import {
  IMAGE_MAX_EDGE,
  imageInfo,
} from "../../plugins/execution/media/image.js";
import { AGENT_RUN_LIMIT_MS } from "../../runtime/agent-run-limit.js";
import {
  classifyRunFailure,
  markRunFailure,
  type RunFailure,
  type RunFailureClass,
  runFailureText,
} from "../../runtime/run-failure.js";
import { catalogProviderModels, IN_DO_APIS } from "../model-routing/catalog.js";
import {
  encodeProxyEnvelope,
  PROXY_ENVELOPE_HEADER,
} from "./proxy-envelope.js";

/**
 * Model routing v2 transport (decision 22): one dx `Provider` per pi-ai
 * catalog provider id. Wire-format apis forward their serialized request to
 * the credential coordinator DO, which revalidates the thread route, swaps
 * the placeholder auth for the decrypted key, pins the origin and applies
 * custom headers/model renames. `google-generative-ai` and
 * `bedrock-converse-stream` refuse custom fetch, so the DO runs those
 * adapters itself and relays the event stream. The Copilot subscription is
 * forwarded through the Copilot runtime's `invoke` (entitlements, headers,
 * stream bounds).
 */

export const BYOK_DO_URL_BASE = "https://dx-byok.invalid";

export interface DxModelRoutingTransportDeps {
  readonly namespace: DurableObjectNamespace;
  readonly identity: () => FlueDurableObjectIdentity | undefined;
  readonly invocation: typeof getModelInvocationContext;
}

type ProxyAdapter = {
  readonly stream: (
    model: Model<Api>,
    context: unknown,
    options: unknown,
  ) => AsyncIterable<AssistantMessageEvent>;
  readonly streamSimple: (
    model: Model<Api>,
    context: unknown,
    options: unknown,
  ) => AsyncIterable<AssistantMessageEvent>;
};

export const PROXY_STREAM: Record<string, () => Promise<ProxyAdapter>> = {
  "openai-completions": () =>
    import(
      "@earendil-works/pi-ai/api/openai-completions"
    ) as Promise<ProxyAdapter>,
  "openai-responses": () =>
    import(
      "@earendil-works/pi-ai/api/openai-responses"
    ) as Promise<ProxyAdapter>,
  "azure-openai-responses": () =>
    import(
      "@earendil-works/pi-ai/api/azure-openai-responses"
    ) as Promise<ProxyAdapter>,
  "anthropic-messages": () =>
    import(
      "@earendil-works/pi-ai/api/anthropic-messages"
    ) as Promise<ProxyAdapter>,
  "mistral-conversations": () =>
    import(
      "@earendil-works/pi-ai/api/mistral-conversations"
    ) as Promise<ProxyAdapter>,
};

const invocationThreadId = (
  deps: DxModelRoutingTransportDeps,
  context?: ModelResolutionContext,
): string => {
  const identity = deps.identity();
  const threadId = context?.instanceId ?? identity?.name;
  if (threadId === undefined) throw new Error("Thread context unavailable.");
  return threadId;
};

const submissionId = (
  deps: DxModelRoutingTransportDeps,
): string | undefined => {
  const scope = deps.invocation()?.scope;
  return scope?.kind === "prompt" ? scope.submissionId : undefined;
};

const coordinatorStub = (deps: DxModelRoutingTransportDeps, threadId: string) =>
  deps.namespace.get(deps.namespace.idFromName(`byok-${threadId}`));

/**
 * Providers reject a failed tool result without text (Anthropic: "content
 * cannot be empty if `is_error` is true"). Flue keeps that result in history,
 * so every later turn and retry would fail; give it text before serialization.
 */
export const withNonEmptyToolErrors = (context: Context): Context => {
  let changed = false;
  const messages = context.messages.map((message) => {
    if (
      message.role !== "toolResult" ||
      !message.isError ||
      message.content.some(
        (block) => block.type === "image" || block.text.trim() !== "",
      )
    )
      return message;
    changed = true;
    return {
      ...message,
      content: [
        {
          type: "text" as const,
          text: `Tool ${message.toolName} failed without an error message.`,
        },
      ],
    };
  });
  return changed ? { ...context, messages } : context;
};

/**
 * Above this many images in one request, Anthropic refuses any image over
 * 2000–3000 px on a side ("many-image requests"); one such image fails the
 * whole request.
 */
const MANY_IMAGES = 20;
/** Base64 read first for an image's size; the header is near the start. */
const IMAGE_HEAD_CHARS = 64 * 1024;

const imageSize = (data: string) =>
  imageInfo(decodeBase64(data.slice(0, IMAGE_HEAD_CHARS))) ??
  (data.length > IMAGE_HEAD_CHARS ? imageInfo(decodeBase64(data)) : undefined);

/**
 * Flue keeps every image in history, so one sent at full size while a
 * conversation held few images makes every turn fail once it holds more
 * than 20. Past that count, an image over the edge `view_media` sends is
 * replaced by a note naming it, so the agent can view a smaller copy.
 */
const withSendableImages = (context: Context): Context => {
  let count = 0;
  for (const message of context.messages)
    if (message.role !== "assistant" && typeof message.content !== "string")
      for (const block of message.content) if (block.type === "image") count++;
  if (count <= MANY_IMAGES) return context;
  let changed = false;
  const sendable = (
    block: TextContent | ImageContent,
  ): TextContent | ImageContent => {
    if (block.type !== "image") return block;
    const size = imageSize(block.data);
    if (
      size === undefined ||
      Math.max(size.width, size.height) <= IMAGE_MAX_EDGE
    )
      return block;
    changed = true;
    return {
      type: "text",
      text: `[A ${size.width}×${size.height} image was left out: with more than ${MANY_IMAGES} images in the conversation, models refuse images over ${IMAGE_MAX_EDGE} pixels on a side. View a smaller copy if you need it.]`,
    };
  };
  const messages = context.messages.map((message) =>
    message.role === "user" && typeof message.content !== "string"
      ? { ...message, content: message.content.map(sendable) }
      : message.role === "toolResult"
        ? { ...message, content: message.content.map(sendable) }
        : message,
  );
  return changed ? { ...context, messages } : context;
};

/** History as every provider accepts it. */
const sendableContext = (context: Context) =>
  withSendableImages(withNonEmptyToolErrors(context));

const FAILURE_CLASSES: ReadonlySet<string> = new Set<RunFailureClass>([
  "account",
  "transient",
  "platform",
  "internal",
]);

/**
 * A failed coordinator answer as a run failure: the coordinator's own
 * classification when it gave one, otherwise its routing code.
 */
const coordinatorFailure = (status: number, text: string): RunFailure => {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null)
      body = parsed as Record<string, unknown>;
  } catch {
    // Not a coordinator body; classified from its status below.
  }
  const { code, message } = body;
  const failureClass = body.class;
  if (
    typeof code === "string" &&
    typeof message === "string" &&
    typeof failureClass === "string" &&
    FAILURE_CLASSES.has(failureClass)
  )
    return {
      class: failureClass as RunFailureClass,
      code,
      message,
      retryable: failureClass === "transient" || failureClass === "platform",
      ...(typeof body.upstreamStatus === "number"
        ? { status: body.upstreamStatus }
        : {}),
    };
  const routingCode = typeof code === "string" ? code : `HTTP_${status}`;
  const byCode = classifyRunFailure({ message: routingCode });
  if (byCode.class !== "internal") return byCode;
  const retryable = status >= 500;
  return {
    class: retryable ? "transient" : "internal",
    // The stamp carries only `[A-Z0-9_]` (`MODEL_NOT_SERVED: openai/…`).
    code: /^[A-Z0-9_]+/.exec(routingCode)?.[0] ?? "MODEL_ROUTING_FAILED",
    message: retryable
      ? "Model routing is temporarily unavailable."
      : `Model routing refused the call (${routingCode}).`,
    retryable,
    status,
  };
};

/**
 * The text Flue reads to decide whether to retry: stamped with its class.
 * Without a coordinator classification, a request the provider rejected
 * keeps the provider's words, which is where Flue finds a context overflow.
 */
const failureText = (errorMessage: string, failure?: RunFailure) => {
  if (failure !== undefined) return markRunFailure(failure);
  const classified = classifyRunFailure({ message: errorMessage });
  return markRunFailure(
    classified.class === "internal"
      ? {
          ...classified,
          message: runFailureText(errorMessage) || classified.message,
        }
      : classified,
  );
};

const withFailureText = (
  event: AssistantMessageEvent,
  failure?: RunFailure,
): AssistantMessageEvent =>
  event.type === "error" && event.error.stopReason === "error"
    ? {
        ...event,
        error: {
          ...event.error,
          errorMessage: failureText(event.error.errorMessage ?? "", failure),
        },
      }
    : event;

/**
 * Serialized upstream request → the coordinator `/proxy` endpoint. The body
 * streams through unchanged; only routing metadata travels in a header.
 */
const coordinatorFetch =
  (
    deps: DxModelRoutingTransportDeps,
    model: Model<Api>,
    onFailure: (failure: RunFailure) => void,
  ): typeof fetch =>
  async (input, init) => {
    const threadId = invocationThreadId(deps);
    const request = new Request(input, init);
    const submission = submissionId(deps);
    const envelope = encodeProxyEnvelope({
      threadId,
      ...(submission === undefined ? {} : { submissionId: submission }),
      canonical: `${model.provider}/${model.id}`,
      request: {
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
      },
    });
    const response = await coordinatorStub(deps, threadId).fetch(
      `${BYOK_DO_URL_BASE}/proxy`,
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          [PROXY_ENVELOPE_HEADER]: envelope,
        },
        body: request.body,
        signal: request.signal,
      },
    );
    if (!response.ok)
      onFailure(
        coordinatorFailure(
          response.status,
          await response
            .clone()
            .text()
            .catch(() => ""),
        ),
      );
    return response;
  };

/** In-DO adapter run → the coordinator `/stream` endpoint, events relayed. */
const streamViaCoordinator = (
  deps: DxModelRoutingTransportDeps,
  model: Model<Api>,
  context: unknown,
  options: Record<string, unknown>,
) => {
  const events = createAssistantMessageEventStream();
  const threadId = invocationThreadId(deps);
  const envelope = {
    threadId,
    submissionId: submissionId(deps),
    canonical: `${model.provider}/${model.id}`,
    context,
    options: {
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.maxTokens === undefined
        ? {}
        : { maxTokens: options.maxTokens }),
      ...(options.temperature === undefined
        ? {}
        : { temperature: options.temperature }),
      ...(options.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: options.thinkingLevel }),
      ...(options.reasoning === undefined
        ? {}
        : { reasoning: options.reasoning }),
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.thinkingBudgets === undefined
        ? {}
        : { thinkingBudgets: options.thinkingBudgets }),
      ...(options.maxRetryDelayMs === undefined
        ? {}
        : { maxRetryDelayMs: options.maxRetryDelayMs }),
    },
  };
  void (async () => {
    try {
      const response = await coordinatorStub(deps, threadId).fetch(
        `${BYOK_DO_URL_BASE}/stream`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(envelope),
          signal: options.signal as AbortSignal | undefined,
        },
      );
      if (!response.ok || response.body === null) {
        const detail = await response.text().catch(() => "");
        events.push({
          type: "error",
          reason: "aborted",
          error: {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "error",
            errorMessage: markRunFailure(
              coordinatorFailure(response.status, detail),
            ),
            timestamp: Date.now(),
          },
        } satisfies AssistantMessageEvent);
        events.end();
        return;
      }
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      let buffer = "";
      let done: AssistantMessageEvent | undefined;
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() === "") continue;
          const event = withFailureText(
            JSON.parse(line) as AssistantMessageEvent,
          );
          if (event.type === "done" || event.type === "error") done = event;
          events.push(event);
        }
      }
      for (const line of buffer.split("\n")) {
        if (line.trim() === "") continue;
        const event = withFailureText(
          JSON.parse(line) as AssistantMessageEvent,
        );
        if (event.type === "done" || event.type === "error") done = event;
        events.push(event);
      }
      if (done?.type === "done") events.end(done.message);
      else if (done?.type === "error") events.end(done.error);
      else events.end();
    } catch (cause) {
      events.push({
        type: "error",
        reason: "aborted",
        error: {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "error",
          errorMessage: failureText(
            cause instanceof Error ? cause.message : "Coordinator failed.",
          ),
          timestamp: Date.now(),
        },
      } satisfies AssistantMessageEvent);
      events.end();
    }
  })();
  return events;
};

/**
 * Anthropic's 1-hour prompt cache, for calls to the Anthropic API itself
 * (#1757). pi sets the same `cache_control` breakpoints either way (system
 * prompt, last tool, last user message); "long" adds `ttl: "1h"` to each. A
 * 1-hour write costs 2× input instead of 1.25× and a read 0.1× either way, so
 * every write costs 0.75× more and every call 5 to 60 minutes after the last
 * one saves 1.15× (a read instead of a full rewrite). It comes out ahead when
 * the tokens rewritten after such pauses exceed about two thirds of all tokens
 * written; production Threads do (about 5% less input cost), a Thread that
 * never pauses pays more. Copilot and custom endpoints serving Claude over the
 * same wire keep their default.
 */
const promptCacheRetention = (model: Model<Api>) =>
  model.provider === "anthropic" &&
  model.api === "anthropic-messages" &&
  /^https:\/\/api\.anthropic\.com(\/|$)/.test(model.baseUrl)
    ? { cacheRetention: "long" }
    : {};

const streamViaAdapter = (
  loadAdapter: () => Promise<ProxyAdapter>,
  method: "stream" | "streamSimple",
  deps: DxModelRoutingTransportDeps,
  model: Model<Api>,
  context: unknown,
  options: Record<string, unknown>,
) => {
  const events = createAssistantMessageEventStream();
  // The SDK turns a failed coordinator answer into its own error text; the
  // coordinator's classification replaces it.
  let failure: RunFailure | undefined;
  void (async () => {
    try {
      const adapter = await loadAdapter();
      let done: AssistantMessageEvent | undefined;
      for await (const raw of adapter[method](model, context, {
        ...promptCacheRetention(model),
        ...options,
        maxRetries: 0,
        // Flue's submission deadline bounds the call; SDK defaults must not
        // end it first (OpenAI/Anthropic 10 min to response, Mistral 60 s total).
        timeoutMs: AGENT_RUN_LIMIT_MS,
        apiKey: "dx-placeholder",
        fetch: coordinatorFetch(deps, model, (rejected) => {
          failure = rejected;
        }),
      })) {
        const event = withFailureText(raw, failure);
        if (event.type === "done" || event.type === "error") done = event;
        events.push(event);
      }
      if (done?.type === "done") events.end(done.message);
      else if (done?.type === "error") events.end(done.error);
      else events.end();
    } catch (cause) {
      events.push({
        type: "error",
        reason: "aborted",
        error: {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "error",
          errorMessage: failureText(
            cause instanceof Error ? cause.message : "Adapter failed.",
            failure,
          ),
          timestamp: Date.now(),
        },
      } satisfies AssistantMessageEvent);
      events.end();
    }
  })();
  return events;
};

/**
 * Mint the `Model` the adapter serializes for a canonical specifier. The
 * serving connection decides the wire api + base URL; capabilities come from
 * the canonical catalog entry (decision 9).
 */
const mintModel = async (
  deps: DxModelRoutingTransportDeps,
  specifier: { providerId: string; modelId: string },
  context: ModelResolutionContext,
): Promise<Model<Api> | undefined> => {
  const canonical = `${specifier.providerId}/${specifier.modelId}`;
  const threadId = invocationThreadId(deps, context);
  if (context.scope?.kind !== "prompt") throw new Error("SUBMISSION_REQUIRED");
  const response = await coordinatorStub(deps, threadId).fetch(
    `${BYOK_DO_URL_BASE}/model`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId,
        submissionId: context.scope.submissionId,
        canonical,
      }),
      signal: context.signal,
    },
  );
  if (!response.ok) throw new Error(`Model routing: ${await response.text()}`);
  return response.json<Model<Api>>();
};

export const createDxModelRoutingProvider = (
  providerId: string,
  deps: DxModelRoutingTransportDeps,
): { provider: Provider; options: FlueProviderOptions } => {
  const models = catalogProviderModels(providerId);
  const provider: Provider = {
    id: providerId,
    name: providerId,
    auth: {
      apiKey: {
        name: "dx connection credential",
        resolve: async () => ({ auth: {} }),
      },
    },
    getModels: () => models,
    stream: ((model: Model<Api>, rawContext: Context, options: never) => {
      const context = sendableContext(rawContext);
      if (IN_DO_APIS.has(model.api) || model.api === "cloudflare-ai-binding")
        return streamViaCoordinator(deps, model, context, options);
      const loadAdapter = PROXY_STREAM[model.api];
      if (loadAdapter === undefined)
        throw new Error(`Unsupported wire api ${model.api}.`);
      return streamViaAdapter(
        loadAdapter,
        "stream",
        deps,
        model,
        context,
        options as Record<string, unknown>,
      );
    }) as Provider["stream"],
    streamSimple: ((model: Model<Api>, rawContext: Context, options: never) => {
      const context = sendableContext(rawContext);
      if (IN_DO_APIS.has(model.api) || model.api === "cloudflare-ai-binding")
        return streamViaCoordinator(deps, model, context, options);
      const loadAdapter = PROXY_STREAM[model.api];
      if (loadAdapter === undefined)
        throw new Error(`Unsupported wire api ${model.api}.`);
      return streamViaAdapter(
        loadAdapter,
        "streamSimple",
        deps,
        model,
        context,
        options as Record<string, unknown>,
      );
    }) as Provider["streamSimple"],
  };
  const options: FlueProviderOptions = {
    resolveModel: async (
      specifier: { providerId: string; modelId: string },
      context: ModelResolutionContext,
    ) => {
      if (specifier.providerId !== providerId) return undefined;
      return mintModel(deps, specifier, context);
    },
  };
  return { provider, options };
};
