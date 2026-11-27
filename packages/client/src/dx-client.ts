import type { Endpoint, EndpointSchema } from "@dx/api";
import { Schema } from "effect";
import { ApiError, apiErrorFromRefusal } from "./api-error.js";

/** An answer read before the client asked, such as the web boot's prefetch. */
export interface PrefetchedAnswer {
  readonly status: number;
  readonly text: string;
  readonly contentType: string;
}

/**
 * How a client reaches dx. The web sends same-origin cookies through
 * `fetch`; a native shell or CLI adds its own origin and bearer token.
 */
export interface DxTransport {
  readonly fetch: (path: string, init: RequestInit) => Promise<Response>;
  /** A GET answer read ahead of time for `path`, taken at most once. */
  readonly takePrefetched?: (
    path: string,
  ) => Promise<PrefetchedAnswer | undefined>;
}

type Field<Name extends string, S> = S extends EndpointSchema
  ? { readonly [K in Name]: S["Type"] }
  : { readonly [K in Name]?: never };

/** A `multipart` upload sends form data, a `bytes` upload one file's bytes. */
type BodyField<E extends Endpoint> = E["upload"] extends "multipart"
  ? { readonly body: FormData }
  : E["upload"] extends "bytes"
    ? { readonly body: Blob }
    : Field<"body", E["body"]>;

/** What a call sends: the decoded values of the endpoint's params, query, and body. */
export type EndpointInput<E extends Endpoint> = Field<"params", E["params"]> &
  Field<"query", E["query"]> &
  BodyField<E>;

/**
 * What a call answers: the decoded success, a file's bytes, or for an event
 * stream the open response, which `readEventStream` reads.
 */
export type EndpointAnswerValue<E extends Endpoint> = E["answer"] extends "file"
  ? Blob
  : E["answer"] extends "none"
    ? undefined
    : E["answer"] extends "sse"
      ? Response
      : E["success"]["Type"];

export interface CallOptions {
  readonly signal?: AbortSignal;
  /** Request headers the endpoint reads besides its input, such as `idempotency-key`. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Lets the request outlive the page, as a save started while it unloads needs (`fetch`'s `keepalive`). */
  readonly keepalive?: boolean;
}

export interface DxClient {
  /**
   * Calls `endpoint` and returns its decoded success answer. Throws ApiError
   * for an error answer: with the endpoint's message and code when it is one
   * of its refusals, else "Request failed.".
   */
  readonly call: <E extends Endpoint>(
    endpoint: E,
    ...input: Record<string, never> extends EndpointInput<E>
      ? [input?: EndpointInput<E>, options?: CallOptions]
      : [input: EndpointInput<E>, options?: CallOptions]
  ) => Promise<EndpointAnswerValue<E>>;
}

/**
 * Encodes without running the schema's checks: a value a person typed (a
 * malformed ID, an empty name) reaches Core, which refuses it with its own
 * field message, as it did before endpoints existed. Transformations, such
 * as a DateTime to its ISO string, still apply.
 */
const encodeSync = (schema: EndpointSchema, value: unknown) =>
  Schema.encodeUnknownSync(schema)(value, { disableChecks: true });

/** `/v1/threads/:threadId/pin` with `{ threadId }` → `/v1/threads/thr_…/pin`. */
export const endpointPath = (
  endpoint: Endpoint,
  input: { readonly params?: unknown; readonly query?: unknown },
): string => {
  const params =
    endpoint.params === undefined
      ? {}
      : (encodeSync(endpoint.params, input.params) as Record<string, unknown>);
  // A rest parameter (`:path{.+}`) keeps its slashes: each segment is
  // encoded, so `src/a b.ts` fills `/files/:path{.+}` as `/files/src/a%20b.ts`.
  const path = endpoint.path.replace(
    /:([A-Za-z0-9_]+)(\{[^}]*\})?/g,
    (_, name: string, pattern: string | undefined) => {
      const value = params[name];
      if (value === undefined)
        throw new Error(`${endpoint.id}: missing path parameter ${name}.`);
      return pattern === undefined
        ? encodeURIComponent(String(value))
        : String(value).split("/").map(encodeURIComponent).join("/");
    },
  );
  if (endpoint.query === undefined) return path;
  const query = new URLSearchParams();
  const encoded = encodeSync(endpoint.query, input.query ?? {}) as Record<
    string,
    unknown
  >;
  for (const [name, value] of Object.entries(encoded))
    if (value !== undefined) query.set(name, String(value));
  const search = query.toString();
  return search === "" ? path : `${path}?${search}`;
};

const decodeSuccess = (endpoint: Endpoint, body: unknown) =>
  Schema.decodeUnknownPromise(endpoint.success)(body);

/**
 * The ApiError for an error answer `body` read outside `call`, such as an
 * upload sent with XMLHttpRequest to report its progress: the endpoint's
 * message when it is one of its refusals, else "Request failed.".
 */
export const refusalError = async (
  endpoint: Endpoint,
  status: number,
  body: unknown,
): Promise<ApiError> => {
  for (const refusal of endpoint.refusals) {
    const decoded = await Schema.decodeUnknownPromise(refusal.schema)(
      body,
    ).catch(() => undefined);
    if (decoded !== undefined) return apiErrorFromRefusal(status, decoded.data);
  }
  return new ApiError(status, "Request failed.");
};

export const createDxClient = (transport: DxTransport): DxClient => {
  const call = async (
    endpoint: Endpoint,
    input: {
      readonly params?: unknown;
      readonly query?: unknown;
      readonly body?: unknown;
    } = {},
    options: CallOptions = {},
  ) => {
    const path = endpointPath(endpoint, input);
    if (
      endpoint.method === "GET" &&
      endpoint.answer === "json" &&
      transport.takePrefetched !== undefined
    ) {
      const prefetched = await transport.takePrefetched(path);
      // A prefetched success that no longer decodes is read again; a
      // prefetched 404 is the answer, since reading again only delays it.
      if (prefetched?.status === 200) {
        const decoded = await decodeSuccess(
          endpoint,
          JSON.parse(prefetched.text),
        ).then(
          (value) => ({ value }),
          () => undefined,
        );
        if (decoded !== undefined) return decoded.value;
      }
      if (prefetched?.status === 404)
        throw await refusalError(
          endpoint,
          404,
          JSON.parse(prefetched.text) as unknown,
        );
    }
    // Form data and bytes go as they are: fetch sets a multipart body's
    // boundary, and a file's own type.
    const json = endpoint.upload === "json";
    const body = json
      ? endpoint.body && JSON.stringify(encodeSync(endpoint.body, input.body))
      : (input.body as BodyInit);
    const response = await transport.fetch(path, {
      method: endpoint.method,
      headers: {
        accept:
          endpoint.answer === "file"
            ? "*/*"
            : endpoint.answer === "sse"
              ? "text/event-stream"
              : "application/json",
        ...(json && body && { "content-type": "application/json" }),
        ...options.headers,
      },
      body,
      signal: options.signal,
      keepalive: options.keepalive,
    });
    if (response.ok && endpoint.answer === "file") return response.blob();
    // A 204 or a bodiless 202: nothing to read.
    if (response.ok && endpoint.answer === "none") return undefined;
    // An event stream stays open; the caller reads it.
    if (response.ok && endpoint.answer === "sse") return response;
    const answer: unknown = await response.json().catch(() => undefined);
    if (!response.ok)
      throw await refusalError(endpoint, response.status, answer);
    return decodeSuccess(endpoint, answer);
  };
  return { call: call as DxClient["call"] };
};
