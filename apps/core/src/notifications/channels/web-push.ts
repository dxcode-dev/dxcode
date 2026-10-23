/**
 * Web Push on WebCrypto alone: message encryption (RFC 8291 with the
 * `aes128gcm` content encoding of RFC 8188) and the VAPID application-server
 * identification of RFC 8292. Workers' WebCrypto has every primitive these
 * need — ECDH on P-256, HKDF through HMAC-SHA-256, AES-128-GCM, and ECDSA —
 * so dx carries no push library.
 *
 * What a push service sees is a random salt, an ephemeral public key, and
 * ciphertext. Only the browser that subscribed holds the private key and the
 * authentication secret that unwrap it.
 */

const utf8 = new TextEncoder();

export const base64UrlToBytes = (value: string): Uint8Array => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

/** One HKDF step: extract with `salt`, expand `info` to `length` bytes. */
const hkdf = async (
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
) => {
  const extractKey = await crypto.subtle.importKey(
    "raw",
    salt as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prk = new Uint8Array(
    await crypto.subtle.sign("HMAC", extractKey, ikm as BufferSource),
  );
  const expandKey = await crypto.subtle.importKey(
    "raw",
    prk as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expanded = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      expandKey,
      concat(info, Uint8Array.of(1)) as BufferSource,
    ),
  );
  return expanded.slice(0, length);
};

/** The device half of a push subscription, as the browser reports it. */
export interface PushDeviceKeys {
  /** The device's ECDH P-256 public key, base64url (65 raw bytes). */
  readonly p256dh: string;
  /** The device's authentication secret, base64url (16 raw bytes). */
  readonly auth: string;
}

/** Record size: one message per record, so the body is a single record. */
const RECORD_SIZE = 4_096;
const HEADER_BYTES = 16 + 4 + 1 + 65;
const GCM_TAG_BYTES = 16;
/** Longest plaintext that still fits one 4 096-byte record, delimiter included. */
export const PUSH_PAYLOAD_LIMIT =
  RECORD_SIZE - HEADER_BYTES - GCM_TAG_BYTES - 1;

export class PushEncryptionError extends Error {}

/**
 * Encrypts one message to one device. The returned bytes are the complete
 * `aes128gcm` body: salt, record size, the ephemeral public key, and the
 * ciphertext of the payload plus its `0x02` final-record delimiter.
 */
export const encryptPushMessage = async (
  device: PushDeviceKeys,
  payload: string,
  // Injected only so a test can reproduce a known record; production never
  // passes them.
  deterministic?: {
    readonly salt: Uint8Array;
    readonly serverKeys: CryptoKeyPair;
  },
): Promise<Uint8Array> => {
  const plaintext = utf8.encode(payload);
  if (plaintext.length > PUSH_PAYLOAD_LIMIT)
    throw new PushEncryptionError("Push payload is too long for one record.");
  const devicePublicKeyBytes = base64UrlToBytes(device.p256dh);
  const authSecret = base64UrlToBytes(device.auth);
  if (devicePublicKeyBytes.length !== 65 || devicePublicKeyBytes[0] !== 4)
    throw new PushEncryptionError("Push device key is not a P-256 point.");
  if (authSecret.length !== 16)
    throw new PushEncryptionError("Push device secret is not 16 bytes.");
  const devicePublicKey = await crypto.subtle
    .importKey(
      "raw",
      devicePublicKeyBytes as BufferSource,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    )
    .catch(() => {
      throw new PushEncryptionError("Push device key could not be imported.");
    });
  const serverKeys =
    deterministic?.serverKeys ??
    ((await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    )) as CryptoKeyPair);
  const serverPublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", serverKeys.publicKey),
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: devicePublicKey },
      serverKeys.privateKey,
      256,
    ),
  );
  // RFC 8291 §3.3: the authentication secret keys the first HKDF, and the
  // info binds the derived key to both parties' public keys.
  const ikm = await hkdf(
    authSecret,
    sharedSecret,
    concat(
      utf8.encode("WebPush: info\0"),
      devicePublicKeyBytes,
      serverPublicKey,
    ),
    32,
  );
  const salt =
    deterministic?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const contentEncryptionKey = await hkdf(
    salt,
    ikm,
    utf8.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    utf8.encode("Content-Encoding: nonce\0"),
    12,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    contentEncryptionKey as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      key,
      concat(plaintext, Uint8Array.of(2)) as BufferSource,
    ),
  );
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE);
  return concat(
    salt,
    recordSize,
    Uint8Array.of(serverPublicKey.length),
    serverPublicKey,
    ciphertext,
  );
};

/** The deployment's VAPID identity: one P-256 key pair, both base64url. */
export interface VapidKeys {
  /** The uncompressed public key (65 bytes); browsers subscribe with it. */
  readonly publicKey: string;
  /** The private scalar (32 bytes). */
  readonly privateKey: string;
}

const importVapidSigningKey = async (keys: VapidKeys) => {
  const publicKey = base64UrlToBytes(keys.publicKey);
  const privateKey = base64UrlToBytes(keys.privateKey);
  if (publicKey.length !== 65 || publicKey[0] !== 4 || privateKey.length !== 32)
    throw new PushEncryptionError("VAPID key pair is malformed.");
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: bytesToBase64Url(publicKey.slice(1, 33)),
      y: bytesToBase64Url(publicKey.slice(33, 65)),
      d: bytesToBase64Url(privateKey),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
};

/** How long a VAPID token stays valid; RFC 8292 allows at most 24 hours. */
const VAPID_TOKEN_SECONDS = 12 * 60 * 60;

/**
 * The `Authorization` header for one push service: an ES256 JWT naming that
 * service as the audience and the deployment as the subject, beside the
 * public key that verifies it.
 */
export const vapidAuthorization = async (
  keys: VapidKeys,
  input: {
    /** Scheme and host of the endpoint, as RFC 8292 requires. */
    readonly audience: string;
    /** `https:` or `mailto:` contact for the deployment. */
    readonly subject: string;
    readonly now?: Date;
  },
): Promise<string> => {
  const issuedAt = Math.floor((input.now?.getTime() ?? Date.now()) / 1_000);
  const header = bytesToBase64Url(
    utf8.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const payload = bytesToBase64Url(
    utf8.encode(
      JSON.stringify({
        aud: input.audience,
        exp: issuedAt + VAPID_TOKEN_SECONDS,
        sub: input.subject,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      await importVapidSigningKey(keys),
      utf8.encode(signingInput) as BufferSource,
    ),
  );
  return `vapid t=${signingInput}.${bytesToBase64Url(signature)}, k=${keys.publicKey}`;
};

export interface PushTarget extends PushDeviceKeys {
  readonly endpoint: string;
}

export type PushResult =
  /** The push service accepted the message. */
  | { readonly status: "sent" }
  /** The subscription is gone (404/410); stop using it. */
  | { readonly status: "expired" }
  | { readonly status: "failed"; readonly code: string };

/**
 * Encrypts the payload to the device and hands it to the device's push
 * service. Never throws: every outcome is a `PushResult` the caller records.
 */
export const sendPushMessage = async (
  keys: VapidKeys,
  target: PushTarget,
  payload: string,
  options: { readonly subject: string; readonly ttlSeconds?: number },
): Promise<PushResult> => {
  let body: Uint8Array;
  let authorization: string;
  try {
    const endpoint = new URL(target.endpoint);
    body = await encryptPushMessage(target, payload);
    authorization = await vapidAuthorization(keys, {
      audience: endpoint.origin,
      subject: options.subject,
    });
  } catch (cause) {
    return {
      status: "failed",
      code: cause instanceof PushEncryptionError ? "encryption" : "unexpected",
    };
  }
  let response: Response;
  try {
    response = await fetch(target.endpoint, {
      method: "POST",
      headers: {
        authorization,
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(options.ttlSeconds ?? 86_400),
        urgency: "normal",
      },
      body: body as BodyInit,
    });
  } catch {
    return { status: "failed", code: "unreachable" };
  }
  if (response.ok) return { status: "sent" };
  if (response.status === 404 || response.status === 410)
    return { status: "expired" };
  return { status: "failed", code: `http_${response.status}` };
};
