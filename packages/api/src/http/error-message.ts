import { Schema } from "effect";

/**
 * Reads only the message of any `{ status: "error", data }` answer. A UI
 * that shows the route's message uses it instead of the route's full error
 * union, which would ship every code and message with its first load.
 */
export const ErrorAnswerMessageSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({ message: Schema.String }),
});
