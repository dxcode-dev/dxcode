import { env } from "cloudflare:test";
import { Principal } from "@dx/domain";
import { Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { makeDeploymentAdminRoutes } from "../../src/auth/deployment-admin.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";

/**
 * Deployment administrators: a signed-in person whose verified primary
 * email is in DX_DEPLOYMENT_ADMIN_EMAILS. Every admin route checks it on the
 * server, reading the binding on each request.
 */

const now = "2026-11-02T12:00:00.000Z";
const people = {
  admin: { id: "usr-deploy-admin", email: "Ops@Example.test", verified: 1 },
  unverified: {
    id: "usr-deploy-unverified",
    email: "pending@example.test",
    verified: 0,
  },
  member: {
    id: "usr-deploy-member",
    email: "member@example.test",
    verified: 1,
  },
} as const;
type Person = keyof typeof people;

const admins = " ops@example.test , pending@example.test ";

/** The routes a deployment registers, behind the admin check. */
const registered = new Hono<AppEnv>().get("/probe", (c) =>
  c.json({ status: "ok", data: { reached: true } }),
);

const request = async (
  person: Person,
  path: string,
  adminEmails: string | undefined,
) => {
  const router = new Hono<AppEnv>();
  router.use("*", requestId);
  router.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId: people[person].id,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  router.route("/v1/deployment-admin", makeDeploymentAdminRoutes(registered));
  router.onError(errorHandler);
  const bindings: Bindings = {
    DB: env.DB,
    ...(adminEmails === undefined
      ? {}
      : { DX_DEPLOYMENT_ADMIN_EMAILS: adminEmails }),
  };
  const response = await router.request(path, {}, bindings);
  return {
    status: response.status,
    body: (await response.json()) as { data?: Record<string, unknown> },
  };
};

beforeEach(async () => {
  await env.DB.batch(
    Object.values(people).map(({ id, email, verified }) =>
      env.DB.prepare(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(id, id, email, verified, now, now),
    ),
  );
});

describe("Deployment administrators, in workerd with real D1", () => {
  it("lets an admin with a verified listed email through, matched without case or spaces", async () => {
    expect(await request("admin", "/v1/deployment-admin", admins)).toEqual({
      status: 200,
      body: expect.objectContaining({ data: { admin: true } }),
    });
    expect(
      await request("admin", "/v1/deployment-admin/probe", admins),
    ).toEqual({
      status: 200,
      body: expect.objectContaining({ data: { reached: true } }),
    });
  });

  it("refuses a person who is not listed with 403", async () => {
    expect(
      (await request("member", "/v1/deployment-admin", admins)).body.data,
    ).toEqual({ admin: false });
    expect(
      (await request("member", "/v1/deployment-admin/probe", admins)).status,
    ).toBe(403);
  });

  it("refuses a listed email until it is verified", async () => {
    expect(
      (await request("unverified", "/v1/deployment-admin", admins)).body.data,
    ).toEqual({ admin: false });
    expect(
      (await request("unverified", "/v1/deployment-admin/probe", admins))
        .status,
    ).toBe(403);
    await env.DB.prepare('UPDATE "user" SET emailVerified = 1 WHERE id = ?')
      .bind(people.unverified.id)
      .run();
    expect(
      (await request("unverified", "/v1/deployment-admin/probe", admins))
        .status,
    ).toBe(200);
  });

  it("has no admins without the binding, and reads it on every request", async () => {
    expect(
      (await request("admin", "/v1/deployment-admin/probe", undefined)).status,
    ).toBe(403);
    expect(
      (await request("admin", "/v1/deployment-admin/probe", "  ")).status,
    ).toBe(403);
    // Removing the email takes effect on the next request.
    expect(
      (await request("admin", "/v1/deployment-admin/probe", admins)).status,
    ).toBe(200);
    expect(
      (
        await request(
          "admin",
          "/v1/deployment-admin/probe",
          "pending@example.test",
        )
      ).status,
    ).toBe(403);
  });
});
