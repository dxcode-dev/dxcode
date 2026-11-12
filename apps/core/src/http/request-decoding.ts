import { Effect, Schema, type SchemaAST } from "effect";
import type { HonoRequest } from "hono";
import {
  MAX_JSON_REQUEST_BYTES,
  readBoundedJson,
  readBoundedText,
} from "./bounded-body.js";

const strictParseOptions = {
  onExcessProperty: "error",
} satisfies SchemaAST.ParseOptions;

const jsonMediaType = /^application\/json(?:\s*;.*)?$/i;

export const decodeRequestInput = <S extends Schema.Constraint, E>(
  schema: S,
  input: unknown,
  invalid: (input?: unknown) => E,
): Effect.Effect<S["Type"], E, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(
    schema,
    strictParseOptions,
  )(input).pipe(Effect.mapError(() => invalid(input)));

export const decodeJsonBody = <S extends Schema.Constraint, E>(
  request: HonoRequest,
  schema: S,
  invalid: (input?: unknown) => E,
  maxBytes: number = MAX_JSON_REQUEST_BYTES,
): Effect.Effect<S["Type"], E, S["DecodingServices"]> => {
  const contentType = request.header("content-type");
  if (contentType === undefined || !jsonMediaType.test(contentType)) {
    return Effect.fail(invalid());
  }

  return Effect.tryPromise({
    try: () => readBoundedJson(request.raw, maxBytes),
    catch: invalid,
  }).pipe(Effect.flatMap((body) => decodeRequestInput(schema, body, invalid)));
};

const readLimitedJsonBody = (request: Request, maxBytes: number) =>
  Effect.tryPromise({
    try: async () => {
      if (request.body === null) return undefined;
      const text = await readBoundedText(request, maxBytes);
      if (text === undefined)
        throw new Error("Request body exceeds the size limit.");
      return JSON.parse(text) as unknown;
    },
    catch: () => new Error("Invalid JSON request body."),
  });

export const decodeLimitedJsonBody = <S extends Schema.Constraint, E>(
  request: HonoRequest,
  maxBytes: number,
  schema: S,
  invalid: () => E,
): Effect.Effect<S["Type"], E, S["DecodingServices"]> => {
  const contentType = request.header("content-type");
  if (contentType === undefined || !jsonMediaType.test(contentType))
    return Effect.fail(invalid());

  return readLimitedJsonBody(request.raw, maxBytes).pipe(
    Effect.mapError(invalid),
    Effect.flatMap((body) => decodeRequestInput(schema, body, invalid)),
  );
};
