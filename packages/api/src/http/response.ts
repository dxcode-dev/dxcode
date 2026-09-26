import { Schema } from "effect";

export const successResponse = <Data extends Schema.Constraint>(data: Data) =>
  Schema.Struct({
    status: Schema.Literal("success"),
    data,
  });

export const errorResponse = <
  const Code extends string,
  const Message extends string,
>(
  code: Code,
  message: Message,
) =>
  Schema.Struct({
    status: Schema.Literal("error"),
    data: Schema.Struct({
      code: Schema.Literal(code),
      message: Schema.Literal(message),
      requestId: Schema.String,
    }),
  });
