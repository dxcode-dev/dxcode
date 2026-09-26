import { env } from "cloudflare:test";
import { Principal, type UserId } from "@dx/domain";
import { Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { settingsRoutes } from "../../src/settings/routes.js";

const userId = "experimental-routes-user" as UserId;
const workspaceId = "experimental-routes-workspace";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_EXPERIMENTAL_FEATURE_FIXTURE: "capability",
};

const principal = (credentialScopes: ReadonlyArray<"personal" | "workspace">) =>
  Schema.decodeUnknownSync(Principal)({ userId, credentialScopes });

const createApp = (
  credentialScopes: ReadonlyArray<"personal" | "workspace">,
) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set("principal", principal(credentialScopes));
    await next();
  });
  app.route("/settings", settingsRoutes);
  app.onError(errorHandler);
  return app;
};

const put = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(userId, "Experimental User", "experimental@example.com", 1, 1),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(workspaceId, "Experimental Team", "experimental-team", 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("experimental-routes-membership", workspaceId, userId, "owner", 1),
  ]);
});

describe("experimental feature routes in workerd with real D1", () => {
  it("persists personal opt-in", async () => {
    const app = createApp(["personal", "workspace"]);
    const endpoint = "/settings/personal/experimental-features";
    const initial = await app.request(endpoint, {}, bindings);
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      data: {
        revision: 0,
        flags: expect.arrayContaining([
          expect.objectContaining({
            registration: expect.objectContaining({
              id: "fixture-capability-preview",
            }),
            personalEnabled: false,
            effectiveEnabled: false,
          }),
        ]),
      },
    });

    const enabled = await app.request(
      endpoint,
      put({
        featureId: "fixture-capability-preview",
        enabled: true,
        expectedRevision: 0,
      }),
      bindings,
    );
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toMatchObject({
      data: {
        revision: 1,
        flags: expect.arrayContaining([
          expect.objectContaining({
            registration: expect.objectContaining({
              id: "fixture-capability-preview",
            }),
            personalEnabled: true,
            effectiveEnabled: true,
            preferenceSource: "personal",
          }),
        ]),
      },
    });
  });

  it("rejects unknown IDs and invalid prerequisite or incompatibility combinations", async () => {
    const app = createApp(["personal", "workspace"]);
    const endpoint = "/settings/personal/experimental-features";
    const unknown = await app.request(
      endpoint,
      put({ featureId: "unknown-fixture", enabled: true, expectedRevision: 0 }),
      bindings,
    );
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toMatchObject({
      data: { reason: "unknown-feature" },
    });

    const prerequisite = await app.request(
      endpoint,
      put({
        featureId: "fixture-dependent-preview",
        enabled: true,
        expectedRevision: 0,
      }),
      bindings,
    );
    expect(prerequisite.status).toBe(400);
    await expect(prerequisite.json()).resolves.toMatchObject({
      data: {
        reason: "prerequisite-disabled",
        relatedFeatureId: "fixture-capability-preview",
      },
    });

    expect(
      (
        await app.request(
          endpoint,
          put({
            featureId: "fixture-capability-preview",
            enabled: true,
            expectedRevision: 0,
          }),
          bindings,
        )
      ).status,
    ).toBe(200);
    const incompatible = await app.request(
      endpoint,
      put({
        featureId: "fixture-safe-mode-preview",
        enabled: true,
        expectedRevision: 1,
      }),
      bindings,
    );
    expect(incompatible.status).toBe(400);
    await expect(incompatible.json()).resolves.toMatchObject({
      data: { reason: "incompatible-feature" },
    });
  });

  it("cleans stale persisted preferences and rejects stale writes deterministically", async () => {
    await env.DB.prepare(
      `INSERT INTO personal_experimental_feature_preferences (
        user_id, preferences, revision, updated_at
      ) VALUES (?, ?, 4, ?)`,
    )
      .bind(
        userId,
        JSON.stringify([
          { id: "fixture-capability-preview", enabled: true },
          { id: "removed-capability-preview", enabled: true },
        ]),
        "2026-08-23T00:00:00.000Z",
      )
      .run();
    const app = createApp(["personal", "workspace"]);
    const endpoint = "/settings/personal/experimental-features";
    const cleaned = await app.request(endpoint, {}, bindings);
    expect(cleaned.status).toBe(200);
    await expect(cleaned.json()).resolves.toMatchObject({
      data: { revision: 5 },
    });
    await expect(
      env.DB.prepare(
        "SELECT preferences, revision FROM personal_experimental_feature_preferences WHERE user_id = ?",
      )
        .bind(userId)
        .first(),
    ).resolves.toEqual({
      preferences: '[{"id":"fixture-capability-preview","enabled":true}]',
      revision: 5,
    });

    const stale = await app.request(
      endpoint,
      put({
        featureId: "fixture-capability-preview",
        enabled: false,
        expectedRevision: 4,
      }),
      bindings,
    );
    expect(stale.status).toBe(409);
  });

  it("keeps personal settings authorization independent from fixture availability", async () => {
    const denied = await createApp(["workspace"]).request(
      "/settings/personal/experimental-features",
      {},
      bindings,
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      data: { code: "SETTINGS_SCOPE_FORBIDDEN" },
    });
  });

  it("ignores the fixture binding outside local development", async () => {
    const response = await createApp(["personal", "workspace"]).request(
      "/settings/personal/experimental-features",
      {},
      { ...bindings, DX_ENV: "production" },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { flags: [] },
    });
  });
});
