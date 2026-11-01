import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth/better-auth.js";
import type { AuthenticationRequirements } from "../../src/auth/requirements.js";
import type { Bindings } from "../../src/http/types.js";

/**
 * Better Auth does not introspect D1 at request time (better-auth.ts sets
 * `validateSchema: false`), so its schema check runs here, against the
 * migrated test database, instead.
 */

const origin = "http://dx.test";
const requirements: AuthenticationRequirements = {
  environment: "local",
  authUrl: origin,
  trustedOrigins: [origin],
  secret: "better-auth-schema-secret-0000000000000",
};
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: requirements.secret,
};

const schemaCheck = async () => {
  const context = await createAuth(bindings, requirements).$context;
  // Nothing on the request path awaits a schema check.
  expect(context.checkSchema).toBeUndefined();
  const check = context.explicitSchemaCheck;
  if (check === undefined) throw new Error("Expected Better Auth's check.");
  return check();
};

describe("Better Auth schema", () => {
  it("matches Better Auth's expected schema", async () => {
    await expect(schemaCheck()).resolves.toBeUndefined();
  });

  it("fails when a migration drops a column Better Auth writes", async () => {
    await env.DB.prepare('ALTER TABLE "session" DROP COLUMN "userAgent"').run();
    await expect(schemaCheck()).rejects.toThrow(/userAgent/);
  });
});
