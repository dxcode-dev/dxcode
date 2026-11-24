import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * How dx tests a model provider's key and reads the models it serves. One
 * set of rules for a person's connection (Settings → Model Providers) and an
 * installation's upstream, so a provider that checks out in one checks out
 * in the other. Callers do the fetch through their own guarded transport.
 */

export interface ProbeEndpoint {
  /** The Settings provider id, or any other id for a compatible service. */
  readonly providerId: string;
  /** The pi-ai wire API the endpoint speaks. */
  readonly api: string;
  readonly baseUrl: string;
}

export interface ProbeHealth {
  readonly state: "healthy" | "unhealthy";
  readonly code: string;
}

/** Headers a connection's own headers may not set: dx owns auth and framing. */
const RESERVED_HEADER_NAMES = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "host",
  "content-length",
  "connection",
]);

const customHeaders = (
  headers: ReadonlyArray<{ readonly name: string; readonly value: string }>,
) =>
  Object.fromEntries(
    headers
      .filter(({ name }) => !RESERVED_HEADER_NAMES.has(name.toLowerCase()))
      .map(({ name, value }) => [name, value]),
  );

const trimmed = (url: string) => url.replace(/\/+$/, "");

/** `/v1/models` under a root the SDK adds its own `/v1` to. */
const versioned = (base: string) =>
  base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;

/**
 * The GET that lists an endpoint's models with `apiKey`. Undefined for
 * Bedrock, whose runtime endpoint lists nothing: its check is a one-token
 * call (`probeBedrock`).
 */
export const modelListRequest = (
  endpoint: ProbeEndpoint,
  apiKey: string,
  headers: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }> = [],
):
  | {
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    }
  | undefined => {
  const base = trimmed(endpoint.baseUrl);
  const own = customHeaders(headers);
  switch (endpoint.api) {
    case "bedrock-converse-stream":
      return undefined;
    case "google-generative-ai":
      return {
        url: `${base}/models?pageSize=1000`,
        headers: { ...own, "x-goog-api-key": apiKey },
      };
    case "anthropic-messages":
      return {
        url: versioned(base),
        headers: {
          ...own,
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      };
    case "azure-openai-responses":
      return {
        url: `${base}/models?api-version=v1`,
        headers: { ...own, "api-key": apiKey },
      };
    case "mistral-conversations":
      return {
        url: versioned(base),
        headers: { ...own, authorization: `Bearer ${apiKey}` },
      };
    default:
      return {
        url: `${base}/models`,
        headers: { ...own, authorization: `Bearer ${apiKey}` },
      };
  }
};

/**
 * The GET that tests a key. Usually the model list; OpenRouter lists its
 * models to anyone, so its check reads the key's own record instead.
 */
export const keyCheckRequest = (
  endpoint: ProbeEndpoint,
  apiKey: string,
  headers: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }> = [],
) => {
  const request = modelListRequest(endpoint, apiKey, headers);
  if (request === undefined || endpoint.providerId !== "openrouter")
    return request;
  return {
    url: `${new URL(endpoint.baseUrl).origin}/api/v1/key`,
    headers: { ...customHeaders(headers), authorization: `Bearer ${apiKey}` },
  };
};

/** At most this many model ids are read from a list. */
const MODEL_LIST_MAX = 1_000;

/**
 * The model ids in a list response: `{ data: [{ id }] }` (OpenAI, Anthropic
 * and most compatible services) or Gemini's `{ models: [{ name }] }`.
 * Undefined when the body is neither.
 */
export const parseModelList = (
  body: unknown,
): ReadonlyArray<string> | undefined => {
  const value = body as
    | {
        readonly data?: ReadonlyArray<{ readonly id?: unknown }>;
        readonly models?: ReadonlyArray<{ readonly name?: unknown }>;
      }
    | undefined;
  const ids = Array.isArray(value?.data)
    ? value.data.map(({ id }) => id)
    : Array.isArray(value?.models)
      ? value.models.map(({ name }) =>
          typeof name === "string" ? name.replace(/^models\//, "") : name,
        )
      : undefined;
  if (ids === undefined) return undefined;
  return [
    ...new Set(
      ids.flatMap((id) =>
        typeof id === "string" && id.length > 0 && id.length <= 256 ? [id] : [],
      ),
    ),
  ]
    .slice(0, MODEL_LIST_MAX)
    .toSorted();
};

/** What a probe's answer says about the key. */
export const probeHealth = (
  response: Response | "ENDPOINT_NOT_ALLOWED" | undefined,
): ProbeHealth => {
  if (response === undefined)
    return { state: "unhealthy", code: "NETWORK_ERROR" };
  if (response === "ENDPOINT_NOT_ALLOWED")
    return { state: "unhealthy", code: response };
  if (response.status === 401 || response.status === 403)
    return { state: "unhealthy", code: "AUTH_REJECTED" };
  if (response.status >= 300 && response.status < 400)
    return { state: "unhealthy", code: "ENDPOINT_REDIRECT" };
  return response.ok
    ? { state: "healthy", code: "CONNECTED" }
    : { state: "unhealthy", code: `HTTP_${response.status}` };
};

/**
 * A Bedrock key's check: a one-token Converse call to `model`, since the
 * runtime endpoint has no list to read.
 */
export const probeBedrock = async (
  model: Model<Api>,
  apiKey: string,
  headers: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }> = [],
): Promise<ProbeHealth> => {
  try {
    const { streamSimple } = await import(
      "@earendil-works/pi-ai/api/bedrock-converse-stream"
    );
    const events = streamSimple(
      model as never,
      {
        systemPrompt: undefined,
        messages: [{ role: "user", content: "ping", timestamp: 0 }],
        tools: [],
      } as never,
      {
        apiKey,
        bearerToken: apiKey,
        maxTokens: 1,
        headers: customHeaders(headers),
      } as never,
    );
    for await (const event of events) {
      if (event.type === "done") return { state: "healthy", code: "CONNECTED" };
      if (event.type === "error")
        return { state: "unhealthy", code: "AUTH_REJECTED" };
    }
    return { state: "unhealthy", code: "ENDPOINT_UNRESOLVED" };
  } catch {
    return { state: "unhealthy", code: "NETWORK_ERROR" };
  }
};

/** A Bedrock model a check can call in any commercial region. */
export const bedrockProbeModel = (
  models: ReadonlyArray<Model<Api>>,
): Model<Api> | undefined =>
  models.find(
    ({ id }) =>
      !id.startsWith("eu.") && !id.startsWith("au.") && !id.startsWith("jp."),
  );
