import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { countD1Calls } from "./d1-call-counter.js";

/**
 * Every page load starts with `GET /api/auth/get-session` (#1386). Better
 * Auth's rate limiter keeps its counters in D1, so the read cost two
 * sequential D1 round trips (about 450 ms from Asia to an ENAM database)
 * before the session lookup. Reading one's own session is not limited; sign-in
 * and the other credential endpoints still are.
 */

const origin = "http://dx.test";
const counter = countD1Calls(env.DB);
const bindings: Bindings = {
  DB: counter.db,
  DX_ENV: "local",
  DX_RUNTIME_MODE: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "session-read-rate-limit-secret-0000000",
  DX_STORAGE: env.DX_STORAGE,
  REALTIME_HUB: env.REALTIME_HUB,
};

const touchesRateLimit = () =>
  counter.calls.some((call) => call.sql.some((sql) => /ratelimit/i.test(sql)));

it("reads the session without touching the rate limiter, and still limits sign-in", async () => {
  const email = `rate-limit-${crypto.randomUUID()}@example.com`;
  const password = "rate-limit-password-123";
  const headers = {
    "content-type": "application/json",
    origin,
    "cf-connecting-ip": "203.0.113.86",
  };
  const signUp = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Rate Limit", email, password }),
    },
    bindings,
  );
  expect(signUp.status).toBe(200);
  const cookie = signUp.headers
    .getSetCookie()
    .map((line) => line.split(";", 1)[0])
    .join("; ");

  counter.reset();
  const session = await app.request(
    "/api/auth/get-session",
    { headers: { ...headers, cookie } },
    bindings,
  );
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ user: { email } });
  expect(touchesRateLimit()).toBe(false);

  counter.reset();
  const signIn = await app.request(
    "/api/auth/sign-in/email",
    { method: "POST", headers, body: JSON.stringify({ email, password }) },
    bindings,
  );
  expect(signIn.status).toBe(200);
  expect(touchesRateLimit()).toBe(true);
});
