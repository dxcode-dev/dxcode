import { Schema } from "effect";

/**
 * Always `sent`: the address gets a sign-in link, or an email saying why it
 * cannot sign in yet, so the response never says whether an account exists.
 */
export const MagicLinkRequestOutcomeSchema = Schema.Literal("sent");

export type MagicLinkRequestOutcome = typeof MagicLinkRequestOutcomeSchema.Type;

export const MagicLinkRequestResponseSchema = Schema.Struct({
  status: Schema.Literal(true),
  outcome: MagicLinkRequestOutcomeSchema,
});

export type MagicLinkRequestResponse =
  typeof MagicLinkRequestResponseSchema.Type;
