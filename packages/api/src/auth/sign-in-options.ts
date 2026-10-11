import {
  AllowedEmailDomain,
  SignInAdmission,
  SignInProviderId,
  SignInRejection,
} from "@dx/domain";
import { Schema } from "effect";

/** What the signed-out web client may offer on this deployment. */
export const SignInOptionsResponseSchema = Schema.Struct({
  providers: Schema.Array(SignInProviderId),
  admission: SignInAdmission,
  allowedEmailDomains: Schema.Array(AllowedEmailDomain),
  /** Password sign-ups must confirm their address before the first session. */
  emailVerification: Schema.Boolean,
  turnstileSiteKey: Schema.optional(Schema.String),
  termsUrl: Schema.optional(Schema.String),
  privacyUrl: Schema.optional(Schema.String),
});

export type SignInOptionsResponse = typeof SignInOptionsResponseSchema.Type;

/** The `code` Better Auth returns, or the `error` query a redirect carries, when admission refuses a new identity. */
export const SignInRejectionCodeSchema = SignInRejection;
