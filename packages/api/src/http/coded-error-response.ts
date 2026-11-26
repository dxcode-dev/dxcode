import { Schema } from "effect";

/**
 * An error answer whose code is one of `codes` and whose message Core
 * writes per request, such as one naming a code or a count.
 */
export const codedErrorResponse = <const Codes extends ReadonlyArray<string>>(
  ...codes: Codes
) =>
  Schema.Struct({
    status: Schema.Literal("error"),
    data: Schema.Struct({
      code: Schema.Literals(codes),
      message: Schema.String,
      requestId: Schema.String,
    }),
  });
