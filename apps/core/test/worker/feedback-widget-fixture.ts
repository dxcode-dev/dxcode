import { env } from "cloudflare:test";
import { expect } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";

// A person, their Project with the Feedback Widget on, and the steps a
// widget panel and its sign-in window take, all through the real routes.

export const origin = "http://dx.test";
export const password = "widget-grant-password-123";
export const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "widget-grant-revocation-secret-000000",
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
};

let browsers = 0;

/** One browser's cookie jar: it keeps every cookie the Worker sets. */
export class Browser {
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

export const signUp = async (email: string) => {
  const browser = new Browser();
  await browser.json("/api/auth/sign-up/email", {
    name: "Widget Owner",
    email,
    password,
  });
  return browser;
};

export const signIn = async (email: string, withPassword = password) => {
  const browser = new Browser();
  await browser.json("/api/auth/sign-in/email", {
    email,
    password: withPassword,
  });
  return browser;
};

/** A Project the person owns, with its widget turned on for one site. */
export const widgetFor = async (owner: Browser) => {
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

/** A verifier the panel keeps, and the challenge it shows the server. */
export const pkce = async () => {
  const verifier = `panel-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const challenge = hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
};

/** The panel tells dx which sign-in it is starting. */
export const start = (clientId: string, challenge: string) =>
  app.request(
    `/api/feedback-widget/${clientId}/start`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge }),
    },
    bindings,
  );

/** The person chooses Allow in the sign-in window. */
export const allow = (browser: Browser, clientId: string, challenge: string) =>
  browser.request(`/api/feedback-widget/${clientId}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ challenge }).toString(),
  });

/** The panel asks for its grant with the verifier only it holds. */
export const claim = (clientId: string, verifier: string) =>
  app.request(
    `/api/feedback-widget/${clientId}/token`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verifier }),
    },
    bindings,
  );

/** Continue with dx, end to end: start, Allow, then claim the grant. */
export const grant = async (browser: Browser, clientId: string) => {
  const { verifier, challenge } = await pkce();
  expect((await start(clientId, challenge)).status).toBe(204);
  const allowed = await allow(browser, clientId, challenge);
  expect(allowed.status, await allowed.clone().text()).toBe(200);
  const claimed = await claim(clientId, verifier);
  expect(claimed.status).toBe(200);
  const { data } = (await claimed.json()) as { data: { token: string } };
  expect(data.token).toMatch(/^dxw_/);
  return data.token;
};

/** What the widget panel sees when it uses its grant. */
export const panelStatus = async (clientId: string, token: string) =>
  (
    await app.request(
      `/api/feedback-widget/${clientId}/me`,
      { headers: { authorization: `Bearer ${token}` } },
      bindings,
    )
  ).status;
