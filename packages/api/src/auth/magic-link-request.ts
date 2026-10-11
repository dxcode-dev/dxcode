import { Schema } from "effect";

/**
 * `sent` means a sign-in link is on its way; `waitlisted` means the address
 * is on the waitlist and no email was sent.
 */
export const MagicLinkRequestOutcomeSchema = Schema.Literals([
  "sent",
  "waitlisted",
]);

export type MagicLinkRequestOutcome = typeof MagicLinkRequestOutcomeSchema.Type;

export const MagicLinkRequestResponseSchema = Schema.Struct({
  status: Schema.Literal(true),
  outcome: MagicLinkRequestOutcomeSchema,
});

export type MagicLinkRequestResponse =
  typeof MagicLinkRequestResponseSchema.Type;
