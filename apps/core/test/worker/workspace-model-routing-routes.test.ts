import { env } from "cloudflare:test";
import { Principal, UserId } from "@dx/domain";
import { Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv } from "../../src/http/types.js";
import { settingsRoutes } from "../../src/settings/routes.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

const owner = Schema.decodeUnknownSync(UserId)("workspace-routing-owner");
const member = Schema.decodeUnknownSync(UserId)("workspace-routing-member");
const outsider = Schema.decodeUnknownSync(UserId)("workspace-routing-outsider");
const workspaceBase = "/settings/workspaces/routing-team/model-routing";

const appFor = (userId: UserId) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (c, next) => {
    c.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  app.route("/settings", settingsRoutes);
  return app;
};

const bindings = {
  DB: env.DB,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_MODEL_DEPLOYMENT_PROVIDERS: "anthropic",
};

beforeEach(async () => {
  await env.DB.batch([
    ...[owner, member, outsider].map((id, index) =>
      env.DB.prepare(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
      ).bind(id, `Routing ${index}`, `workspace-routing-${index}@example.com`),
    ),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES ('routing-workspace', 'Routing Team', 'routing-team', 1)",
    ),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('routing-owner-membership', 'routing-workspace', ?, 'owner', 1)",
    ).bind(owner),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('routing-member-membership', 'routing-workspace', ?, 'member', 1)",
    ).bind(member),
  ]);
});

describe("workspace model routing reads", () => {
  it("serves a subscription-free catalog to members and rejects nonmembers", async () => {
    const response = await appFor(member).request(
      `${workspaceBase}/catalog`,
      {},
      bindings,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { providers: Array<{ id: string; connectionKind: string }> };
    };
    expect(body.data.providers).toContainEqual(
      expect.objectContaining({ id: "anthropic" }),
    );
    expect(
      body.data.providers.some(
        (provider) => provider.connectionKind === "subscription",
      ),
    ).toBe(false);

    const denied = await appFor(outsider).request(
      `${workspaceBase}/catalog`,
      {},
      bindings,
    );
    expect(denied.status).toBe(403);
  });

  it("builds the graph from workspace connections without personal leakage", async () => {
    const create = async (base: string, name: string) => {
      const response = await appFor(owner).request(
        `${base}/connections`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "custom",
            name,
            providerId: "dx-custom",
            apiKey: "sk-workspace-routing-test",
            baseUrl: "https://models.example.com/v1",
            format: "openai-completions",
            models: [{ canonical: "anthropic/claude-fable-5-1" }],
            enabled: true,
          }),
        },
        bindings,
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { data: { id: string } }).data.id;
    };

    const personalId = await create(
      "/settings/personal/model-routing",
      "Personal route",
    );
    const workspaceId = await create(workspaceBase, "Workspace route");
    const response = await appFor(member).request(
      `${workspaceBase}/graph`,
      {},
      bindings,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        connections: Array<{ connectionId: string; scope: string }>;
        edges: Array<{ mode: string; connectionId: string | null }>;
      };
    };
    expect(body.data.connections).toContainEqual(
      expect.objectContaining({
        connectionId: workspaceId,
        scope: "workspace",
      }),
    );
    expect(body.data.connections).not.toContainEqual(
      expect.objectContaining({ connectionId: personalId }),
    );
    expect(
      body.data.edges.find(({ mode }) => mode === "ultra")?.connectionId,
    ).toBe(workspaceId);
  });

  it("accepts only admin-created custom connections on the workspace", async () => {
    const post = (userId: UserId, body: Record<string, unknown>) =>
      appFor(userId).request(
        `${workspaceBase}/connections`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true, ...body }),
        },
        bindings,
      );
    const provider = await post(owner, {
      kind: "provider",
      name: "Workspace Anthropic",
      providerId: "anthropic",
      apiKey: "sk-workspace-provider",
    });
    expect(provider.status).toBe(400);
    expect(await provider.text()).toContain(
      "Workspace connections use a custom URL.",
    );
    const custom = {
      kind: "custom",
      name: "Workspace custom",
      providerId: "dx-custom",
      apiKey: "sk-workspace-custom",
      baseUrl: "https://models.example.com/v1",
      format: "openai-completions",
      models: [{ canonical: "anthropic/claude-fable-5-1" }],
    };
    expect((await post(member, custom)).status).toBe(403);
    expect((await post(owner, custom)).status).toBe(200);
  });

  it("routes a member through their personal connection before the workspace one", async () => {
    const create = async (userId: UserId, base: string, name: string) => {
      const response = await appFor(userId).request(
        `${base}/connections`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "custom",
            name,
            providerId: "dx-custom",
            apiKey: "sk-routing-precedence",
            baseUrl: "https://models.example.com/v1",
            format: "openai-completions",
            models: [{ canonical: "anthropic/claude-fable-5-1" }],
            enabled: true,
          }),
        },
        bindings,
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { data: { id: string } }).data.id;
    };
    const ultraConnection = async () => {
      const response = await appFor(member).request(
        "/settings/personal/model-routing/graph",
        {},
        bindings,
      );
      const body = (await response.json()) as {
        data: { edges: Array<{ mode: string; connectionId: string | null }> };
      };
      return body.data.edges.find(({ mode }) => mode === "ultra")?.connectionId;
    };

    const workspaceId = await create(owner, workspaceBase, "Shared route");
    expect(await ultraConnection()).toBe(workspaceId);
    const personalId = await create(
      member,
      "/settings/personal/model-routing",
      "My route",
    );
    expect(await ultraConnection()).toBe(personalId);
  });
});
