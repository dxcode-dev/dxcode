// Portal signing keys derive from BETTER_AUTH_SECRET with HKDF and a
// Portal-only label, so a Portal cookie can never verify as a Better Auth
// value or the reverse, and no extra deployment secret has to be provisioned
// for both the Core and Portal Workers. Rotating the auth secret signs every
// Portal visitor out, which the 12-hour cookie lifetime bounds anyway.

const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const fromBase64Url = (value: string) => {
  const binary = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - (value.length % 4)) % 4),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const encodeBase64Url = (value: string) =>
  base64Url(encoder.encode(value));

export const decodeBase64Url = (value: string) => {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      fromBase64Url(value),
    );
  } catch {
    return undefined;
  }
};

const derive = async (secret: string) => {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("dx-portal"),
      info: encoder.encode("dx portal session v1"),
    },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
};

/** The HMAC key for Portal cookies, or undefined without an auth secret. */
export const portalSigningKey = (secret: string | undefined) => {
  if (secret === undefined || secret.length < 32) return undefined;
  let key = keys.get(secret);
  if (key === undefined) {
    key = derive(secret);
    keys.set(secret, key);
  }
  return key;
};

export const signValue = async (key: CryptoKey, value: string) =>
  base64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
    ),
  );

export const verifyValue = async (
  key: CryptoKey,
  value: string,
  signature: string,
) => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  return crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(signature),
    encoder.encode(value),
  );
};

/** 256 random bits, URL-safe: Portal handshake states and codes. */
export const randomToken = () =>
  base64Url(crypto.getRandomValues(new Uint8Array(32)));

export const RANDOM_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const sha256Hex = async (value: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
