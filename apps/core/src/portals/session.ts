// Portal session cookies. Each Portal host gets its own host-only `__Host-`
// cookies, so one Portal can neither read nor plant another's:
// - `__Host-dx_portal`: SameSite=Lax, for top-level visits;
// - `__Host-dx_portal_embed`: SameSite=None; Partitioned, for the Portal
//   framed inside the dx app (CHIPS keeps it in the app's partition);
// - `__Host-dx_portal_state`: the 5-minute handshake state, SameSite=None;
//   Partitioned so the handshake also completes inside the frame;
// - `__Host-dx_portal_public`: SameSite=Lax, an anonymous visitor's
//   acknowledgement of a public Portal's first-visit page, for one link.
// The session value is `v1.<payload>.<HMAC>` and names the Portal host, the dx user
// and session, and when access was last checked against D1.

import {
  decodeBase64Url,
  encodeBase64Url,
  signValue,
  verifyValue,
} from "./crypto.js";

export const PORTAL_STATE_COOKIE = "__Host-dx_portal_state";
export const PORTAL_TOP_COOKIE = "__Host-dx_portal";
export const PORTAL_EMBED_COOKIE = "__Host-dx_portal_embed";
export const PORTAL_PUBLIC_COOKIE = "__Host-dx_portal_public";
export const PORTAL_COOKIE_PREFIX = "__Host-dx_portal";

export const PORTAL_SESSION_SECONDS = 12 * 60 * 60;
export const PORTAL_STATE_SECONDS = 5 * 60;
/** Access older than this is checked again before the request goes on. */
export const PORTAL_RECHECK_SECONDS = 5 * 60;
/** How long a public visitor skips the first-visit page, at most. */
export const PORTAL_PUBLIC_ACK_SECONDS = 60 * 60;

export interface PortalSession {
  /** Lowercase `host[:port]` of the one Portal this session opens. */
  readonly host: string;
  readonly userId: string;
  /** The dx (Better Auth) session the handshake ran under. */
  readonly sessionId: string;
  readonly email?: string;
  readonly name?: string;
  /** Unix seconds. */
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly checkedAt: number;
}

interface Payload {
  readonly v: 1;
  readonly h: string;
  readonly u: string;
  readonly s: string;
  readonly e?: string;
  readonly n?: string;
  readonly iat: number;
  readonly exp: number;
  readonly chk: number;
}

export const encodePortalSession = async (
  key: CryptoKey,
  session: PortalSession,
) => {
  const payload: Payload = {
    v: 1,
    h: session.host,
    u: session.userId,
    s: session.sessionId,
    ...(session.email === undefined ? {} : { e: session.email }),
    ...(session.name === undefined ? {} : { n: session.name }),
    iat: session.issuedAt,
    exp: session.expiresAt,
    chk: session.checkedAt,
  };
  const body = `v1.${encodeBase64Url(JSON.stringify(payload))}`;
  return `${body}.${await signValue(key, body)}`;
};

const TEXT_LIMIT = 512;
const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= TEXT_LIMIT;

/**
 * The email and name a session cookie may carry, bounded at sign-in as the
 * cookie decoder bounds them: a longer name is cut at a character boundary,
 * and an email that does not fit is left out rather than cut into another
 * address.
 */
export const portalIdentityText = (email: unknown, name: unknown) => {
  let bounded = "";
  if (typeof name === "string")
    for (const character of name) {
      if (bounded.length + character.length > TEXT_LIMIT) break;
      bounded += character;
    }
  return {
    ...(isString(email) ? { email } : {}),
    ...(bounded === "" ? {} : { name: bounded }),
  };
};
const isSeconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** The session in a cookie value, if it is signed, unexpired, and for `host`. */
export const decodePortalSession = async (
  key: CryptoKey,
  value: string,
  host: string,
  nowSeconds: number,
): Promise<PortalSession | undefined> => {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return undefined;
  const [version, encoded, signature] = parts as [string, string, string];
  if (!(await verifyValue(key, `${version}.${encoded}`, signature)))
    return undefined;
  const json = decodeBase64Url(encoded);
  if (json === undefined) return undefined;
  let payload: Partial<Payload>;
  try {
    payload = JSON.parse(json) as Partial<Payload>;
  } catch {
    return undefined;
  }
  if (
    payload.v !== 1 ||
    payload.h !== host ||
    !isString(payload.u) ||
    !isString(payload.s) ||
    (payload.e !== undefined && !isString(payload.e)) ||
    (payload.n !== undefined && !isString(payload.n)) ||
    !isSeconds(payload.iat) ||
    !isSeconds(payload.exp) ||
    !isSeconds(payload.chk) ||
    payload.exp <= nowSeconds ||
    payload.exp - payload.iat > PORTAL_SESSION_SECONDS ||
    payload.iat > nowSeconds + 60
  )
    return undefined;
  return {
    host: payload.h,
    userId: payload.u,
    sessionId: payload.s,
    ...(payload.e === undefined ? {} : { email: payload.e }),
    ...(payload.n === undefined ? {} : { name: payload.n }),
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    checkedAt: payload.chk,
  };
};

export const parseCookies = (header: string | null) =>
  (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const separator = part.indexOf("=");
      return separator === -1
        ? ([part, ""] as const)
        : ([
            part.slice(0, separator).trim(),
            part.slice(separator + 1).trim(),
          ] as const);
    });

export const readCookie = (header: string | null, name: string) =>
  parseCookies(header).find(([candidate]) => candidate === name)?.[1];

// dx's own credentials never reach a guest: Portal cookies, and Better Auth
// session cookies in case a browser ever scopes one to the Portal host.
const DX_COOKIE =
  /^(?:__Host-dx_portal|(?:__Secure-)?better-auth\.|(?:__Secure-)?dx-local-[0-9]+\.)/;

export const isDxCookieName = (name: string) => DX_COOKIE.test(name);

/** The Cookie header for the guest: every cookie except dx's own. */
export const guestCookieHeader = (header: string | null) => {
  const kept = parseCookies(header)
    .filter(([name]) => !isDxCookieName(name))
    .map(([name, value]) => (value === "" ? name : `${name}=${value}`));
  return kept.length === 0 ? undefined : kept.join("; ");
};

export type PortalCookieKind = "top" | "embed" | "state" | "public";

const cookieName = (kind: PortalCookieKind) =>
  kind === "top"
    ? PORTAL_TOP_COOKIE
    : kind === "embed"
      ? PORTAL_EMBED_COOKIE
      : kind === "public"
        ? PORTAL_PUBLIC_COOKIE
        : PORTAL_STATE_COOKIE;

/** A Set-Cookie value; `__Host-` requires Secure, Path=/, and no Domain. */
export const portalSetCookie = (
  kind: PortalCookieKind,
  value: string,
  maxAgeSeconds: number,
) =>
  [
    `${cookieName(kind)}=${value}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    kind === "top" || kind === "public"
      ? "SameSite=Lax"
      : "SameSite=None; Partitioned",
  ].join("; ");

export const clearPortalCookie = (kind: PortalCookieKind) =>
  portalSetCookie(kind, "", 0);

// A public visitor's acknowledgement: `p1.<payload>.<HMAC>` naming the host,
// the public link it was given for, and its expiry. The `p1` prefix keeps it
// from ever decoding as a session, and a session from decoding as this.

/** A signed acknowledgement of `linkId` on `host` until `expiresAt` (seconds). */
export const encodePublicAcknowledgement = async (
  key: CryptoKey,
  host: string,
  linkId: string,
  expiresAt: number,
) => {
  const body = `p1.${encodeBase64Url(JSON.stringify({ h: host, l: linkId, exp: expiresAt }))}`;
  return `${body}.${await signValue(key, body)}`;
};

/** Whether the request carries a live acknowledgement of this host's link. */
export const hasPublicAcknowledgement = async (
  key: CryptoKey,
  header: string | null,
  host: string,
  linkId: string,
  nowSeconds: number,
) => {
  const value = readCookie(header, PORTAL_PUBLIC_COOKIE);
  const parts = value?.split(".") ?? [];
  if (parts.length !== 3 || parts[0] !== "p1") return false;
  const [version, encoded, signature] = parts as [string, string, string];
  if (!(await verifyValue(key, `${version}.${encoded}`, signature)))
    return false;
  const json = decodeBase64Url(encoded);
  if (json === undefined) return false;
  try {
    const payload = JSON.parse(json) as {
      readonly h?: unknown;
      readonly l?: unknown;
      readonly exp?: unknown;
    };
    return (
      payload.h === host &&
      payload.l === linkId &&
      isSeconds(payload.exp) &&
      payload.exp > nowSeconds &&
      payload.exp <= nowSeconds + PORTAL_PUBLIC_ACK_SECONDS
    );
  } catch {
    return false;
  }
};
