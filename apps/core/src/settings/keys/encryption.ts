import type {
  SigningKeyFingerprint,
  SigningKeyId,
  SigningPrivateKeyEnvelope,
  SigningPublicKey,
  UserId,
} from "@dx/domain";
import { SigningPrivateKeyPlaintext } from "@dx/domain";
import { Effect, Schema } from "effect";
import {
  type ConfigEncryptionKeyring,
  decryptConfigValue,
  encryptConfigValue,
} from "../config-encryption.js";

export interface SigningPrivateKeyEncryptionContext {
  readonly id: SigningKeyId;
  readonly userId: UserId;
  readonly publicKey: SigningPublicKey;
  readonly fingerprint: SigningKeyFingerprint;
}

const additionalData = (context: SigningPrivateKeyEncryptionContext) => ({
  purpose: "signing-private-key",
  id: context.id,
  userId: context.userId,
  publicKey: context.publicKey,
  fingerprint: context.fingerprint,
});

export const encryptSigningPrivateKey = Effect.fn("encryptSigningPrivateKey")(
  function* (
    keyring: ConfigEncryptionKeyring,
    context: SigningPrivateKeyEncryptionContext,
    privateKey: SigningPrivateKeyPlaintext,
  ) {
    return (yield* encryptConfigValue(
      keyring,
      additionalData(context),
      privateKey,
    )) satisfies SigningPrivateKeyEnvelope;
  },
);

export const decryptSigningPrivateKey = Effect.fn("decryptSigningPrivateKey")(
  function* (
    keyring: ConfigEncryptionKeyring,
    context: SigningPrivateKeyEncryptionContext,
    envelope: SigningPrivateKeyEnvelope,
  ) {
    const plaintext = yield* decryptConfigValue(
      keyring,
      additionalData(context),
      envelope,
    );
    return yield* Schema.decodeUnknownEffect(SigningPrivateKeyPlaintext)(
      plaintext,
    );
  },
);
