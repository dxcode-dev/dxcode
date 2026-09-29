import {
  SigningKeyFingerprint,
  SigningPrivateKeyPlaintext,
  SigningPublicKey,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { decodeBase64, encodeBase64 } from "../../encoding/base64.js";

const OPENSSH_MAGIC = new TextEncoder().encode("openssh-key-v1\0");
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);
const ED25519_KEY_BYTES = 32;
const OPENSSH_BLOCK_BYTES = 8;

export class InvalidSshPublicKey extends Schema.TaggedError<InvalidSshPublicKey>()(
  "InvalidSshPublicKey",
  {},
) {}

export class SigningKeyGenerationUnavailable extends Schema.TaggedError<SigningKeyGenerationUnavailable>()(
  "SigningKeyGenerationUnavailable",
  {},
) {}

export class SigningOperationUnavailable extends Schema.TaggedError<SigningOperationUnavailable>()(
  "SigningOperationUnavailable",
  {},
) {}

const concat = (...values: ReadonlyArray<Uint8Array>): Uint8Array => {
  const output = new Uint8Array(
    values.reduce((length, value) => length + value.byteLength, 0),
  );
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
};

const uint32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
};

const sshString = (value: string | Uint8Array): Uint8Array => {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return concat(uint32(bytes.byteLength), bytes);
};

// Every caller re-encodes and compares, rejecting non-canonical input.
const base64ToBytes = (value: string): Uint8Array => decodeBase64(value);

const readSshString = (
  bytes: Uint8Array,
  offset: number,
): { readonly value: Uint8Array; readonly offset: number } => {
  if (offset + 4 > bytes.byteLength) throw new InvalidSshPublicKey();
  const length = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    4,
  ).getUint32(0, false);
  const start = offset + 4;
  const end = start + length;
  if (end > bytes.byteLength) throw new InvalidSshPublicKey();
  return { value: bytes.slice(start, end), offset: end };
};

const publicBlob = (rawPublicKey: Uint8Array): Uint8Array =>
  concat(sshString("ssh-ed25519"), sshString(rawPublicKey));

const decodePublicBlob = (encoded: string): Uint8Array => {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(encoded);
  } catch {
    throw new InvalidSshPublicKey();
  }
  if (encodeBase64(bytes) !== encoded) throw new InvalidSshPublicKey();
  const algorithm = readSshString(bytes, 0);
  const key = readSshString(bytes, algorithm.offset);
  if (
    new TextDecoder().decode(algorithm.value) !== "ssh-ed25519" ||
    key.value.byteLength !== ED25519_KEY_BYTES ||
    key.offset !== bytes.byteLength
  ) {
    throw new InvalidSshPublicKey();
  }
  return bytes;
};

export const canonicalizeSigningPublicKey = Effect.fn(
  "canonicalizeSigningPublicKey",
)(function* (input: string) {
  const line = input.trim();
  if (line.includes("\n") || line.includes("\r")) {
    return yield* new InvalidSshPublicKey();
  }
  const [algorithm, encoded] = line.split(/[\t ]+/);
  if (algorithm !== "ssh-ed25519" || encoded === undefined) {
    return yield* new InvalidSshPublicKey();
  }
  const blob = yield* Effect.try({
    try: () => decodePublicBlob(encoded),
    catch: () => new InvalidSshPublicKey(),
  });
  const publicKey = yield* Schema.decodeUnknownEffect(SigningPublicKey)(
    `ssh-ed25519 ${encodeBase64(blob)}`,
  ).pipe(Effect.mapError(() => new InvalidSshPublicKey()));
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", Uint8Array.from(blob)),
    catch: () => new InvalidSshPublicKey(),
  });
  const fingerprint = yield* Schema.decodeUnknownEffect(SigningKeyFingerprint)(
    `SHA256:${encodeBase64(new Uint8Array(digest)).replace(/=+$/, "")}`,
  ).pipe(Effect.mapError(() => new InvalidSshPublicKey()));
  return { publicKey, fingerprint };
});

const privatePem = (seed: Uint8Array, rawPublicKey: Uint8Array): string => {
  const check = crypto.getRandomValues(new Uint8Array(4));
  const blob = publicBlob(rawPublicKey);
  let privateBlock = concat(
    check,
    check,
    sshString("ssh-ed25519"),
    sshString(rawPublicKey),
    sshString(concat(seed, rawPublicKey)),
    sshString("dx-managed"),
  );
  const paddingLength =
    privateBlock.byteLength % OPENSSH_BLOCK_BYTES === 0
      ? OPENSSH_BLOCK_BYTES
      : OPENSSH_BLOCK_BYTES - (privateBlock.byteLength % OPENSSH_BLOCK_BYTES);
  privateBlock = concat(
    privateBlock,
    Uint8Array.from({ length: paddingLength }, (_, index) => index + 1),
  );
  const encoded = encodeBase64(
    concat(
      OPENSSH_MAGIC,
      sshString("none"),
      sshString("none"),
      sshString(new Uint8Array()),
      uint32(1),
      sshString(blob),
      sshString(privateBlock),
    ),
  );
  const lines = encoded.match(/.{1,70}/g) ?? [];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
};

const seedFromPkcs8 = (pkcs8: Uint8Array): Uint8Array => {
  if (
    pkcs8.byteLength !== ED25519_PKCS8_PREFIX.byteLength + ED25519_KEY_BYTES ||
    !ED25519_PKCS8_PREFIX.every((byte, index) => pkcs8[index] === byte)
  ) {
    throw new SigningKeyGenerationUnavailable();
  }
  return pkcs8.slice(ED25519_PKCS8_PREFIX.byteLength);
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength &&
  left.every((byte, index) => right[index] === byte);

const privateSeed = (
  privateKey: string,
  expectedPublicKey: string,
): Uint8Array => {
  const encoded = privateKey
    .replace("-----BEGIN OPENSSH PRIVATE KEY-----", "")
    .replace("-----END OPENSSH PRIVATE KEY-----", "")
    .replaceAll(/\s/g, "");
  const bytes = base64ToBytes(encoded);
  if (
    encodeBase64(bytes) !== encoded ||
    !equalBytes(bytes.slice(0, OPENSSH_MAGIC.byteLength), OPENSSH_MAGIC)
  ) {
    throw new SigningOperationUnavailable();
  }
  let offset = OPENSSH_MAGIC.byteLength;
  const cipher = readSshString(bytes, offset);
  offset = cipher.offset;
  const kdf = readSshString(bytes, offset);
  offset = kdf.offset;
  const kdfOptions = readSshString(bytes, offset);
  offset = kdfOptions.offset;
  if (offset + 4 > bytes.byteLength) throw new SigningOperationUnavailable();
  const keyCount = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    4,
  ).getUint32(0, false);
  offset += 4;
  const outerPublic = readSshString(bytes, offset);
  offset = outerPublic.offset;
  const privateBlock = readSshString(bytes, offset);
  const expectedEncoded = expectedPublicKey.split(" ")[1];
  if (
    new TextDecoder().decode(cipher.value) !== "none" ||
    new TextDecoder().decode(kdf.value) !== "none" ||
    kdfOptions.value.byteLength !== 0 ||
    keyCount !== 1 ||
    privateBlock.offset !== bytes.byteLength ||
    expectedEncoded === undefined ||
    !equalBytes(outerPublic.value, decodePublicBlob(expectedEncoded))
  ) {
    throw new SigningOperationUnavailable();
  }
  const block = privateBlock.value;
  if (
    block.byteLength < 8 ||
    !equalBytes(block.slice(0, 4), block.slice(4, 8))
  ) {
    throw new SigningOperationUnavailable();
  }
  const algorithm = readSshString(block, 8);
  const rawPublic = readSshString(block, algorithm.offset);
  const rawPrivate = readSshString(block, rawPublic.offset);
  const comment = readSshString(block, rawPrivate.offset);
  const expectedPublic = readSshString(
    outerPublic.value,
    readSshString(outerPublic.value, 0).offset,
  ).value;
  if (
    new TextDecoder().decode(algorithm.value) !== "ssh-ed25519" ||
    rawPublic.value.byteLength !== ED25519_KEY_BYTES ||
    rawPrivate.value.byteLength !== ED25519_KEY_BYTES * 2 ||
    !equalBytes(rawPublic.value, expectedPublic) ||
    !equalBytes(rawPrivate.value.slice(ED25519_KEY_BYTES), rawPublic.value)
  ) {
    throw new SigningOperationUnavailable();
  }
  for (let index = comment.offset; index < block.byteLength; index += 1) {
    if (block[index] !== index - comment.offset + 1) {
      throw new SigningOperationUnavailable();
    }
  }
  return rawPrivate.value.slice(0, ED25519_KEY_BYTES);
};

export const signGitPayload = async (
  privateKey: SigningPrivateKeyPlaintext,
  publicKey: SigningPublicKey,
  payload: Uint8Array,
): Promise<string> => {
  let seed: Uint8Array | undefined;
  let pkcs8: Uint8Array | undefined;
  try {
    seed = privateSeed(privateKey, publicKey);
    pkcs8 = concat(ED25519_PKCS8_PREFIX, seed);
    const signingKey = await crypto.subtle.importKey(
      "pkcs8",
      Uint8Array.from(pkcs8),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-512", Uint8Array.from(payload)),
    );
    const signedData = concat(
      new TextEncoder().encode("SSHSIG"),
      sshString("git"),
      sshString(new Uint8Array()),
      sshString("sha512"),
      sshString(digest),
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        signingKey,
        Uint8Array.from(signedData),
      ),
    );
    const encodedPublicKey = publicKey.split(" ")[1];
    if (encodedPublicKey === undefined) throw new SigningOperationUnavailable();
    const blob = concat(
      new TextEncoder().encode("SSHSIG"),
      uint32(1),
      sshString(decodePublicBlob(encodedPublicKey)),
      sshString("git"),
      sshString(new Uint8Array()),
      sshString("sha512"),
      sshString(concat(sshString("ssh-ed25519"), sshString(signature))),
    );
    const lines = encodeBase64(blob).match(/.{1,76}/g) ?? [];
    return `-----BEGIN SSH SIGNATURE-----\n${lines.join("\n")}\n-----END SSH SIGNATURE-----\n`;
  } catch {
    throw new SigningOperationUnavailable();
  } finally {
    seed?.fill(0);
    pkcs8?.fill(0);
  }
};

export const generateManagedSshKey = Effect.fn("generateManagedSshKey")(
  function* () {
    return yield* Effect.tryPromise({
      try: async () => {
        const pair = await crypto.subtle.generateKey(
          { name: "Ed25519" },
          true,
          ["sign", "verify"],
        );
        if (!("privateKey" in pair)) {
          throw new SigningKeyGenerationUnavailable();
        }
        const pkcs8 = new Uint8Array(
          await crypto.subtle.exportKey("pkcs8", pair.privateKey),
        );
        const rawPublicKey = new Uint8Array(
          await crypto.subtle.exportKey("raw", pair.publicKey),
        );
        const seed = seedFromPkcs8(pkcs8);
        try {
          const canonical = await Effect.runPromise(
            canonicalizeSigningPublicKey(
              `ssh-ed25519 ${encodeBase64(publicBlob(rawPublicKey))}`,
            ),
          );
          const privateKey = Schema.decodeUnknownSync(
            SigningPrivateKeyPlaintext,
          )(privatePem(seed, rawPublicKey));
          return { ...canonical, privateKey };
        } finally {
          pkcs8.fill(0);
          seed.fill(0);
        }
      },
      catch: () => new SigningKeyGenerationUnavailable(),
    });
  },
);
