import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import { encodeBase64Url } from "../../src/encoding/base64.js";
import type { Bindings } from "../../src/http/types.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

/**
 * Sign-in handoff from the browser to a native app, in workerd with real D1.
 * Ways it could fail, each covered below:
 * - someone without a browser session mints a code;
 * - a code redeems without the verifier for its challenge (an intercepted
 *   `dx://` link signs in another app);
 * - a code redeems twice, or a failed attempt leaves it usable;
 * - the app's session is the browser's own, so signing out of one signs out
 *   the other;
 * - the redeemed cookie doesn't actually authenticate;
 * - a malformed challenge is stored;
 * - a page or link outside the app sends someone to redeem an attacker's
 *   code and verifier, signing them in to the attacker's account (login
 *   CSRF), or the refusal spends the code.
 */

const origin = "http://dx.test";
const bindings = {
  DB: env.DB,
  LOADER: env.LOADER,
  REALTIME_HUB: env.REALTIME_HUB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  BETTER_AUTH_SECRET: "native-handoff-secret-0000000000000000",
} as unknown as Bindings;

let signups = 0;
const signUp = async () => {
  signups += 1;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `192.0.2.${signups + 120}`,
      },
      body: JSON.stringify({
        name: "Native Handoff",
        email: `native-handoff-${signups}@example.test`,
        password: "native-handoff-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
};

const pkce = async () => {
  const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  return { verifier, challenge };
};

const create = (cookie: string | undefined, challenge: string) =>
  app.request(
    "/api/auth/native-handoff/create",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify({ challenge }),
    },
    bindings,
  );

// The app's web view loads the link itself: `Sec-Fetch-Site: none`.
const redeem = (code: string, verifier: string, fetchSite = "none") =>
  app.request(
    `/api/auth/native-handoff/redeem?code=${encodeURIComponent(code)}&verifier=${encodeURIComponent(verifier)}`,
    { headers: { "sec-fetch-site": fetchSite } },
    bindings,
  );

const session = async (cookie: string) =>
  (await (
    await app.request(
      "/api/auth/get-session",
      { headers: { cookie, origin } },
      bindings,
    )
  ).json()) as { session?: { id: string }; user?: { email: string } } | null;

const sessionCookie = (response: Response) =>
  (response.headers.get("set-cookie") ?? "")
    .split(/,(?=\s*[^;,=\s]+=)/u)
    .map((part) => part.trim().split(";", 1)[0] ?? "")
    .find((part) => part.includes("session_token="));

describe("native sign-in handoff", () => {
  it("needs a browser session to mint a code", async () => {
    const { challenge } = await pkce();
    const response = await create(undefined, challenge);
    expect(response.status).toBe(401);
  });

  it("refuses a malformed challenge", async () => {
    const cookie = await signUp();
    const response = await create(cookie, "not-a-sha256");
    expect(response.status).toBe(400);
  });

  it("gives the app its own session, once, only with the verifier", async () => {
    const browser = await signUp();
    const { verifier, challenge } = await pkce();
    const created = await create(browser, challenge);
    expect(created.status).toBe(200);
    const { code } = (await created.json()) as { code: string };

    // Another app that caught the link has no verifier: refused, and the
    // code is spent.
    const stolen = await redeem(code, (await pkce()).verifier);
    expect(stolen.status).toBe(400);
    expect(sessionCookie(stolen)).toBeUndefined();
    expect((await redeem(code, verifier)).status).toBe(400);

    // A fresh code with the right verifier signs the app in.
    const again = await create(browser, challenge);
    const { code: second } = (await again.json()) as { code: string };
    const redeemed = await redeem(second, verifier);
    expect(redeemed.status).toBe(302);
    expect(redeemed.headers.get("location")).toBe("/");
    const appCookie = sessionCookie(redeemed);
    expect(appCookie).toBeDefined();
    const appSession = await session(appCookie as string);
    const browserSession = await session(browser);
    expect(appSession?.user?.email).toBe(browserSession?.user?.email);
    expect(appSession?.session?.id).toBeDefined();
    expect(appSession?.session?.id).not.toBe(browserSession?.session?.id);

    // Used once.
    expect((await redeem(second, verifier)).status).toBe(400);
  });

  it("refuses a redeem another page or link started, without spending the code", async () => {
    const attacker = await signUp();
    const { verifier, challenge } = await pkce();
    const created = await create(attacker, challenge);
    const { code } = (await created.json()) as { code: string };

    // evil.example redirects the victim here, or a link in dx itself does.
    for (const site of ["cross-site", "same-site", "same-origin"]) {
      const forged = await redeem(code, verifier, site);
      expect(forged.status).toBe(403);
      expect(sessionCookie(forged)).toBeUndefined();
    }

    // The app's own load still redeems the same code.
    const redeemed = await redeem(code, verifier);
    expect(redeemed.status).toBe(302);
    expect(sessionCookie(redeemed)).toBeDefined();
  });
});
