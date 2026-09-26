import { WorkspacePolicyDenied } from "@dx/domain";
import { Effect } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv, Bindings } from "../../http/types.js";

const mocks = vi.hoisted(() => ({
  browser: vi.fn(() => Effect.succeed({ sessionId: "browser-session" })),
  dbCalls: 0,
  decodeD1Binding: () => {
    mocks.dbCalls += 1;
    return Effect.succeed({} as D1Database);
  },
  evaluateForUser: (userId: string, action: unknown) => {
    mocks.evaluations.push([userId, action] as const);
    return Effect.fail(
      new WorkspacePolicyDenied({
        reason: "personal-secret-overrides-disabled",
      }),
    );
  },
  evaluations: [] as Array<readonly [string, unknown]>,
  provider: vi.fn(),
  readConnection: vi.fn(),
}));

vi.mock("@effect/sql-d1", async () => {
  const { Layer } = await import("effect");
  return { D1Client: { layer: () => Layer.empty } };
});
vi.mock("../../auth/browser-session.js", () => ({
  BrowserSessionRequired: class BrowserSessionRequired extends Error {},
  requireBrowserSession: mocks.browser,
}));
vi.mock("../../auth/requirements.js", () => ({
  loadAuthenticationRequirements: () => Effect.succeed({}),
}));
vi.mock("../../auth/better-auth.js", () => ({ createAuth: () => ({}) }));
vi.mock("../../persistence/d1-binding.js", () => ({
  decodeD1Binding: mocks.decodeD1Binding,
}));
vi.mock("../../settings/workspace/repository-d1.js", async () => {
  const { Layer } = await import("effect");
  return { WorkspaceRepositoryD1: () => Layer.empty };
});
vi.mock("../../settings/workspace-policy/repository-d1.js", async () => {
  const { Layer } = await import("effect");
  return { WorkspacePolicyRepositoryD1: () => Layer.empty };
});
vi.mock("../../settings/service.js", async () => ({
  SettingsService: { layer: (await import("effect")).Layer.empty },
}));
vi.mock("../../settings/audit.js", async () => ({
  SettingsAudit: { layer: (await import("effect")).Layer.empty },
}));
vi.mock("./control-plane.js", () => ({
  BitbucketInvalid: class BitbucketInvalid extends Error {},
  bitbucketControlPlaneFor: mocks.provider,
  disconnectBitbucket: vi.fn(),
  readBitbucketConnection: mocks.readConnection,
}));
vi.mock("../../settings/workspace-policy/service.js", async () => {
  const { Context, Layer } = await import("effect");
  class WorkspacePolicyService extends Context.Service<
    WorkspacePolicyService,
    {
      readonly evaluateForUser: typeof mocks.evaluateForUser;
    }
  >()("test/WorkspacePolicyService") {
    static readonly layer = Layer.succeed(WorkspacePolicyService, {
      evaluateForUser: mocks.evaluateForUser,
    });
  }
  return { WorkspacePolicyService };
});

import { bitbucketControlPlaneRoutes } from "./routes.js";

describe("Bitbucket personal refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbCalls = 0;
    mocks.evaluations.length = 0;
  });

  it("reports the exact disabled sentinel without constructing a provider", async () => {
    mocks.readConnection.mockResolvedValueOnce(null);
    const app = new Hono<AppEnv>();
    app.use("*", async (context, next) => {
      context.set("requestId", "request-bitbucket-status");
      context.set("principal", {
        userId: "preview-user",
        credentialScopes: ["personal"],
      } as never);
      await next();
    });
    app.route("/", bitbucketControlPlaneRoutes);

    const response = await app.request("/personal/connection", undefined, {
      DX_AUTH_URL: "https://dx.test",
      DX_RUNTIME_MODE: "deployed",
      DX_INTEGRATION_BITBUCKET_OAUTH: "{}",
      DB: {} as D1Database,
    } satisfies Bindings);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { configured: false, connection: null },
    });
    expect(mocks.readConnection).toHaveBeenCalledOnce();
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it("checks personal-secret policy before connection status or provider traffic", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", async (context, next) => {
      context.set("requestId", "request-bitbucket-refresh");
      context.set("principal", {
        userId: "denied-user",
        credentialScopes: ["personal"],
      } as never);
      await next();
    });
    app.route("/", bitbucketControlPlaneRoutes);
    const bindings = {
      DX_AUTH_URL: "https://dx.test",
      DX_RUNTIME_MODE: "deployed",
      DX_INTEGRATION_BITBUCKET_OAUTH: "configured",
      DB: {} as D1Database,
    } satisfies Bindings;

    const response = await app.request(
      "/personal/refresh",
      { method: "POST", headers: { origin: "https://dx.test" } },
      bindings,
    );

    expect(response.status).toBe(403);
    expect(mocks.browser).toHaveBeenCalledOnce();
    expect(mocks.evaluations).toEqual([
      ["denied-user", { kind: "secret.use-personal-override" }],
    ]);
    expect(mocks.dbCalls).toBe(1);
    expect(mocks.readConnection).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });
});
