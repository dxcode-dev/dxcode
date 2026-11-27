import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";

// A Feedback Widget grant lets a website's widget panel start Threads as the
// person who allowed it. Signing out everywhere or changing the password is
// what someone does after losing a laptop, so both must end every grant
// (#2420). Signing out one browser leaves them.

const origin = "http://dx.test";
const password = "widget-grant-password-123";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "widget-grant-revocation-secret-000000",
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
};

let browsers = 0;

/** One browser's cookie jar: it keeps every cookie the Worker sets. */
class Browser {
  readonly #cookies = new Map<string, string>();
  readonly #ipAddress = `203.0.113.${++browsers}`;

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("origin", origin);
    headers.set("user-agent", `Widget grant browser ${this.#ipAddress}`);
    headers.set("cf-connecting-ip", this.#ipAddress);
    if (this.#cookies.size > 0)
      headers.set(
        "cookie",
        [...this.#cookies]
          .map(([name, value]) => `${name}=${value}`)
          .join("; "),
      );
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

  async json(path: string, body: unknown) {
    const response = await this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect([200, 201], await response.clone().text()).toContain(
      response.status,
    );
    return response;
  }
}

const signUp = async (email: string) => {
  const browser = new Browser();
  await browser.json("/api/auth/sign-up/email", {
    name: "Widget Owner",
    email,
    password,
  });
  return browser;
};

const signIn = async (email: string, withPassword = password) => {
  const browser = new Browser();
  await browser.json("/api/auth/sign-in/email", {
    email,
    password: withPassword,
  });
  return browser;
};

/** A Project the person owns, with its widget turned on for one site. */
const widgetFor = async (owner: Browser) => {
  const created = await owner.json("/v1/projects", {
    name: `acme-site-${crypto.randomUUID().slice(0, 8)}`,
  });
  const projectId = ((await created.json()) as { data: { id: string } }).data
    .id;
  await owner.json(`/v1/projects/${projectId}/feedback-widget/origins`, {
    origin: "https://acme.example",
  });
  const enabled = await owner.json(
    `/v1/projects/${projectId}/feedback-widget/enable`,
    {},
  );
  return ((await enabled.json()) as { data: { clientId: string } }).data
    .clientId;
};

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** Allow in the consent window, then the panel claims the grant. */
const grant = async (browser: Browser, clientId: string) => {
  const verifier = `panel-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const challenge = hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const allowed = await browser.request(
    `/api/feedback-widget/${clientId}/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ challenge }).toString(),
    },
  );
  expect(allowed.status, await allowed.clone().text()).toBe(200);
  const claimed = await app.request(
    `/api/feedback-widget/${clientId}/token`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verifier }),
    },
    bindings,
  );
  expect(claimed.status).toBe(200);
  const { data } = (await claimed.json()) as { data: { token: string } };
  expect(data.token).toMatch(/^dxw_/);
  return data.token;
};

/** What the widget panel sees when it uses its grant. */
const panelStatus = async (clientId: string, token: string) =>
  (
    await app.request(
      `/api/feedback-widget/${clientId}/me`,
      { headers: { authorization: `Bearer ${token}` } },
      bindings,
    )
  ).status;

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

describe("Feedback Widget grants end with the person's sessions", () => {
  it("Sign out other sessions ends every grant; signing out one browser does not", async () => {
    const email = "widget-sign-out-everywhere@example.com";
    const laptop = await signUp(email);
    const phone = await signIn(email);
    const siteA = await widgetFor(laptop);
    const siteB = await widgetFor(laptop);
    const tokenA = await grant(laptop, siteA);
    const tokenB = await grant(phone, siteB);
    // Someone else's grant is theirs to end.
    const bystander = await signUp("widget-bystander@example.com");
    const bystanderSite = await widgetFor(bystander);
    const bystanderToken = await grant(bystander, bystanderSite);

    const oneBrowser = await laptop.request(
      `/v1/settings/personal/security/sessions/${await otherSessionId(laptop)}`,
      { method: "DELETE" },
    );
    expect(oneBrowser.status).toBe(200);
    expect(await panelStatus(siteA, tokenA)).toBe(200);
    expect(await panelStatus(siteB, tokenB)).toBe(200);

    await signIn(email);
    const everywhere = await laptop.request(
      "/v1/settings/personal/security/sessions/revoke-others",
      { method: "POST" },
    );
    expect(everywhere.status).toBe(200);
    expect(await panelStatus(siteA, tokenA)).toBe(401);
    expect(await panelStatus(siteB, tokenB)).toBe(401);
    expect(await panelStatus(bystanderSite, bystanderToken)).toBe(200);

    // Continue with dx again works as before.
    expect(await panelStatus(siteA, await grant(laptop, siteA))).toBe(200);
  });

  it("changing the password ends every grant", async () => {
    const email = "widget-password-change@example.com";
    const laptop = await signUp(email);
    const site = await widgetFor(laptop);
    const token = await grant(laptop, site);
    expect(await panelStatus(site, token)).toBe(200);

    await laptop.json("/api/auth/change-password", {
      currentPassword: password,
      newPassword: "widget-grant-password-456",
    });
    expect(await panelStatus(site, token)).toBe(401);

    const again = await signIn(email, "widget-grant-password-456");
    expect(await panelStatus(site, await grant(again, site))).toBe(200);
  });
});
