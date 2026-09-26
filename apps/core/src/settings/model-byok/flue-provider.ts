import {
  type Api,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import type {
  ProviderOptions as FlueProviderOptions,
  getModelInvocationContext,
  ModelResolutionContext,
} from "@flue/runtime";
import type { FlueDurableObjectIdentity } from "@flue/runtime/cloudflare";
import { catalogProviderModels, IN_DO_APIS } from "../model-routing/catalog.js";

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

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

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

const PROXY_STREAM: Record<string, () => Promise<ProxyAdapter>> = {
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

/** Serialized upstream request → the coordinator `/proxy` endpoint. */
const coordinatorFetch =
  (deps: DxModelRoutingTransportDeps, model: Model<Api>): typeof fetch =>
  async (input, init) => {
    const threadId = invocationThreadId(deps);
    const request = new Request(input, init);
    const body = new Uint8Array(await request.arrayBuffer());
    const envelope = {
      threadId,
      submissionId: submissionId(deps),
      canonical: `${model.provider}/${model.id}`,
      request: {
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body: bytesToBase64(body),
      },
    };
    return coordinatorStub(deps, threadId).fetch(`${BYOK_DO_URL_BASE}/proxy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
      signal: request.signal,
    });
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
            errorMessage: `Coordinator failed (${response.status}): ${detail}`,
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
          const event = JSON.parse(line) as AssistantMessageEvent;
          if (event.type === "done" || event.type === "error") done = event;
          events.push(event);
        }
      }
      for (const line of buffer.split("\n")) {
        if (line.trim() === "") continue;
        const event = JSON.parse(line) as AssistantMessageEvent;
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
          errorMessage:
            cause instanceof Error ? cause.message : "Coordinator failed.",
          timestamp: Date.now(),
        },
      } satisfies AssistantMessageEvent);
      events.end();
    }
  })();
  return events;
};

const streamViaAdapter = (
  loadAdapter: () => Promise<ProxyAdapter>,
  method: "stream" | "streamSimple",
  deps: DxModelRoutingTransportDeps,
  model: Model<Api>,
  context: unknown,
  options: Record<string, unknown>,
) => {
  const events = createAssistantMessageEventStream();
  void (async () => {
    try {
      const adapter = await loadAdapter();
      let done: AssistantMessageEvent | undefined;
      for await (const event of adapter[method](model, context, {
        ...options,
        maxRetries: 0,
        apiKey: "dx-placeholder",
        fetch: coordinatorFetch(deps, model),
      })) {
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
          errorMessage:
            cause instanceof Error ? cause.message : "Adapter failed.",
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
    stream: ((model: Model<Api>, context: unknown, options: never) => {
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
    streamSimple: ((model: Model<Api>, context: unknown, options: never) => {
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
