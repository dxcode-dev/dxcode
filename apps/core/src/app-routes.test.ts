import { defaultThreadModelSelection } from "@dx/domain";
import { start } from "@flue/runtime/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  env: { DX_RUNTIME_MODE: "deployed" },
}));
vi.mock("./auth/better-auth.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./auth/better-auth.js")>();
  return {
    ...original,
    createAuth: () => ({
      api: {
        verifyApiKey: async () => ({
          valid: true,
          key: {
            configId: "user-keys",
            referenceId: "test-user",
            permissions: { dx: ["agents:access"] },
          },
        }),
      },
    }),
  };
});
vi.mock("./auth/enforce-agent-workspace-policy.js", () => ({
  enforceAgentWorkspacePolicy: async (
    _context: unknown,
    next: () => Promise<void>,
  ) => next(),
}));
vi.mock("./auth/enforce-agent-source-admission.js", () => ({
  enforceAgentSourceAdmission: async (
    _context: unknown,
    next: () => Promise<void>,
  ) => next(),
}));

import { DxAgent } from "./agents/dx-agent.js";
import app from "./app.js";
import {
  createTestBindings,
  TEST_API_TOKEN,
  TEST_USER_ID,
} from "./testing/bindings.js";

const threadId = "thr_00000000-0000-4000-8000-000000000051";
const timingSafeEqual = vi.fn(
  (left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView) =>
    new TextDecoder().decode(left) === new TextDecoder().decode(right),
);
const startupBatches = vi.fn(async (_statements: ReadonlyArray<unknown>) => []);

const ownedThreadBinding = {
  prepare: () => ({
    bind: (...values: ReadonlyArray<unknown>) => ({
      values,
      all: async () => ({
        results: [
          {
            id: threadId,
            title: "Test thread",
            project_id: "prj_00000000-0000-4000-8000-000000000052",
            owner_user_id: TEST_USER_ID,
            agent_instructions: "",
            agent_instructions_revision: 0,
            agent_instructions_version: 1,
            model_selection: JSON.stringify(defaultThreadModelSelection()),
            plugin_snapshot_json: "[]",
            skill_snapshot_json: "[]",
            visibility: "private",
            workspace_policy_revision: 0,
            workspace_policy_migration_state: "grandfathered",
            created_at: "2026-08-20T12:00:00.000Z",
            updated_at: "2026-08-20T12:00:00.000Z",
            last_activity_at: "2026-08-20T12:00:00.000Z",
            activity_status: "idle",
            lifecycle_state: "active",
            pinned_at: null,
          },
        ],
      }),
    }),
  }),
  batch: startupBatches,
} as unknown as D1Database;

beforeEach(() => {
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    configurable: true,
    value: timingSafeEqual,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  timingSafeEqual.mockClear();
  startupBatches.mockClear();
  Reflect.deleteProperty(crypto.subtle, "timingSafeEqual");
});

describe("application route map", () => {
  it("mounts the native Flue agent routes under /v1/agents/dx", () => {
    const routes = app.routes.map(({ method, path }) => `${method} ${path}`);

    expect(routes).toEqual(
      expect.arrayContaining([
        "GET /api/workload-identity/.well-known/openid-configuration",
        "GET /api/workload-identity/jwks.json",
        "ALL /v1/*",
        "POST /v1/integrations/github/webhooks",
        "GET /v1/integrations/github/oauth/callback",
        "GET /v1/integrations/github/setup",
        "POST /v1/integrations/github/personal/authorize",
        "GET /v1/integrations/github/personal/grants",
        "POST /v1/projects",
        "GET /v1/projects",
        "GET /v1/projects/:projectId",
        "GET /v1/settings/personal/projects",
        "PUT /v1/settings/personal/projects",
        "GET /v1/settings/workspaces/:workspaceSlug/projects",
        "PUT /v1/settings/workspaces/:workspaceSlug/projects",
        "POST /v1/threads",
        "GET /v1/threads",
        "PATCH /v1/threads/:threadId/archive",
        "GET /v1/threads/:threadId",
        "GET /v1/threads/:threadId/changes",
        "GET /v1/threads/:threadId/changes/diff",
        "POST /v1/threads/:threadId/changes/push",
        "ALL /v1/agents/dx/:threadId",
        "ALL /v1/agents/dx/:threadId/:subpath{.+}",
        "POST /v1/agents/dx/:id",
        "ALL /v1/agents/dx/:id",
        "ALL /v1/agents/dx/:id/abort",
        "ALL /v1/agents/dx/:id/attachments/:attachmentId",
      ]),
    );
    expect(routes).not.toContain("POST /api/workload-identity/e2b/exchange");

    expect(routes.indexOf("ALL /v1/*")).toBeLessThan(
      routes.indexOf("POST /v1/projects"),
    );
    expect(
      routes.indexOf("POST /v1/integrations/github/webhooks"),
    ).toBeLessThan(routes.indexOf("ALL /v1/*"));
    expect(routes.indexOf("ALL /v1/*")).toBeLessThan(
      routes.indexOf("POST /v1/integrations/github/personal/authorize"),
    );
    expect(routes.indexOf("GET /v1/threads")).toBeLessThan(
      routes.indexOf("ALL /v1/agents/dx/:threadId"),
    );
    expect(
      routes.indexOf("ALL /v1/agents/dx/:threadId/:subpath{.+}"),
    ).toBeLessThan(routes.indexOf("POST /v1/agents/dx/:id"));
  });

  it("authenticates every method at the /v1 base and current or future subpaths", async () => {
    const methods = [
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ];
    const paths = [
      "/v1",
      "/v1/",
      "/v1/projects",
      `/v1/agents/dx/${threadId}`,
      `/v1/agents/dx/${threadId}/abort`,
      `/v1/agents/dx/${threadId}/attachments/attachment-1`,
      `/v1/agents/dx/${threadId}/future/native/path`,
    ];

    for (const method of methods) {
      for (const path of paths) {
        const response = await app.request(
          path,
          { method },
          createTestBindings(),
        );
        expect(response.status, `${method} ${path}`).toBe(401);
        expect(
          response.headers.get("www-authenticate"),
          `${method} ${path}`,
        ).toBe("Bearer");
      }
    }
  });

  it("preserves Flue's native validation envelope", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    await using _runtime = await start({ agents: [DxAgent], providers: [] });

    const response = await app.request(
      `/v1/agents/dx/${threadId}?wait=result`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
      createTestBindings({ DB: ownedThreadBinding }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      error: {
        type: "invalid_request",
        message: "Request is malformed.",
        details: expect.stringContaining("?wait=result"),
      },
    });
  });

  it("observes an admitted native Flue submission through the mounted app", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    await using _runtime = await start({ agents: [DxAgent], providers: [] });

    const response = await app.request(
      `/v1/agents/dx/${threadId}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          uid: null,
          initialData: {
            personalInstructions: "",
            settingsRevision: 0,
            settingsVersion: 1,
            selection: defaultThreadModelSelection(),
            mcpConnections: [],
            plugins: [],
            skills: [],
          },
          kind: "user",
          body: "Observe this admission.",
        }),
      },
      createTestBindings({ DB: ownedThreadBinding }),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("server-timing")).toContain(
      "dx_submission_accepted",
    );
    const receipt = (await response.json()) as {
      readonly submissionId: string;
    };
    expect(startupBatches).toHaveBeenCalledOnce();
    const statements = startupBatches.mock.calls[0]?.[0] as ReadonlyArray<{
      readonly values: ReadonlyArray<unknown>;
    }>;
    expect(statements.map(({ values }) => values[4])).toEqual([
      "request_admitted",
      "submission_accepted",
      "flue_queued",
    ]);
    expect(
      statements.map(({ values }) => ({
        threadId: values[2],
        submissionId: values[3],
      })),
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        threadId,
        submissionId: receipt.submissionId,
      })),
    );
  });
});
