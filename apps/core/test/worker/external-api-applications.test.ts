import { env } from "cloudflare:test";
import type {
  ExternalApiApplicationData,
  ExternalApiApplicationSecretData,
} from "@dx/api";
import {
  type ExternalApiApplicationScope,
  Principal,
  UserId,
  type WorkspaceSlug,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { authenticate } from "../../src/auth/authenticate.js";
import { authorizeApiTokenScope } from "../../src/auth/authorize-api-token-scope.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { hashExternalApiApplicationSecret } from "../../src/settings/applications/credentials.js";
import { settingsRoutes } from "../../src/settings/routes.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { threadRoutes } from "../../src/threads/routes.js";

const owner = Schema.decodeUnknownSync(UserId)("applications-owner");
const admin = Schema.decodeUnknownSync(UserId)("applications-admin");
const member = Schema.decodeUnknownSync(UserId)("applications-member");
const outsider = Schema.decodeUnknownSync(UserId)("applications-outsider");
const otherOwner = Schema.decodeUnknownSync(UserId)("applications-other-owner");
const workspaceSlug = "dx-team" as WorkspaceSlug;
const otherWorkspaceSlug = "other-team" as WorkspaceSlug;
const allScopes = [
  "projects:read",
  "projects:write",
  "threads:read",
  "threads:write",
] as const;

const principal = (userId: UserId) =>
  Schema.decodeUnknownSync(Principal)({
    userId,
    credentialScopes: ["personal", "workspace"],
  });

const settingsApp = (userId: UserId) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set("principal", principal(userId));
    await next();
  });
  app.route("/settings", settingsRoutes);
  app.onError(errorHandler);
  return app;
};

const productApp = () => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("/v1/*", authenticate);
  app.use("/v1/*", authorizeApiTokenScope);
  app.route("/v1/projects", projectRoutes);
  app.route("/v1/settings", settingsRoutes);
  app.route("/v1/threads", threadRoutes);
  app.all("/v1/agents/dx/*", (context) => context.json({ native: true }));
  app.onError(errorHandler);
  return app;
};

const jsonHeaders = { "content-type": "application/json" };
const productBindings: Bindings = {
  DB: env.DB,
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
};

const createApplication = async (
  userId: UserId,
  input: {
    readonly name?: string;
    readonly scopes?: ReadonlyArray<string>;
    readonly rateLimitPerMinute?: number;
    readonly slug?: WorkspaceSlug;
  } = {},
) => {
  const response = await settingsApp(userId).request(
    `/settings/workspaces/${input.slug ?? workspaceSlug}/applications`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        name: input.name ?? "Deployment automation",
        scopes: input.scopes ?? allScopes,
        rateLimitPerMinute: input.rateLimitPerMinute ?? 60,
      }),
    },
    { DB: env.DB },
  );
  expect(response.status).toBe(201);
  return (await response.json()) as {
    readonly status: "success";
    readonly data: ExternalApiApplicationSecretData;
  };
};

const basic = (application: ExternalApiApplicationData, secret: string) =>
  `Basic ${btoa(`${application.clientId}:${secret}`)}`;

const productRequest = (
  application: ExternalApiApplicationData,
  secret: string,
  path: string,
  init: RequestInit = {},
) =>
  productApp().request(
    path,
    {
      ...init,
      headers: {
        authorization: basic(application, secret),
        ...init.headers,
      },
    },
    productBindings,
  );

const insertUser = (userId: UserId, index: number) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
  ).bind(
    userId,
    `Application User ${index}`,
    `application-${index}@example.com`,
    1,
    1,
  );

beforeEach(async () => {
  await env.DB.batch([
    insertUser(owner, 1),
    insertUser(admin, 2),
    insertUser(member, 3),
    insertUser(outsider, 4),
    insertUser(otherOwner, 5),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind("applications-workspace", "DX Team", workspaceSlug, 1),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind("applications-other-workspace", "Other Team", otherWorkspaceSlug, 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "applications-owner-member",
      "applications-workspace",
      owner,
      "owner",
      1,
    ),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "applications-admin-member",
      "applications-workspace",
      admin,
      "admin",
      1,
    ),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "applications-regular-member",
      "applications-workspace",
      member,
      "member",
      1,
    ),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "applications-other-owner-member",
      "applications-other-workspace",
      otherOwner,
      "owner",
      1,
    ),
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "prj_00000000-0000-4000-8000-000000000050",
      owner,
      "Owner project",
      new Date(1).toISOString(),
      new Date(1).toISOString(),
    ),
  ]);
});

describe("workspace external API applications in workerd with real D1", () => {
  it("shows a random secret once and persists only its SHA-256 hash", async () => {
    const created = await createApplication(owner);
    const { application, clientSecret } = created.data;
    expect(application.clientId).toMatch(/^dxa_/);
    expect(clientSecret).toMatch(/^dxs_/);

    const credential = await env.DB.prepare(
      "SELECT secret_hash, identifier FROM external_api_application_credential WHERE application_id = ?",
    )
      .bind(application.id)
      .first<{ secret_hash: string; identifier: string }>();
    expect(credential?.secret_hash).toBe(
      await Effect.runPromise(hashExternalApiApplicationSecret(clientSecret)),
    );
    expect(credential?.secret_hash).not.toContain(clientSecret);
    expect(credential?.identifier).toBe(clientSecret.slice(0, 12));

    const listed = await settingsApp(owner).request(
      `/settings/workspaces/${workspaceSlug}/applications`,
      {},
      { DB: env.DB },
    );
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(listedText).toContain(application.clientId);
    expect(listedText).not.toContain(clientSecret);
    expect(listedText).not.toContain(credential?.secret_hash);
  });

  it("enforces workspace RBAC, supported scopes, cross-workspace isolation, and bounded pagination", async () => {
    const first = await createApplication(owner, { name: "First app" });
    await createApplication(admin, { name: "Admin app" });
    await createApplication(owner, { name: "Third app" });

    const memberList = await settingsApp(member).request(
      `/settings/workspaces/${workspaceSlug}/applications?limit=2`,
      {},
      { DB: env.DB },
    );
    expect(memberList.status).toBe(200);
    const firstPage = (await memberList.json()) as {
      data: {
        items: ReadonlyArray<ExternalApiApplicationData>;
        nextCursor?: string;
        permissions: ReadonlyArray<string>;
      };
    };
    expect(firstPage.data.items).toHaveLength(2);
    expect(firstPage.data.nextCursor).toBeDefined();
    expect(firstPage.data.permissions).toEqual(["applications:read"]);
    const secondPage = await settingsApp(member).request(
      `/settings/workspaces/${workspaceSlug}/applications?limit=2&cursor=${encodeURIComponent(firstPage.data.nextCursor ?? "")}`,
      {},
      { DB: env.DB },
    );
    expect(secondPage.status).toBe(200);
    await expect(secondPage.json()).resolves.toMatchObject({
      data: { items: [expect.any(Object)] },
    });

    const memberMutation = await settingsApp(member).request(
      `/settings/workspaces/${workspaceSlug}/applications`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          name: "Forbidden app",
          scopes: ["projects:read"],
          rateLimitPerMinute: 60,
        }),
      },
      { DB: env.DB },
    );
    expect(memberMutation.status).toBe(403);

    const unsupported = await settingsApp(owner).request(
      `/settings/workspaces/${workspaceSlug}/applications`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          name: "Overpowered app",
          scopes: ["agents:access"],
          rateLimitPerMinute: 60,
        }),
      },
      { DB: env.DB },
    );
    expect(unsupported.status).toBe(400);
    await expect(unsupported.json()).resolves.toMatchObject({
      data: { code: "UNSUPPORTED_EXTERNAL_API_APPLICATION_SCOPE" },
    });

    const outsiderList = await settingsApp(outsider).request(
      `/settings/workspaces/${workspaceSlug}/applications`,
      {},
      { DB: env.DB },
    );
    expect(outsiderList.status).toBe(403);
    const crossWorkspaceMutation = await settingsApp(otherOwner).request(
      `/settings/workspaces/${otherWorkspaceSlug}/applications/${first.data.application.id}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({
          name: "Cross-workspace update",
          scopes: ["projects:read"],
          rateLimitPerMinute: 60,
        }),
      },
      { DB: env.DB },
    );
    expect(crossWorkspaceMutation.status).toBe(404);
    const oversized = await settingsApp(owner).request(
      `/settings/workspaces/${workspaceSlug}/applications?limit=101`,
      {},
      { DB: env.DB },
    );
    expect(oversized.status).toBe(400);
  });

  it("authenticates client credentials and maps every grantable scope only to stable Project and Thread actions", async () => {
    const cases: ReadonlyArray<{
      readonly scope: ExternalApiApplicationScope;
      readonly allowedPath: string;
      readonly allowedInit?: RequestInit;
      readonly deniedPath: string;
      readonly deniedInit?: RequestInit;
    }> = [
      {
        scope: "projects:read",
        allowedPath: "/v1/projects",
        deniedPath: "/v1/projects",
        deniedInit: {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ name: "Denied" }),
        },
      },
      {
        scope: "projects:write",
        allowedPath: "/v1/projects",
        allowedInit: {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ name: "created-by-application" }),
        },
        deniedPath: "/v1/projects",
      },
      {
        scope: "threads:read",
        allowedPath: "/v1/threads",
        deniedPath: "/v1/threads",
        deniedInit: {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            projectId: "prj_00000000-0000-4000-8000-000000000050",
            title: "Test thread",
          }),
        },
      },
      {
        scope: "threads:write",
        allowedPath: "/v1/threads",
        allowedInit: {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            projectId: "prj_00000000-0000-4000-8000-000000000050",
            title: "Test thread",
          }),
        },
        deniedPath: "/v1/threads",
      },
    ];

    for (const testCase of cases) {
      const { application, clientSecret } = (
        await createApplication(owner, {
          name: testCase.scope,
          scopes: [testCase.scope],
        })
      ).data;
      const allowed = await productRequest(
        application,
        clientSecret,
        testCase.allowedPath,
        testCase.allowedInit,
      );
      expect(allowed.status, testCase.scope).toBe(
        testCase.allowedInit?.method === "POST" ? 201 : 200,
      );
      if (testCase.scope === "projects:write") {
        await expect(allowed.json()).resolves.toMatchObject({
          data: { workspaceId: "applications-workspace" },
        });
      }
      const denied = await productRequest(
        application,
        clientSecret,
        testCase.deniedPath,
        testCase.deniedInit,
      );
      expect(denied.status, testCase.scope).toBe(403);
    }

    const { application, clientSecret } = (await createApplication(owner)).data;
    for (const [path, init] of [
      ["/v1/settings/personal", {}],
      ["/v1/agents/dx/thr_hidden", {}],
      ["/v1/projects/hidden/experimental", {}],
      ["/v1/projects/hidden", { method: "DELETE" }],
    ] as const) {
      const response = await productRequest(
        application,
        clientSecret,
        path,
        init,
      );
      expect(response.status, path).toBe(403);
    }

    const invalidSecret = await productRequest(
      application,
      "dxs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "/v1/projects",
    );
    expect(invalidSecret.status).toBe(401);
    expect(invalidSecret.headers.get("www-authenticate")).toBe(
      'Basic realm="dx external API"',
    );
  });

  it("enforces current workspace policy for application-authenticated product writes", async () => {
    const { application, clientSecret } = (
      await createApplication(owner, {
        name: "Policy-bound app",
        scopes: ["projects:write"],
      })
    ).data;
    await env.DB.prepare(
      "UPDATE workspace_policy SET allow_remote_runners = 0 WHERE workspace_id = ?",
    )
      .bind("applications-workspace")
      .run();

    const denied = await productRequest(
      application,
      clientSecret,
      "/v1/projects",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ name: "denied-by-workspace-policy" }),
      },
    );

    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      data: {
        code: "WORKSPACE_POLICY_DENIED",
        reason: "remote-runner-disabled",
      },
    });
  });

  it("supports bounded rotation overlap and immediate disable, membership removal, and revocation", async () => {
    const created = await createApplication(admin, {
      name: "Rotating app",
      scopes: ["projects:read"],
    });
    const { application, clientSecret: previousSecret } = created.data;
    const rotation = await settingsApp(admin).request(
      `/settings/workspaces/${workspaceSlug}/applications/${application.id}/rotate`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ overlapSeconds: 300 }),
      },
      { DB: env.DB },
    );
    expect(rotation.status).toBe(200);
    const rotated = (await rotation.json()) as {
      data: ExternalApiApplicationSecretData;
    };
    expect(rotated.data.clientSecret).not.toBe(previousSecret);
    expect(
      (await productRequest(application, previousSecret, "/v1/projects"))
        .status,
    ).toBe(200);
    expect(
      (
        await productRequest(
          application,
          rotated.data.clientSecret,
          "/v1/projects",
        )
      ).status,
    ).toBe(200);

    await env.DB.prepare(
      "UPDATE external_api_application_credential SET expires_at = ? WHERE application_id = ? AND expires_at IS NOT NULL",
    )
      .bind(Date.now() - 1, application.id)
      .run();
    expect(
      (await productRequest(application, previousSecret, "/v1/projects"))
        .status,
    ).toBe(401);

    const disable = await settingsApp(admin).request(
      `/settings/workspaces/${workspaceSlug}/applications/${application.id}/disable`,
      { method: "POST", headers: jsonHeaders, body: "{}" },
      { DB: env.DB },
    );
    expect(disable.status).toBe(200);
    expect(
      (
        await productRequest(
          application,
          rotated.data.clientSecret,
          "/v1/projects",
        )
      ).status,
    ).toBe(401);
    const enable = await settingsApp(admin).request(
      `/settings/workspaces/${workspaceSlug}/applications/${application.id}/enable`,
      { method: "POST", headers: jsonHeaders, body: "{}" },
      { DB: env.DB },
    );
    expect(enable.status).toBe(200);
    expect(
      (
        await productRequest(
          application,
          rotated.data.clientSecret,
          "/v1/projects",
        )
      ).status,
    ).toBe(200);

    await env.DB.prepare("DELETE FROM member WHERE id = ?")
      .bind("applications-admin-member")
      .run();
    expect(
      (
        await productRequest(
          application,
          rotated.data.clientSecret,
          "/v1/projects",
        )
      ).status,
    ).toBe(401);

    const ownerApplication = await createApplication(owner, {
      name: "Revoked app",
      scopes: ["projects:read"],
    });
    const revoke = await settingsApp(owner).request(
      `/settings/workspaces/${workspaceSlug}/applications/${ownerApplication.data.application.id}`,
      { method: "DELETE" },
      { DB: env.DB },
    );
    expect(revoke.status).toBe(200);
    expect(
      (
        await productRequest(
          ownerApplication.data.application,
          ownerApplication.data.clientSecret,
          "/v1/projects",
        )
      ).status,
    ).toBe(401);
  });

  it("enforces an atomic per-app rate limit and records last-used and immutable request attribution", async () => {
    const { application, clientSecret } = (
      await createApplication(owner, {
        name: "Rate-limited app",
        scopes: ["projects:read"],
        rateLimitPerMinute: 10,
      })
    ).data;
    for (let index = 1; index <= 10; index += 1) {
      const response = await productRequest(
        application,
        clientSecret,
        "/v1/projects",
        { headers: { "x-request-id": `application-request-${index}` } },
      );
      expect(response.status).toBe(200);
    }
    const limited = await productRequest(
      application,
      clientSecret,
      "/v1/projects",
      { headers: { "x-request-id": "application-request-11" } },
    );
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    const persisted = await env.DB.prepare(
      "SELECT last_used_at FROM external_api_application WHERE id = ?",
    )
      .bind(application.id)
      .first<{ last_used_at: number | null }>();
    expect(persisted?.last_used_at).toEqual(expect.any(Number));
    const authorized = await env.DB.prepare(
      `SELECT actor_type, actor_id, credential_id, scope, request_id,
              http_method, http_path, outcome
       FROM external_api_application_audit
       WHERE application_id = ? AND request_id = ?`,
    )
      .bind(application.id, "application-request-1")
      .first();
    expect(authorized).toEqual({
      actor_type: "application",
      actor_id: application.id,
      credential_id: application.credential.id,
      scope: "projects:read",
      request_id: "application-request-1",
      http_method: "GET",
      http_path: "/v1/projects",
      outcome: "authorized",
    });
    const rejected = await env.DB.prepare(
      `SELECT actor_id, credential_id, request_id, http_method, http_path, outcome
       FROM external_api_application_audit
       WHERE application_id = ? AND request_id = ?`,
    )
      .bind(application.id, "application-request-11")
      .first();
    expect(rejected).toEqual({
      actor_id: application.id,
      credential_id: application.credential.id,
      request_id: "application-request-11",
      http_method: "GET",
      http_path: "/v1/projects",
      outcome: "rejected",
    });

    const auditId = await env.DB.prepare(
      "SELECT id FROM external_api_application_audit WHERE application_id = ? LIMIT 1",
    )
      .bind(application.id)
      .first<string>("id");
    await expect(
      env.DB.prepare(
        "UPDATE external_api_application_audit SET outcome = 'rejected' WHERE id = ?",
      )
        .bind(auditId)
        .run(),
    ).rejects.toBeDefined();
    await expect(
      env.DB.prepare("DELETE FROM external_api_application_audit WHERE id = ?")
        .bind(auditId)
        .run(),
    ).rejects.toBeDefined();
  });
});
