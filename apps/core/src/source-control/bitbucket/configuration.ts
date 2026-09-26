import { Effect, Redacted, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import type { BitbucketConfiguration } from "./provider-http.js";

export class BitbucketConfigurationInvalid extends Schema.TaggedError<BitbucketConfigurationInvalid>()(
  "BitbucketConfigurationInvalid",
  {},
) {}
const Configuration = Schema.Struct({
  version: Schema.Literal(1),
  clientId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  clientSecret: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4096),
  ),
  callbackUrl: Schema.String,
});

export const loadBitbucketConfiguration = (
  bindings: Bindings,
): Effect.Effect<BitbucketConfiguration, BitbucketConfigurationInvalid> =>
  Effect.try({
    try: () => {
      // Local composition must never construct an external provider.
      if (
        bindings.DX_RUNTIME_MODE === "local" ||
        !bindings.DX_INTEGRATION_BITBUCKET_OAUTH ||
        !bindings.DX_AUTH_URL
      )
        throw new BitbucketConfigurationInvalid();
      const value = Schema.decodeUnknownSync(Configuration)(
        JSON.parse(bindings.DX_INTEGRATION_BITBUCKET_OAUTH),
      );
      const origin = new URL(bindings.DX_AUTH_URL);
      const expected = new URL(
        "/v1/integrations/bitbucket/oauth/callback",
        origin,
      );
      if (
        origin.protocol !== "https:" ||
        origin.username ||
        origin.password ||
        value.callbackUrl !== expected.href
      )
        throw new BitbucketConfigurationInvalid();
      return { ...value, clientSecret: Redacted.make(value.clientSecret) };
    },
    catch: () => new BitbucketConfigurationInvalid(),
  });
