import {
  EnvironmentVariableId,
  EnvironmentVariableName,
  EnvironmentVariablePlaintext,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../http/types.js";
import {
  ConfigEncryptionUnavailable,
  decryptEnvironmentVariable,
  encryptEnvironmentVariable,
  loadConfigEncryptionKeyring,
} from "./encryption.js";

const key1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const key2 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const bindings = (
  activeVersion = 1,
  keys: Readonly<Record<number, string>> = { 1: key1 },
): Bindings => ({
  DX_CONFIG_ENCRYPTION_KEYS: JSON.stringify({ activeVersion, keys }),
});
const context = {
  id: Schema.decodeUnknownSync(EnvironmentVariableId)("env_crypto"),
  target: {
    scope: "personal" as const,
    id: Schema.decodeUnknownSync(UserId)("crypto-user"),
  },
  name: Schema.decodeUnknownSync(EnvironmentVariableName)("BUILD_CHANNEL"),
  kind: "secret" as const,
};
const plaintext = Schema.decodeUnknownSync(EnvironmentVariablePlaintext)(
  "synthetic-secret-value",
);

describe("environment variable envelope encryption", () => {
  it("round-trips with random per-value data keys and nonces", async () => {
    const keyring = await Effect.runPromise(
      loadConfigEncryptionKeyring(bindings()),
    );
    const first = await Effect.runPromise(
      encryptEnvironmentVariable(keyring, context, plaintext),
    );
    const second = await Effect.runPromise(
      encryptEnvironmentVariable(keyring, context, plaintext),
    );
    expect(first).not.toEqual(second);
    expect(first.keyVersion).toBe(1);
    expect(JSON.stringify(first)).not.toContain(plaintext);
    await expect(
      Effect.runPromise(decryptEnvironmentVariable(keyring, context, first)),
    ).resolves.toBe(plaintext);
  });

  it("fails closed for tampering, wrong keys, metadata changes, and missing versions", async () => {
    const keyring = await Effect.runPromise(
      loadConfigEncryptionKeyring(bindings()),
    );
    const envelope = await Effect.runPromise(
      encryptEnvironmentVariable(keyring, context, plaintext),
    );
    const wrongKeyring = await Effect.runPromise(
      loadConfigEncryptionKeyring(bindings(1, { 1: key2 })),
    );
    const changedContext = { ...context, kind: "variable" as const };
    const missingVersion = { ...envelope, keyVersion: 2 };
    const change = (value: string) =>
      `${value.slice(0, -2)}${value.endsWith("AA") ? "AQ" : "AA"}`;
    for (const operation of [
      decryptEnvironmentVariable(keyring, context, {
        ...envelope,
        ciphertext: change(envelope.ciphertext),
      }),
      decryptEnvironmentVariable(keyring, context, {
        ...envelope,
        valueNonce: change(envelope.valueNonce),
      }),
      decryptEnvironmentVariable(keyring, context, {
        ...envelope,
        wrappedKey: change(envelope.wrappedKey),
      }),
      decryptEnvironmentVariable(keyring, context, {
        ...envelope,
        wrappedKeyNonce: change(envelope.wrappedKeyNonce),
      }),
      decryptEnvironmentVariable(wrongKeyring, context, envelope),
      decryptEnvironmentVariable(keyring, changedContext, envelope),
      decryptEnvironmentVariable(keyring, context, missingVersion),
    ]) {
      const error = await Effect.runPromise(Effect.flip(operation));
      expect(error).toBeInstanceOf(ConfigEncryptionUnavailable);
      expect(String(error)).not.toContain(plaintext);
    }
  });

  it("decrypts old key versions while encrypting with the active rotation version", async () => {
    const oldKeyring = await Effect.runPromise(
      loadConfigEncryptionKeyring(bindings()),
    );
    const oldEnvelope = await Effect.runPromise(
      encryptEnvironmentVariable(oldKeyring, context, plaintext),
    );
    const rotated = await Effect.runPromise(
      loadConfigEncryptionKeyring(bindings(2, { 1: key1, 2: key2 })),
    );
    expect(
      (
        await Effect.runPromise(
          encryptEnvironmentVariable(rotated, context, plaintext),
        )
      ).keyVersion,
    ).toBe(2);
    await expect(
      Effect.runPromise(
        decryptEnvironmentVariable(rotated, context, oldEnvelope),
      ),
    ).resolves.toBe(plaintext);
  });

  it("rejects missing, malformed, non-canonical, and incomplete keyrings", async () => {
    for (const input of [
      {},
      { DX_CONFIG_ENCRYPTION_KEYS: "not-json" },
      {
        DX_CONFIG_ENCRYPTION_KEYS: JSON.stringify({
          activeVersion: 1,
          keys: {},
        }),
      },
      {
        DX_CONFIG_ENCRYPTION_KEYS: JSON.stringify({
          activeVersion: 2,
          keys: { 1: key1 },
        }),
      },
      {
        DX_CONFIG_ENCRYPTION_KEYS: JSON.stringify({
          activeVersion: 1,
          keys: { 1: key1 },
          fallback: key2,
        }),
      },
    ] satisfies ReadonlyArray<Bindings>) {
      await expect(
        Effect.runPromise(loadConfigEncryptionKeyring(input)),
      ).rejects.toBeInstanceOf(ConfigEncryptionUnavailable);
    }
  });
});
