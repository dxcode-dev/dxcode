import type { Bindings } from "../../http/types.js";

/**
 * A browser's right to hear one view's state changes on the realtime
 * connection, for a while. The state route issues it after checking the
 * person may see the view; the realtime hub checks the signature, so it
 * reads nothing to authorize a watch. The token is never logged.
 */

export const VIEW_WATCH_TTL_MS = 6 * 60 * 60_000;

export interface ViewWatchClaims {
  /** The person the token was issued to. */
  readonly userId: string;
  /** `<install id>/<view id>`. */
  readonly key: string;
  readonly expiresAt: number;
}

const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

/** An HMAC key of its own, derived from the deployment's auth secret. */
const signingKey = (bindings: Pick<Bindings, "BETTER_AUTH_SECRET">) => {
  const secret = bindings.BETTER_AUTH_SECRET;
  if (secret === undefined || secret === "")
    throw new Error("This deployment cannot sign view watches.");
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
            info: encoder.encode("dx plugin view watch v1"),
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

export const viewStateKey = (installId: string, viewId: string) =>
  `${installId}/${viewId}`;

export const signViewWatch = async (
  bindings: Pick<Bindings, "BETTER_AUTH_SECRET">,
  claims: Omit<ViewWatchClaims, "expiresAt">,
  now = Date.now(),
): Promise<string> => {
  const body = base64url(
    encoder.encode(
      JSON.stringify({ ...claims, expiresAt: now + VIEW_WATCH_TTL_MS }),
    ),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await signingKey(bindings),
      encoder.encode(body),
    ),
  );
  return `${body}.${base64url(signature)}`;
};

/** The claims when the signature holds and the token has not expired. */
export const verifyViewWatch = async (
  bindings: Pick<Bindings, "BETTER_AUTH_SECRET">,
  token: unknown,
  now = Date.now(),
): Promise<ViewWatchClaims | undefined> => {
  if (typeof token !== "string" || token.length > 2_048) return undefined;
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
    ) as ViewWatchClaims;
    return typeof claims.userId === "string" &&
      typeof claims.key === "string" &&
      claims.key.length <= 200 &&
      Number.isSafeInteger(claims.expiresAt) &&
      claims.expiresAt > now
      ? claims
      : undefined;
  } catch {
    return undefined;
  }
};
