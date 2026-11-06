import { env } from "cloudflare:test";
import { Effect } from "effect";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import type { AppEnv, Bindings } from "../../src/http/types.js";

vi.mock("../../src/auth/browser-session.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/auth/browser-session.js")
  >()),
  requireBrowserSession: () => Effect.succeed({ sessionId: "browser" }),
}));

// The person is signed in: the browser session check passes.
vi.mock("../../src/auth/requirements.js", () => ({
  loadAuthenticationRequirements: () => Effect.succeed({}),
}));
vi.mock("../../src/auth/request-auth.js", () => ({ requestAuth: () => ({}) }));

const { bitbucketControlPlaneRoutes } = await import(
  "../../src/source-control/bitbucket/routes.js"
);

const userId = "bitbucket-status-user";
const origin = "https://dx.test";
const bindings = {
  DB: env.DB,
  DX_AUTH_URL: origin,
  DX_RUNTIME_MODE: "deployed",
  DX_INTEGRATION_BITBUCKET_OAUTH: JSON.stringify({
    version: 1,
    clientId: "client",
    clientSecret: "secret",
    callbackUrl: `${origin}/v1/integrations/bitbucket/oauth/callback`,
  }),
} satisfies Bindings;

const app = () => {
  const routes = new Hono<AppEnv>();
  routes.use("*", async (context, next) => {
    context.set("requestId", "bitbucket-status");
    context.set("principal", {
      userId,
      credentialScopes: ["personal"],
    } as never);
    await next();
  });
  routes.route("/", bitbucketControlPlaneRoutes);
  return routes;
};

afterEach(() => vi.unstubAllGlobals());

it("answers the Integrations page's connection check from the stored connection, without calling Bitbucket", async () => {
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  )
    .bind(userId, "Bitbucket Status", "bitbucket-status@example.com")
    .run();
  await env.DB.prepare(
    `INSERT INTO bitbucket_connection (
      id, user_id, provider_account_id, account_name, status,
      authorization_epoch, created_at, updated_at
    ) VALUES ('bitbucket-status-connection', ?, '{account}', 'team', 'active', 1, ?, ?)`,
  )
    .bind(userId, now, now)
    .run();
  // Bitbucket is down: any call to it fails.
  const outbound = vi.fn(async () => new Response("down", { status: 503 }));
  vi.stubGlobal("fetch", outbound);

  const response = await app().request(
    "/personal/connection",
    { headers: { origin } },
    bindings,
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: "success",
    data: {
      configured: true,
      connection: {
        id: "bitbucket-status-connection",
        accountName: "team",
        status: "active",
      },
    },
  });
  expect(outbound).not.toHaveBeenCalled();
});
