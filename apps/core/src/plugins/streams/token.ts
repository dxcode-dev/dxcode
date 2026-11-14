import type { Bindings } from "../../http/types.js";

/**
 * A stream's signed producer URL (`PluginStream.url`): one stream, the
 * producer side only, connecting once (its nonce is spent by the relay),
 * for ten minutes. The token is never logged; log lines name the stream.
 */

export const STREAM_URL_TTL_MS = 10 * 60_000;

export interface StreamClaims {
  readonly threadId: string;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly paneId: string;
  readonly tier: string;
  readonly bytesPerSecond: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
}

const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

/** An HMAC key of its own, derived from the deployment's auth secret. */
const signingKey = (bindings: Bindings) => {
  const secret = bindings.BETTER_AUTH_SECRET;
  if (secret === undefined || secret === "")
    throw new Error("This deployment cannot sign stream URLs.");
  let key = keys.get(secret);
  if (key === undefined) {
    key = crypto.subtle
      .importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"])
      .then((base) =>
        crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(),
            info: encoder.encode("dx plugin stream producer url v1"),
          },
          base,
          { name: "HMAC", hash: "SHA-256", length: 256 },
          false,
          ["sign", "verify"],
        ),
      );
    keys.set(secret, key);
  }
  return key;
};

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const fromBase64url = (text: string) =>
  Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0),
  );

export const signStreamToken = async (
  bindings: Bindings,
  claims: Omit<StreamClaims, "issuedAt" | "expiresAt" | "nonce">,
  now = Date.now(),
): Promise<{ token: string; claims: StreamClaims }> => {
  const full: StreamClaims = {
    ...claims,
    issuedAt: now,
    expiresAt: now + STREAM_URL_TTL_MS,
    nonce: crypto.randomUUID(),
  };
  const body = base64url(encoder.encode(JSON.stringify(full)));
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await signingKey(bindings),
      encoder.encode(body),
    ),
  );
  return { token: `${body}.${base64url(signature)}`, claims: full };
};

/** The token's claims when its signature holds; expiry is the relay's. */
export const verifyStreamToken = async (
  bindings: Bindings,
  token: string,
): Promise<StreamClaims | undefined> => {
  const [body, signature, extra] = token.split(".");
  if (body === undefined || signature === undefined || extra !== undefined)
    return undefined;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(bindings),
      fromBase64url(signature),
      encoder.encode(body),
    );
    if (!valid) return undefined;
    const claims = JSON.parse(
      new TextDecoder().decode(fromBase64url(body)),
    ) as StreamClaims;
    return typeof claims.threadId === "string" &&
      typeof claims.pluginId === "string" &&
      typeof claims.paneId === "string" &&
      typeof claims.nonce === "string" &&
      Number.isSafeInteger(claims.expiresAt)
      ? claims
      : undefined;
  } catch {
    return undefined;
  }
};
