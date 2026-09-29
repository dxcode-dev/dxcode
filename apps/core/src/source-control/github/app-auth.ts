import type { GITHUB_APP_REPOSITORY_PERMISSIONS } from "@dx/domain";
import { importPKCS8, SignJWT } from "jose";
import { decodeBase64, encodeBase64 } from "../../encoding/base64.js";

const bytesFromPem = (pem: string) => {
  const base64 = pem
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("-----"))
    .join("");
  return decodeBase64(base64);
};

const derLength = (length: number): Uint8Array => {
  if (length < 128) return Uint8Array.of(length);
  const values: number[] = [];
  for (let value = length; value > 0; value >>= 8) values.unshift(value & 0xff);
  return Uint8Array.of(0x80 | values.length, ...values);
};

const sequence = (...parts: ReadonlyArray<Uint8Array>) => {
  const body = Uint8Array.from(parts.flatMap((part) => [...part]));
  return Uint8Array.of(0x30, ...derLength(body.length), ...body);
};

const pkcs8Pem = (pem: string) => {
  if (pem.includes("BEGIN PRIVATE KEY")) return pem;
  const rsa = bytesFromPem(pem);
  const algorithm = Uint8Array.of(
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  );
  const octetString = Uint8Array.of(0x04, ...derLength(rsa.length), ...rsa);
  const wrapped = sequence(
    Uint8Array.of(0x02, 0x01, 0x00),
    algorithm,
    octetString,
  );
  const base64 = encodeBase64(wrapped);
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
};

export const createGitHubAppJwt = async (input: {
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly now?: Date;
}) => {
  const now = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  const key = await importPKCS8(pkcs8Pem(input.privateKeyPem), "RS256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(input.appId)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .sign(key);
};

export const encodeInstallationTokenRequest = (input: {
  readonly repositoryId: string;
  readonly permissions: Partial<typeof GITHUB_APP_REPOSITORY_PERMISSIONS>;
}) => {
  const repositoryId = Number(input.repositoryId);
  if (
    !/^[1-9][0-9]{0,15}$/.test(input.repositoryId) ||
    !Number.isSafeInteger(repositoryId)
  ) {
    throw new TypeError("Invalid GitHub repository ID.");
  }
  return {
    repository_ids: [repositoryId],
    permissions: input.permissions,
  };
};
