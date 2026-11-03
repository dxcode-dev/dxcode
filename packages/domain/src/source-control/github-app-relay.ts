/**
 * A GitHub App's callback, setup, and webhook URLs are fixed, but every branch
 * preview has its own origin. A preview's App therefore names one relay
 * origin, and the preview binds each OAuth and setup `state` to its own host
 * with this signature, keyed from the App's webhook secret. The relay
 * verifies the signature and expiry before it sends the browser back to that
 * host, so nobody without the secret can route a ceremony anywhere.
 *
 * Format: `r1.<nonce>.<expires, base-36 seconds>.<mac>.<host>`.
 */

import { GitHubAppConfigurationInvalid } from "./github-app-configuration.js";

const VERSION = "r1";
const NONCE_BYTES = 16;
const MAC_BYTES = 16;
const KEY_LABEL = "dx GitHub App relay state v1";
const HOST =
  /^(?=.{1,64}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const hmac = async (key: Uint8Array<ArrayBuffer>, message: string) =>
  new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey(
        "raw",
        key,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      encoder.encode(message),
    ),
  );

/** The webhook secret keys a derived key, never the state MAC directly. */
const mac = async (webhookSecret: string, payload: string) =>
  base64Url(
    (
      await hmac(await hmac(encoder.encode(webhookSecret), KEY_LABEL), payload)
    ).slice(0, MAC_BYTES),
  );

const equal = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};

/** A fresh state naming `host` that a relay accepts until `expiresAt`. */
export const signGitHubAppRelayState = async (input: {
  readonly webhookSecret: string;
  readonly host: string;
  readonly expiresAt: Date;
}) => {
  const expires = Math.floor(input.expiresAt.getTime() / 1_000);
  if (!HOST.test(input.host) || !Number.isSafeInteger(expires) || expires < 1)
    throw new GitHubAppConfigurationInvalid();
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
  const payload = `${VERSION}.${nonce}.${expires.toString(36)}`;
  return `${payload}.${await mac(input.webhookSecret, `${payload}.${input.host}`)}.${input.host}`;
};

/**
 * The host a state names, when its signature holds, it has not expired, and
 * it expires no later than `maxLifetimeMs` from `now`; otherwise undefined.
 */
export const verifyGitHubAppRelayState = async (input: {
  readonly webhookSecret: string;
  readonly state: string;
  readonly now: Date;
  readonly maxLifetimeMs: number;
}) => {
  const [version, nonce, expires, signature, ...labels] =
    input.state.split(".");
  const host = labels.join(".");
  if (
    version !== VERSION ||
    nonce === undefined ||
    !BASE64URL.test(nonce) ||
    expires === undefined ||
    !/^[0-9a-z]{1,8}$/.test(expires) ||
    signature === undefined ||
    !BASE64URL.test(signature) ||
    !HOST.test(host)
  )
    return undefined;
  const expiresAt = new Date(Number.parseInt(expires, 36) * 1_000);
  const now = input.now.getTime();
  if (
    expiresAt.getTime() <= now ||
    expiresAt.getTime() > now + input.maxLifetimeMs
  )
    return undefined;
  const expected = await mac(
    input.webhookSecret,
    `${version}.${nonce}.${expires}.${host}`,
  );
  return equal(signature, expected) ? { host, expiresAt } : undefined;
};
