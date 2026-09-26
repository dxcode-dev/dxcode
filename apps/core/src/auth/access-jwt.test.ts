import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  accessUserId,
  isFreshAccessIdentity,
  verifyAccessAssertion,
} from "./access-jwt.js";

const issuer = "https://example.cloudflareaccess.com";
const audience = "dx-access-audience";
let privateKey: CryptoKey;
let alternatePrivateKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const primary = await generateKeyPair("RS256");
  const alternate = await generateKeyPair("RS256");
  privateKey = primary.privateKey;
  alternatePrivateKey = alternate.privateKey;
  jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(primary.publicKey)), kid: "primary" }],
  });
});

const assertion = async (
  overrides: JWTPayload = {},
  key = privateKey,
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    sub: "access-subject",
    email: " Person@Example.COM ",
    name: "Person",
    type: "app",
    iss: issuer,
    aud: audience,
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    ...overrides,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "primary" })
    .sign(key);
};

describe("Cloudflare Access assertions", () => {
  it("validates cryptography and normalizes verified profile data", async () => {
    await expect(
      verifyAccessAssertion(await assertion(), issuer, audience, jwks),
    ).resolves.toEqual({
      issuer,
      subject: "access-subject",
      email: "person@example.com",
      name: "Person",
      issuedAt: expect.any(Number),
    });
  });

  it.each([
    ["issuer", { iss: "https://other.cloudflareaccess.com" }],
    ["audience", { aud: "other-audience" }],
    ["expiration", { exp: 1 }],
    ["not-before", { nbf: Math.floor(Date.now() / 1000) + 300 }],
    ["subject", { sub: "" }],
    ["email", { email: "not-an-email" }],
    ["token type", { type: "org" }],
  ])("rejects an invalid %s", async (_label, overrides) => {
    await expect(
      verifyAccessAssertion(await assertion(overrides), issuer, audience, jwks),
    ).rejects.toBeDefined();
  });

  it("rejects an invalid signature", async () => {
    await expect(
      verifyAccessAssertion(
        await assertion({}, alternatePrivateKey),
        issuer,
        audience,
        jwks,
      ),
    ).rejects.toBeDefined();
  });

  it("derives stable, unambiguous user IDs from issuer and subject", async () => {
    const first = await accessUserId("https://issuer-a", "bc");
    expect(await accessUserId("https://issuer-a", "bc")).toBe(first);
    expect(await accessUserId("https://issuer-ab", "c")).not.toBe(first);
  });

  it("accepts only freshly issued Access identities for step-up authentication", () => {
    const now = Date.now();
    const identity = {
      issuer,
      subject: "access-subject",
      email: "person@example.com",
      name: "Person",
      issuedAt: Math.floor(now / 1_000),
    };
    expect(isFreshAccessIdentity(identity, now)).toBe(true);
    expect(
      isFreshAccessIdentity(
        { ...identity, issuedAt: Math.floor((now - 5 * 60 * 1_000) / 1_000) },
        now,
      ),
    ).toBe(false);
    expect(
      isFreshAccessIdentity(
        { ...identity, issuedAt: Math.floor((now + 31_000) / 1_000) },
        now,
      ),
    ).toBe(false);
  });
});
