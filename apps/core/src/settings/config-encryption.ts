import { Effect, Schema } from "effect";
import type { Bindings } from "../http/types.js";

const AES_GCM_NONCE_BYTES = 12;
const AES_256_KEY_BYTES = 32;
const MAX_KEY_VERSIONS = 32;

export class ConfigEncryptionUnavailable extends Schema.TaggedError<ConfigEncryptionUnavailable>()(
  "ConfigEncryptionUnavailable",
  {},
) {}

export interface ConfigEncryptionKeyring {
  readonly activeVersion: number;
  readonly keys: ReadonlyMap<number, CryptoKey>;
}

export interface ConfigValueEnvelope {
  readonly version: 1;
  readonly keyVersion: number;
  readonly valueNonce: string;
  readonly ciphertext: string;
  readonly wrappedKeyNonce: string;
  readonly wrappedKey: string;
}

export type ConfigEncryptionContext = Readonly<
  Record<string, string | number | boolean>
>;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const decodeMasterKey = (value: unknown): Uint8Array<ArrayBuffer> => {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new ConfigEncryptionUnavailable();
  }
  const bytes = base64ToBytes(value);
  if (
    bytes.byteLength !== AES_256_KEY_BYTES ||
    bytesToBase64(bytes) !== value
  ) {
    throw new ConfigEncryptionUnavailable();
  }
  return bytes;
};

const parseKeyring = (value: string) => {
  const decoded: unknown = JSON.parse(value);
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded) ||
    Object.keys(decoded).sort().join(",") !== "activeVersion,keys"
  ) {
    throw new ConfigEncryptionUnavailable();
  }
  const input = decoded as Record<string, unknown>;
  if (
    !Number.isSafeInteger(input.activeVersion) ||
    (input.activeVersion as number) < 1 ||
    typeof input.keys !== "object" ||
    input.keys === null ||
    Array.isArray(input.keys)
  ) {
    throw new ConfigEncryptionUnavailable();
  }
  const entries = Object.entries(input.keys as Record<string, unknown>);
  if (entries.length < 1 || entries.length > MAX_KEY_VERSIONS) {
    throw new ConfigEncryptionUnavailable();
  }
  const keys = entries.map(([rawVersion, rawKey]) => {
    const version = Number(rawVersion);
    if (!/^[1-9][0-9]*$/.test(rawVersion) || !Number.isSafeInteger(version)) {
      throw new ConfigEncryptionUnavailable();
    }
    return [version, decodeMasterKey(rawKey)] as const;
  });
  if (!keys.some(([version]) => version === input.activeVersion)) {
    throw new ConfigEncryptionUnavailable();
  }
  return { activeVersion: input.activeVersion as number, keys };
};

export const loadConfigEncryptionKeyring = Effect.fn(
  "loadConfigEncryptionKeyring",
)(function* (bindings: Bindings) {
  const secret = bindings.DX_CONFIG_ENCRYPTION_KEYS;
  if (secret === undefined || secret.length === 0) {
    return yield* new ConfigEncryptionUnavailable();
  }
  const parsed = yield* Effect.try({
    try: () => parseKeyring(secret),
    catch: () => new ConfigEncryptionUnavailable(),
  });
  const imported = yield* Effect.tryPromise({
    try: async () =>
      new Map(
        await Promise.all(
          parsed.keys.map(async ([version, key]) => {
            try {
              return [
                version,
                await crypto.subtle.importKey(
                  "raw",
                  key,
                  { name: "AES-GCM" },
                  false,
                  ["encrypt", "decrypt"],
                ),
              ] as const;
            } finally {
              key.fill(0);
            }
          }),
        ),
      ),
    catch: () => new ConfigEncryptionUnavailable(),
  });
  return {
    activeVersion: parsed.activeVersion,
    keys: imported,
  } satisfies ConfigEncryptionKeyring;
});

const additionalData = (context: ConfigEncryptionContext) =>
  new TextEncoder().encode(JSON.stringify({ version: 1, ...context }));

const nonce = (): Uint8Array<ArrayBuffer> =>
  crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));

export const encryptConfigValue = Effect.fn("encryptConfigValue")(function* (
  keyring: ConfigEncryptionKeyring,
  context: ConfigEncryptionContext,
  plaintext: string,
) {
  const masterKey = keyring.keys.get(keyring.activeVersion);
  if (masterKey === undefined) return yield* new ConfigEncryptionUnavailable();
  return yield* Effect.tryPromise({
    try: async () => {
      const dataKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const valueNonce = nonce();
      const wrappedKeyNonce = nonce();
      const aad = additionalData(context);
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: valueNonce, additionalData: aad },
        dataKey,
        new TextEncoder().encode(plaintext),
      );
      const rawDataKey = new Uint8Array(
        await crypto.subtle.exportKey("raw", dataKey),
      );
      try {
        const wrappedKey = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: wrappedKeyNonce, additionalData: aad },
          masterKey,
          rawDataKey,
        );
        return {
          version: 1,
          keyVersion: keyring.activeVersion,
          valueNonce: bytesToBase64(valueNonce),
          ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
          wrappedKeyNonce: bytesToBase64(wrappedKeyNonce),
          wrappedKey: bytesToBase64(new Uint8Array(wrappedKey)),
        } satisfies ConfigValueEnvelope;
      } finally {
        rawDataKey.fill(0);
      }
    },
    catch: () => new ConfigEncryptionUnavailable(),
  });
});

export const decryptConfigValue = Effect.fn("decryptConfigValue")(function* (
  keyring: ConfigEncryptionKeyring,
  context: ConfigEncryptionContext,
  envelope: ConfigValueEnvelope,
) {
  const masterKey = keyring.keys.get(envelope.keyVersion);
  if (masterKey === undefined) return yield* new ConfigEncryptionUnavailable();
  return yield* Effect.tryPromise({
    try: async () => {
      const aad = additionalData(context);
      const rawDataKey = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: base64ToBytes(envelope.wrappedKeyNonce),
            additionalData: aad,
          },
          masterKey,
          base64ToBytes(envelope.wrappedKey),
        ),
      );
      try {
        const dataKey = await crypto.subtle.importKey(
          "raw",
          rawDataKey,
          { name: "AES-GCM" },
          false,
          ["decrypt"],
        );
        const plaintext = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: base64ToBytes(envelope.valueNonce),
            additionalData: aad,
          },
          dataKey,
          base64ToBytes(envelope.ciphertext),
        );
        return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      } finally {
        rawDataKey.fill(0);
      }
    },
    catch: () => new ConfigEncryptionUnavailable(),
  });
});
