import { Schema } from "effect";

export const MagicLinkRequestResponseSchema = Schema.Struct({
  status: Schema.Literal(true),
});

export type MagicLinkRequestResponse =
  typeof MagicLinkRequestResponseSchema.Type;

export type AccessRequestOutcome = "request-accepted";
