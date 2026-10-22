import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import {
  sessionCookieCacheMaxAgeSeconds,
  sessionRevocationWindowMs,
} from "../../src/auth/session-revocation.js";
import type { Bindings } from "../../src/http/types.js";

const origin = "http://dx.test";
const password = "revocation-password-123";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "session-revocation-secret-000000000000",
};

let browsers = 0;

/** One browser's cookie jar: it keeps every cookie the Worker sets. */
class Browser {
  readonly #cookies = new Map<string, string>();
  readonly #ipAddress = `198.51.100.${++browsers}`;

  constructor(readonly userAgent: string) {}

  get cookie() {
    return [...this.#cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  get cookieNames() {
    return [...this.#cookies.keys()];
  }

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("origin", origin);
    headers.set("user-agent", this.userAgent);
    headers.set("cf-connecting-ip", this.#ipAddress);
    if (this.#cookies.size > 0) headers.set("cookie", this.cookie);
    const response = await app.request(path, { ...init, headers }, bindings);
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const expired = attributes.some((attribute) =>
        /^\s*max-age=0\s*$/i.test(attribute),
      );
      if (expired || value === "") this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    return response;
  }

  async #post(path: string, body: unknown) {
    const response = await this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
  }

  signUp(email: string) {
    return this.#post("/api/auth/sign-up/email", {
      name: "Revocation Owner",
      email,
      password,
    });
  }

  signIn(email: string) {
    return this.#post("/api/auth/sign-in/email", { email, password });
  }

  /** Drops the session cache cookie, as a client sending only the token does. */
  forgetCache() {
    for (const name of this.#cookies.keys()) {
      if (name.endsWith("session_data")) this.#cookies.delete(name);
    }
  }

  async session() {
    const response = await this.request("/api/auth/get-session");
    expect(response.status).toBe(200);
    return (await response.json()) as { session: { id: string } } | null;
  }
}

const otherSessionId = async (current: Browser) => {
  const response = await current.request(
    "/v1/settings/personal/security/sessions",
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { items: Array<{ id: string; isCurrent: boolean }> };
  };
  const other = body.data.items.find((session) => !session.isCurrent);
  if (other === undefined) throw new Error("Expected another session.");
  return other.id;
};

/**
 * The ended browser still holds a warm signed cookie cache and replays it
 * unchanged: every API path refuses it, and the session lookup the web app
 * runs on load reports nobody signed in and clears the cookies.
 */
const expectEnded = async (browser: Browser) => {
  expect(
    browser.cookieNames.some((name) => name.endsWith("session_data")),
  ).toBe(true);
  const headers = { cookie: browser.cookie, origin };
  const read = await app.request("/v1/projects", { headers }, bindings);
  expect(read.status).toBe(401);
  const write = await app.request(
    "/v1/projects",
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "after revocation" }),
    },
    bindings,
  );
  expect(write.status).toBe(401);
  expect(await browser.session()).toBeNull();
  expect(browser.cookieNames).toEqual([]);
};

const expectLive = async (browser: Browser) => {
  expect((await browser.request("/v1/projects")).status).toBe(200);
  expect(await browser.session()).not.toBeNull();
};

afterEach(() => vi.useRealTimers());

describe("ending a browser session with the cookie cache warm", () => {
  it("rejects the ended browser on every path after the Security page ends it", async () => {
    const email = "revoke-one@example.com";
    const laptop = new Browser("Chrome on laptop");
    const phone = new Browser("Safari on phone");
    await laptop.signUp(email);
    await phone.signIn(email);
    await expectLive(phone);

    const ended = await laptop.request(
      `/v1/settings/personal/security/sessions/${await otherSessionId(laptop)}`,
      { method: "DELETE" },
    );
    expect(ended.status).toBe(200);

    await expectEnded(phone);
    await expectLive(laptop);
  });

  it("rejects every other browser after the Security page ends all others", async () => {
    const email = "revoke-others@example.com";
    const laptop = new Browser("Chrome on laptop");
    const phone = new Browser("Safari on phone");
    const tablet = new Browser("Firefox on tablet");
    await laptop.signUp(email);
    await phone.signIn(email);
    await tablet.signIn(email);
    await expectLive(phone);
    await expectLive(tablet);

    const ended = await laptop.request(
      "/v1/settings/personal/security/sessions/revoke-others",
      { method: "POST" },
    );
    expect(ended.status).toBe(200);

    await expectEnded(phone);
    await expectEnded(tablet);
    await expectLive(laptop);
  });

  it("rejects a copied cookie set after its browser signs out", async () => {
    const email = "sign-out@example.com";
    const laptop = new Browser("Chrome on laptop");
    const phone = new Browser("Safari on phone");
    await laptop.signUp(email);
    await phone.signIn(email);
    await expectLive(phone);
    const desktop = new Browser("Edge on desktop");
    await desktop.signIn(email);
    const copied = phone.cookie;

    const signedOut = await phone.request("/api/auth/sign-out", {
      method: "POST",
    });
    expect(signedOut.status).toBe(200);

    const replay = await app.request(
      "/v1/projects",
      { headers: { cookie: copied, origin } },
      bindings,
    );
    expect(replay.status).toBe(401);
    const session = await app.request(
      "/api/auth/get-session",
      { headers: { cookie: copied, origin } },
      bindings,
    );
    expect(await session.json()).toBeNull();
    await expectLive(laptop);
    await expectLive(desktop);
  });

  it("rejects a session deleted outside Better Auth once the revocation window passes", async () => {
    const email = "deleted-row@example.com";
    const laptop = new Browser("Chrome on laptop");
    const phone = new Browser("Safari on phone");
    await laptop.signUp(email);
    await phone.signIn(email);
    await expectLive(phone);
    const phoneSession = await phone.session();

    await env.DB.prepare("DELETE FROM session WHERE id = ?")
      .bind(phoneSession?.session.id)
      .run();
    // Another isolate, which did not delete the row, sees it within the window.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    vi.advanceTimersByTime(sessionRevocationWindowMs);

    await expectEnded(phone);
    await expectLive(laptop);
  });
  it("never signs a cache cookie that outlives a revocation seen while writing it", async () => {
    const email = "revocation-race@example.com";
    const laptop = new Browser("Chrome on laptop");
    const phone = new Browser("Safari on phone");
    await laptop.signUp(email);
    await phone.signIn(email);
    const phoneSession = await phone.session();
    const sessionId = phoneSession?.session.id;

    // The delete commits between the phone's D1 read of its session row and
    // Better Auth writing a fresh cache cookie: the cookie is written while
    // the revocation is already visible.
    await env.DB.prepare(
      "INSERT INTO session_revocation (session_id, ended_at) VALUES (?, ?)",
    )
      .bind(sessionId, Date.now())
      .run();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    vi.advanceTimersByTime(sessionRevocationWindowMs);
    phone.forgetCache();
    expect(await phone.session()).not.toBeNull();
    await env.DB.prepare("DELETE FROM session WHERE id = ?")
      .bind(sessionId)
      .run();

    await expectEnded(phone);
    await expectLive(laptop);
  });

  it("keeps each revocation record for the whole cookie cache max age", async () => {
    const maxAgeMs = sessionCookieCacheMaxAgeSeconds * 1000;
    const now = Date.now();
    const record = env.DB.prepare(
      "INSERT INTO session_revocation (session_id, ended_at) VALUES (?, ?)",
    );
    await env.DB.batch([
      record.bind("retention-still-protecting", now - maxAgeMs + 60_000),
      record.bind("retention-past-max-age", now - maxAgeMs - 120_000),
    ]);
    const browser = new Browser("Chrome on laptop");
    await browser.signUp("retention@example.com");
    expect(
      (await browser.request("/api/auth/sign-out", { method: "POST" })).status,
    ).toBe(200);

    const { results } = await env.DB.prepare(
      "SELECT session_id FROM session_revocation WHERE session_id LIKE 'retention-%'",
    ).all<{ session_id: string }>();
    expect(results.map((row) => row.session_id)).toEqual([
      "retention-still-protecting",
    ]);
  });
});
