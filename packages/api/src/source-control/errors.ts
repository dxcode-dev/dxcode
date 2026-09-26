import { SourceControlHealthReason } from "@dx/domain";
import { Schema } from "effect";

export const SourceControlDeniedResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("SOURCE_AUTHORIZATION_DENIED"),
    message: Schema.Literal(
      "Source access requires action before this operation can continue.",
    ),
    requestId: Schema.String,
    reason: SourceControlHealthReason,
    action: Schema.Literals([
      "reconnect",
      "reconfigure",
      "rebind",
      "contact-workspace-admin",
      "retry",
    ]),
  }),
});

export const SourceControlProviderFailureResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("SOURCE_PROVIDER_UNAVAILABLE"),
    message: Schema.Literal("Source authorization could not be confirmed."),
    requestId: Schema.String,
    retryable: Schema.Boolean,
  }),
});
