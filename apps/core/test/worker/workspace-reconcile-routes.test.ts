import { env } from "cloudflare:test";
import { Principal, UserId } from "@dx/domain";
import { Schema } from "effect";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv } from "../../src/http/types.js";
import { settingsRoutes } from "../../src/settings/routes.js";

const userId = (value: string) => Schema.decodeUnknownSync(UserId)(value);
const owner = userId("workspace-reconcile-owner");
const principal = (id: UserId) =>
  Schema.decodeUnknownSync(Principal)({
    userId: id,
    credentialScopes: ["personal", "workspace"],
  });

const createSettingsApp = (id: UserId) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set("principal", principal(id));
    await next();
  });
  app.route("/settings", settingsRoutes);
  app.onError(errorHandler);
  return app;
};

const FORCE_FAILURE_TRIGGER = "workspace_organization_update_force_failure";

const installForceUpdateFailure = async () => {
  await env.DB.prepare(`DROP TRIGGER IF EXISTS ${FORCE_FAILURE_TRIGGER}`).run();
  await env.DB.prepare(
    `CREATE TRIGGER ${FORCE_FAILURE_TRIGGER}
     BEFORE UPDATE ON organization
     BEGIN
       SELECT RAISE(ABORT, 'forced D1 outage');
     END`,
  ).run();
};

const removeForceUpdateFailure = () =>
  env.DB.prepare(`DROP TRIGGER IF EXISTS ${FORCE_FAILURE_TRIGGER}`).run();

const patchProfile = (
  app: ReturnType<typeof createSettingsApp>,
  slug: string,
  body: { displayName: string; shortName: string },
) =>
  app.request(
    `/settings/workspaces/${slug}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, expectedRevision: 0 }),
    },
    { DB: env.DB },
  );

const WORKSPACE_ID = "reconcile-workspace-id";
const OTHER_WORKSPACE_ID = "reconcile-other-workspace-id";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(owner, "Reconcile Owner", "reconcile-owner@example.com", 1, 1),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(WORKSPACE_ID, "DX Team", "dx-team", 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("reconcile-owner-member", WORKSPACE_ID, owner, "owner", 1),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(OTHER_WORKSPACE_ID, "Other Team", "other-team", 1),
  ]);
});

afterEach(async () => {
  await removeForceUpdateFailure();
});

describe("workspace profile reconciliation during transient persistence failure", () => {
  it("reports a retryable 503 when the short name is unchanged (display-name-only edit)", async () => {
    await installForceUpdateFailure();
    const res = await patchProfile(createSettingsApp(owner), "dx-team", {
      displayName: "Renamed DX",
      shortName: "dx-team",
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "error",
      data: {
        code: "PERSISTENCE_UNAVAILABLE",
        message: "Workspace settings are temporarily unavailable.",
        requestId: expect.any(String),
      },
    });
    expect(body.data.fieldErrors).toBeUndefined();
  });

  it("reports a retryable 503 when the short name is changed to an available slug", async () => {
    await installForceUpdateFailure();
    const res = await patchProfile(createSettingsApp(owner), "dx-team", {
      displayName: "Renamed DX",
      shortName: "renamed-dx",
    });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      status: "error",
      data: { code: "PERSISTENCE_UNAVAILABLE" },
    });
  });

  it("still reports a 409 conflict when the requested slug is taken by another workspace", async () => {
    await installForceUpdateFailure();
    const res = await patchProfile(createSettingsApp(owner), "dx-team", {
      displayName: "Renamed DX",
      shortName: "other-team",
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      status: "error",
      data: {
        code: "WORKSPACE_SHORT_NAME_UNAVAILABLE",
        fieldErrors: [{ field: "shortName" }],
      },
    });
  });
});
