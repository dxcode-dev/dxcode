import { Schema } from "effect";

/**
 * One dx HTTP endpoint as every client sees it: method, path, and the schemas
 * of its path parameters, query, body, success answer, and the error answers
 * the route sends on purpose. Core serves it (the contract test checks the
 * route exists) and `@dx/client` calls it, so no UI repeats a path by hand.
 * See wiki/headless-client.md.
 */
export type EndpointMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * How the request body travels: `json` (the default) encodes it with the
 * endpoint's `body` schema; `multipart` sends form data, such as files with
 * a JSON part; `bytes` sends one file's bytes as they are.
 */
export type EndpointUpload = "json" | "multipart" | "bytes";

/**
 * What the route answers with on success: `json` (the default), decoded
 * with `success`; `file`, bytes such as an image or a download, which a UI
 * fetches or links to; `none`, no body at all, such as a 204 or a 202
 * that only accepts the work; `sse`, a `text/event-stream` whose every
 * event's `data` is JSON that `success` decodes, such as a live transcript.
 */
export type EndpointAnswer = "json" | "file" | "none" | "sse";

/** The success schema of an endpoint whose answer is a file. */
export const FileAnswerSchema = Schema.Unknown;

/** The success schema of an endpoint whose answer is `none`. */
export const NoContentSchema = Schema.Undefined;

/** A schema whose decoded value is a `{ status: "error", data }` answer. */
export type RefusalSchema = Schema.ConstraintDecoder<{
  readonly status: "error";
  readonly data: { readonly code: string; readonly message: string };
}>;

/**
 * An error answer and the HTTP status Core sends it with, such as
 * `{ status: 404, schema: PinThreadNotFoundResponseSchema }`. OpenAPI lists
 * it under that status. A schema Core sends with two statuses is listed
 * once per status.
 */
export interface Refusal {
  readonly status: number;
  readonly schema: RefusalSchema;
}

/** A refusal as an endpoint holds it. */
export type EndpointRefusal = Refusal;

/** 2xx statuses a success answer is sent with. */
export type SuccessStatus = 200 | 201 | 202 | 204;

/** A schema without services, the only kind an endpoint holds. */
export type EndpointSchema = Schema.ConstraintCodec<unknown, unknown>;

/** `/v1/threads/:threadId/pin` → `"threadId"`. */
export type PathParameterNames<Path extends string> =
  Path extends `${string}:${infer Name}/${infer Rest}`
    ? WithoutPattern<Name> | PathParameterNames<`/${Rest}`>
    : Path extends `${string}:${infer Name}`
      ? WithoutPattern<Name>
      : never;

/** `path{.+}` → `"path"`: a rest parameter, which keeps its slashes. */
type WithoutPattern<Name extends string> =
  Name extends `${infer Base}{${string}` ? Base : Name;

export interface Endpoint<
  Path extends string = string,
  Params extends EndpointSchema | undefined = EndpointSchema | undefined,
  Query extends EndpointSchema | undefined = EndpointSchema | undefined,
  Body extends EndpointSchema | undefined = EndpointSchema | undefined,
  Success extends EndpointSchema = EndpointSchema,
  Upload extends EndpointUpload = EndpointUpload,
  Answer extends EndpointAnswer = EndpointAnswer,
> {
  /** Stable, unique name, `<feature>.<action>`, such as `threads.pin`. */
  readonly id: string;
  /** One line for API docs and generated clients, such as "Pin a Thread". */
  readonly summary: string | undefined;
  readonly method: EndpointMethod;
  /** Hono-style path with `:name` parameters, as Core registers it. */
  readonly path: Path;
  readonly params: Params;
  readonly query: Query;
  readonly body: Body;
  readonly upload: Upload;
  readonly success: Success;
  /** The status of the success answer: 200 unless the route creates or accepts. */
  readonly successStatus: SuccessStatus;
  readonly answer: Answer;
  /** Every error answer the route sends on purpose, in any order. */
  readonly refusals: ReadonlyArray<EndpointRefusal>;
}

/**
 * Defines an endpoint. Each `:name` in `path` needs a field of the same name
 * in `params`, which the type checks. Give each refusal the status Core sends
 * it with.
 *
 * @example
 * export const PinThreadEndpoint = defineEndpoint({
 *   id: "threads.pin",
 *   summary: "Pin or unpin a Thread",
 *   method: "PATCH",
 *   path: "/v1/threads/:threadId/pin",
 *   params: PinThreadParamsSchema,
 *   body: PinThreadRequestSchema,
 *   success: PinThreadResponseSchema,
 *   refusals: [{ status: 404, schema: PinThreadNotFoundResponseSchema }],
 * });
 */
/*#__NO_SIDE_EFFECTS__*/
export const defineEndpoint = <
  const Path extends string,
  Success extends EndpointSchema,
  Params extends EndpointSchema | undefined = undefined,
  Query extends EndpointSchema | undefined = undefined,
  Body extends EndpointSchema | undefined = undefined,
  Upload extends EndpointUpload = "json",
  Answer extends EndpointAnswer = "json",
>(definition: {
  readonly id: string;
  /** One line for API docs and generated clients, such as "Pin a Thread". */
  readonly summary?: string;
  readonly method: EndpointMethod;
  readonly path: Path;
  readonly params?: Params &
    ([PathParameterNames<Path>] extends [never]
      ? unknown
      : EndpointSchema & {
          readonly Type: Record<PathParameterNames<Path>, string>;
        });
  readonly query?: Query;
  /** A `multipart` or `bytes` upload has no `body` schema. */
  readonly body?: Upload extends "json" ? Body : undefined;
  readonly upload?: Upload;
  /**
   * `FileAnswerSchema` when `answer` is `file`, `NoContentSchema` when
   * `none`; for `sse`, the schema of one event's JSON `data`.
   */
  readonly success: Success;
  readonly successStatus?: SuccessStatus;
  /** `{ status, schema }` for each error answer, with Core's status. */
  readonly refusals?: ReadonlyArray<Refusal>;
  readonly answer?: Answer;
}): Endpoint<Path, Params, Query, Body, Success, Upload, Answer> => ({
  id: definition.id,
  summary: definition.summary,
  method: definition.method,
  path: definition.path,
  params: definition.params as Params,
  query: definition.query as Query,
  body: definition.body as Body,
  upload: definition.upload ?? ("json" as Upload),
  success: definition.success,
  successStatus: definition.successStatus ?? 200,
  answer: definition.answer ?? ("json" as Answer),
  refusals: definition.refusals ?? [],
});
