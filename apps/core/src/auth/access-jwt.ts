import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AccessIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  readonly name: string;
  readonly issuedAt: number;
}

export const ACCESS_ASSERTION_FRESHNESS_MS = 5 * 60 * 1_000;

export const isFreshAccessIdentity = (
  identity: AccessIdentity,
  now = Date.now(),
): boolean => {
  const issuedAt = identity.issuedAt * 1_000;
  return (
    issuedAt <= now + 30_000 && now - issuedAt < ACCESS_ASSERTION_FRESHNESS_MS
  );
};

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const jwksFor = (issuer: string) => {
  const existing = jwksByIssuer.get(issuer);
  if (existing !== undefined) return existing;
  const jwks = createRemoteJWKSet(
    new URL("/cdn-cgi/access/certs", `${issuer}/`),
  );
  jwksByIssuer.set(issuer, jwks);
  return jwks;
};

const normalizedEmail = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  if (
    email.length === 0 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return undefined;
  }
  return email;
};

export const verifyAccessAssertion = async (
  assertion: string,
  issuer: string,
  audience: string,
  getKey: JWTVerifyGetKey = jwksFor(issuer),
): Promise<AccessIdentity> => {
  const { payload, protectedHeader } = await jwtVerify(assertion, getKey, {
    algorithms: ["RS256"],
    issuer,
    audience,
    requiredClaims: ["sub", "email", "exp", "iat", "type"],
  });
  const email = normalizedEmail(payload.email);
  if (
    protectedHeader.alg !== "RS256" ||
    payload.type !== "app" ||
    typeof payload.sub !== "string" ||
    payload.sub.length === 0 ||
    payload.sub.length > 512 ||
    typeof payload.iat !== "number" ||
    !Number.isFinite(payload.iat) ||
    email === undefined
  ) {
    throw new Error("Cloudflare Access assertion claims are invalid.");
  }
  const name =
    typeof payload.name === "string" && payload.name.trim().length > 0
      ? payload.name.trim().slice(0, 128)
      : email;
  return {
    issuer,
    subject: payload.sub,
    email,
    name,
    issuedAt: payload.iat,
  };
};

export const accessUserId = async (
  issuer: string,
  subject: string,
): Promise<string> => {
  const encoded = new TextEncoder().encode(
    `${issuer.length}:${issuer}${subject.length}:${subject}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  const value = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `usr_${value}`;
};
