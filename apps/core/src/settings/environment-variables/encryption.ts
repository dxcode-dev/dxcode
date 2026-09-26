import type {
  EnvironmentVariableEnvelope,
  EnvironmentVariableId,
  EnvironmentVariableKind,
  EnvironmentVariableName,
  EnvironmentVariablePlaintext,
  EnvironmentVariableTarget,
} from "@dx/domain";
import { Effect } from "effect";
import {
  type ConfigEncryptionKeyring,
  ConfigEncryptionUnavailable,
  decryptConfigValue,
  encryptConfigValue,
  loadConfigEncryptionKeyring,
} from "../config-encryption.js";

export {
  type ConfigEncryptionKeyring,
  ConfigEncryptionUnavailable,
  loadConfigEncryptionKeyring,
};

export interface EnvironmentVariableEncryptionContext {
  readonly id: EnvironmentVariableId;
  readonly target: EnvironmentVariableTarget;
  readonly name: EnvironmentVariableName;
  readonly kind: EnvironmentVariableKind;
}

const additionalData = (context: EnvironmentVariableEncryptionContext) => ({
  id: context.id,
  scope: context.target.scope,
  targetId: context.target.id,
  name: context.name,
  kind: context.kind,
});

export const encryptEnvironmentVariable = Effect.fn(
  "encryptEnvironmentVariable",
)(function* (
  keyring: ConfigEncryptionKeyring,
  context: EnvironmentVariableEncryptionContext,
  plaintext: EnvironmentVariablePlaintext,
) {
  return (yield* encryptConfigValue(
    keyring,
    additionalData(context),
    plaintext,
  )) satisfies EnvironmentVariableEnvelope;
});

export const decryptEnvironmentVariable = Effect.fn(
  "decryptEnvironmentVariable",
)(function* (
  keyring: ConfigEncryptionKeyring,
  context: EnvironmentVariableEncryptionContext,
  envelope: EnvironmentVariableEnvelope,
) {
  return yield* decryptConfigValue(keyring, additionalData(context), envelope);
});
