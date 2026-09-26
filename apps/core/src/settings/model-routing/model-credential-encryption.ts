import type {
  EnvironmentVariableEnvelope,
  EnvironmentVariableId,
  EnvironmentVariablePlaintext,
  ModelConnectionTarget,
} from "@dx/domain";
import { Effect } from "effect";
import {
  type ConfigEncryptionKeyring,
  decryptConfigValue,
  encryptConfigValue,
} from "../config-encryption.js";

export const MODEL_CREDENTIAL_ID_PREFIX = "mcred_";

/**
 * Model credentials share the config-encryption envelope with environment
 * variables, but bind a distinct `model-credential` kind and the free-form
 * credential name so an envelope can never be replayed as an env-var secret.
 */
export interface ModelCredentialEncryptionContext {
  readonly id: EnvironmentVariableId;
  readonly target: ModelConnectionTarget;
  readonly name: string;
}

const additionalData = (context: ModelCredentialEncryptionContext) => ({
  id: context.id,
  scope: context.target.scope,
  targetId: context.target.id,
  name: context.name,
  kind: "model-credential",
});

export const encryptModelCredential = Effect.fn("encryptModelCredential")(
  function* (
    keyring: ConfigEncryptionKeyring,
    context: ModelCredentialEncryptionContext,
    plaintext: EnvironmentVariablePlaintext,
  ) {
    return (yield* encryptConfigValue(
      keyring,
      additionalData(context),
      plaintext,
    )) satisfies EnvironmentVariableEnvelope;
  },
);

export const decryptModelCredential = Effect.fn("decryptModelCredential")(
  function* (
    keyring: ConfigEncryptionKeyring,
    context: ModelCredentialEncryptionContext,
    envelope: EnvironmentVariableEnvelope,
  ) {
    return yield* decryptConfigValue(
      keyring,
      additionalData(context),
      envelope,
    );
  },
);
