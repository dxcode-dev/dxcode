import { Schema } from "effect";

export const BrowserAuthenticationModeSchema = Schema.Literals([
  "email-password",
  "magic-link",
]);

export type BrowserAuthenticationMode =
  typeof BrowserAuthenticationModeSchema.Type;

export const BrowserAuthenticationModeResponseSchema = Schema.Struct({
  mode: BrowserAuthenticationModeSchema,
  emailPasswordEnabled: Schema.optional(Schema.Literal(true)),
  signupEnabled: Schema.optional(Schema.Boolean),
  turnstileSiteKey: Schema.optional(Schema.String),
});

export type BrowserAuthenticationModeResponse =
  typeof BrowserAuthenticationModeResponseSchema.Type;
