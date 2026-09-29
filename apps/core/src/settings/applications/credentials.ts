import {
  ExternalApiApplicationClientId,
  ExternalApiApplicationClientSecret,
  ExternalApiApplicationSecretHash,
} from "@dx/domain";
import { Context, Effect, Layer, Schema } from "effect";
import { encodeBase64Url } from "../../encoding/base64.js";

const random = (bytes: number): string => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return encodeBase64Url(value);
};

export const hashExternalApiApplicationSecret = Effect.fn(
  "hashExternalApiApplicationSecret",
)(function* (secret: string) {
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
  );
  return yield* Schema.decodeUnknownEffect(ExternalApiApplicationSecretHash)(
    Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  );
});

interface ExternalApiApplicationCredentialsShape {
  readonly createClientId: () => Effect.Effect<
    ExternalApiApplicationClientId,
    Schema.SchemaError
  >;
  readonly createSecret: () => Effect.Effect<
    {
      readonly plaintext: ExternalApiApplicationClientSecret;
      readonly hash: ExternalApiApplicationSecretHash;
      readonly identifier: string;
    },
    Schema.SchemaError
  >;
  readonly hash: (
    plaintext: string,
  ) => Effect.Effect<ExternalApiApplicationSecretHash, Schema.SchemaError>;
}

export class ExternalApiApplicationCredentials extends Context.Service<
  ExternalApiApplicationCredentials,
  ExternalApiApplicationCredentialsShape
>()("@dx/core/settings/applications/ExternalApiApplicationCredentials") {
  static readonly layer = Layer.succeed(
    ExternalApiApplicationCredentials,
    ExternalApiApplicationCredentials.of({
      createClientId: Effect.fn(
        "ExternalApiApplicationCredentials.createClientId",
      )(function* () {
        return yield* Schema.decodeUnknownEffect(
          ExternalApiApplicationClientId,
        )(`dxa_${random(18)}`);
      }),
      createSecret: Effect.fn("ExternalApiApplicationCredentials.createSecret")(
        function* () {
          const plaintext = yield* Schema.decodeUnknownEffect(
            ExternalApiApplicationClientSecret,
          )(`dxs_${random(32)}`);
          return {
            plaintext,
            hash: yield* hashExternalApiApplicationSecret(plaintext),
            identifier: plaintext.slice(0, 12),
          };
        },
      ),
      hash: hashExternalApiApplicationSecret,
    }),
  );
}
