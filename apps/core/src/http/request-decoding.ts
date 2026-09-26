import { Effect, Schema, type SchemaAST } from "effect";
import type { HonoRequest } from "hono";

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
): Effect.Effect<S["Type"], E, S["DecodingServices"]> => {
  const contentType = request.header("content-type");
  if (contentType === undefined || !jsonMediaType.test(contentType)) {
    return Effect.fail(invalid());
  }

  return Effect.tryPromise({
    try: () => request.json(),
    catch: invalid,
  }).pipe(Effect.flatMap((body) => decodeRequestInput(schema, body, invalid)));
};

const readLimitedJsonBody = (request: Request, maxBytes: number) =>
  Effect.tryPromise({
    try: async () => {
      const declaredLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
        throw new Error("Request body exceeds the size limit.");
      const reader = request.body?.getReader();
      if (reader === undefined) return undefined;
      const chunks: Array<Uint8Array> = [];
      let length = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          throw new Error("Request body exceeds the size limit.");
        }
        chunks.push(result.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
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
