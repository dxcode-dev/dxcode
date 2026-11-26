import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { portalSigningKey } from "../../src/portals/crypto.js";
import { encodePortalSession } from "../../src/portals/session.js";

/**
 * A plugin's own page through its plugin Orb's Portal: a session made for a
 * plugin's page reaches only that page's path prefix on the program's port.
 *
 * Ways it could fail: a browser reaches the program's `/tools`, `/jobs`, or
 * `/events` (which run as the install) through the page's Portal; the page
 * itself is refused.
 */

const appOrigin = "http://dx.test";
const portalDomain = "dxportal.test";
const secret = "plugin-app-portal-secret-00000000000000000";
const orbId = "thr_00000000-0000-4000-8000-00000000a991";
const origin = `https://t-${orbId.slice(4)}-p37897.${portalDomain}`;

it("serves a plugin's page and nothing else its program answers", async () => {
  const relayed: Array<string> = [];
  const bindings = {
    DB: env.DB,
    DX_ENV: "local",
    DX_RUNTIME_MODE: "deployed",
    DX_AUTH_URL: appOrigin,
    DX_AUTH_TRUSTED_ORIGINS: appOrigin,
    BETTER_AUTH_SECRET: secret,
    DX_PORTAL_DOMAIN: portalDomain,
    THREAD_EXECUTION: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (request: Request) => {
          relayed.push(new URL(request.url).pathname);
          return new Response("<h1>Log Watch checks</h1>", {
            headers: { "content-type": "text/html" },
          });
        },
      }),
    } as unknown as DurableObjectNamespace,
  } satisfies Bindings;
  const key = await portalSigningKey(secret);
  if (key === undefined) throw new Error("setup");
  const now = Math.floor(Date.now() / 1_000);
  const cookie = `__Host-dx_portal=${await encodePortalSession(key, {
    host: new URL(origin).host,
    userId: "usr-app-viewer",
    sessionId: "session-app",
    appPath: "/app/",
    issuedAt: now,
    expiresAt: now + 3_600,
    checkedAt: now,
  })}`;
  const visit = (path: string, method = "GET") =>
    app.request(
      `${origin}${path}`,
      {
        method,
        headers: {
          accept: "text/html",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
          "sec-fetch-site": "none",
          cookie,
        },
      },
      bindings,
    );

  const page = await visit("/app/");
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Log Watch checks");
  for (const path of [
    "/jobs/check",
    "/tools/log_watch_counts",
    "/events/errors",
    "/",
  ]) {
    const refused = await visit(path, path === "/" ? "GET" : "POST");
    expect(refused.status, path).toBe(404);
  }
  // Only the page reached the plugin Orb.
  expect(relayed).toHaveLength(1);
});
