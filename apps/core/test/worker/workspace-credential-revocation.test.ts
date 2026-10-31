import { env } from "cloudflare:test";
import { generateKeyPairSync } from "node:crypto";
import { type McpServerId, Principal, type UserId } from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { loadConfigEncryptionKeyring } from "../../src/settings/config-encryption.js";
import {
  IntegrationCredentialVault,
  IntegrationCredentialVaultD1,
} from "../../src/settings/integrations/credential-vault.js";
import {
  type McpOAuthGrantPayload,
  putMcpOAuthGrant,
} from "../../src/settings/mcp-servers/secrets.js";
import { settingsRoutes } from "../../src/settings/routes.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_GITHUB_APP_CONFIGURATION,
} from "../../src/testing/bindings.js";

// Deleting a workspace asks each provider to revoke the OAuth tokens it
// erases (#1299): its GitHub connection's token and every member's sign-in
// to its MCP servers. Only the network is fake.

const owner = "wscr-owner" as UserId;
const member = "wscr-member" as UserId;
const workspaceId = "wscr-workspace";
const slug = "wscr-team";
const githubClientId = "Iv1.wscr-client";

const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: "https://dx.test",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_INTEGRATION_GITHUB_APP: JSON.stringify({
    ...JSON.parse(TEST_GITHUB_APP_CONFIGURATION),
    clientId: githubClientId,
    clientSecret: "wscr-github-secret",
    privateKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
  }),
};

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

const deleteWorkspace = () => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId: owner,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  app.route("/settings", settingsRoutes);
  app.onError(errorHandler);
  return app.request(
    `/settings/workspaces/${slug}/delete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmShortName: slug, threads: "keep" }),
    },
    bindings,
    executionContext,
  );
};

// Two workspace MCP servers: one whose authorization server advertises RFC
// 7009 revocation, one whose does not; and a member's personal server,
// which deleting the workspace leaves alone.
const revocable = "mcp_00000000-0000-4000-8000-00000000c001" as McpServerId;
const unrevocable = "mcp_00000000-0000-4000-8000-00000000c002" as McpServerId;
const personal = "mcp_00000000-0000-4000-8000-00000000c003" as McpServerId;
const endpointOf = (id: McpServerId) => `https://${id.slice(-4)}.mcp.test/mcp`;

const tokens = {
  github: "gho_wscr-github-access",
  githubRefresh: "ghr_wscr-github-refresh",
  personalGithub: "gho_wscr-member-own",
  ownerRefresh: "mcp-owner-refresh",
  ownerAccess: "mcp-owner-access",
  memberRefresh: "mcp-member-refresh",
  memberAccess: "mcp-member-access",
  unrevocable: "mcp-unrevocable-access",
  personal: "mcp-personal-refresh",
} as const;

const grant = (
  authorizationServer: string,
  refreshToken: string | undefined,
  accessToken: string,
  revocation: boolean,
): McpOAuthGrantPayload => ({
  authorizationServerUrl: authorizationServer,
  metadata: {
    issuer: authorizationServer,
    authorization_endpoint: `${authorizationServer}/authorize`,
    token_endpoint: `${authorizationServer}/token`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    ...(revocation
      ? { revocation_endpoint: `${authorizationServer}/revoke` }
      : {}),
  },
  clientInformation: {
    client_id: "dx-registered-client",
    client_secret: "dx-registered-secret",
  },
  tokens: {
    access_token: accessToken,
    token_type: "Bearer",
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
  },
});

interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly authorization: string | null;
  /** Whether dx still held the credential when the provider was asked. */
  readonly heldLocally: boolean;
}

const network = {
  sent: [] as Array<SentRequest>,
  fail: false,
};

const heldLocally = async (url: URL) => {
  if (url.hostname === "api.github.com")
    return (
      ((
        await env.DB.prepare(
          "SELECT count(*) AS n FROM integration_credential WHERE owner_scope = 'workspace' AND owner_id = ?",
        )
          .bind(workspaceId)
          .first<{ n: number }>()
      )?.n ?? 0) > 0
    );
  return (
    ((
      await env.DB.prepare(
        "SELECT count(*) AS n FROM mcp_oauth_grant WHERE server_id = ?",
      )
        .bind(revocable)
        .first<{ n: number }>()
    )?.n ?? 0) > 0
  );
};

const logged: Array<string> = [];

beforeEach(async () => {
  network.sent.length = 0;
  network.fail = false;
  logged.length = 0;
  for (const level of ["debug", "info", "log", "warn", "error"] as const)
    vi.spyOn(console, level).mockImplementation((...values: unknown[]) => {
      logged.push(JSON.stringify(values));
    });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "1.1.1.1")
      return Response.json({
        Status: 0,
        Answer:
          url.searchParams.get("type") === "A"
            ? [{ type: 1, data: "93.184.216.34" }]
            : [],
      });
    network.sent.push({
      url: request.url,
      method: request.method,
      body: await request.text(),
      authorization: request.headers.get("authorization"),
      heldLocally: await heldLocally(url),
    });
    if (network.fail) {
      if (url.hostname === "api.github.com")
        return new Response(null, { status: 500 });
      throw new TypeError("connection reset");
    }
    return new Response(null, {
      status: url.hostname === "api.github.com" ? 204 : 200,
    });
  });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?1, 'Owner', 'wscr-owner@example.com', 1, 1, 1),
              (?2, 'Member', 'wscr-member@example.com', 1, 1, 1)`,
    ).bind(owner, member),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Revocation Team', ?, 1)",
    ).bind(workspaceId, slug),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES ('wscr-m-owner', ?1, ?2, 'owner', 1),
              ('wscr-m-member', ?1, ?3, 'member', 2)`,
    ).bind(workspaceId, owner, member),
    ...[
      [revocable, "workspace", workspaceId],
      [unrevocable, "workspace", workspaceId],
      [personal, "personal", member],
    ].map(([id, scope, target]) =>
      env.DB.prepare(
        `INSERT INTO mcp_server (
           id, scope, target_id, name, endpoint, transport, timeout_ms, enabled,
           project_ids_json, roles_json, health_status, created_at, updated_at,
           auth_type
         ) VALUES (?, ?, ?, ?, ?, 'streamable-http', 10000, 1, '[]',
           '["owner","admin","member"]', 'healthy', 'now', 'now', 'oauth')`,
      ).bind(id, scope, target, id, endpointOf(id as McpServerId)),
    ),
  ]);

  const keyring = await Effect.runPromise(
    loadConfigEncryptionKeyring(bindings),
  );
  const put = (
    ownerScope: "personal" | "workspace",
    ownerId: string,
    purpose: "access-token" | "refresh-token",
    value: string,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const vault = yield* IntegrationCredentialVault;
        return yield* vault.put(
          keyring,
          { scope: ownerScope, id: ownerId } as never,
          purpose,
          value,
        );
      }).pipe(Effect.provide(IntegrationCredentialVaultD1(env.DB))),
    );
  const workspaceAccess = await put(
    "workspace",
    workspaceId,
    "access-token",
    tokens.github,
  );
  const workspaceRefresh = await put(
    "workspace",
    workspaceId,
    "refresh-token",
    tokens.githubRefresh,
  );
  const personalAccess = await put(
    "personal",
    member,
    "access-token",
    tokens.personalGithub,
  );
  await env.DB.prepare(
    `INSERT INTO integration_connection (id, owner_scope, owner_id, provider,
       status, health, provider_account_id, provider_account_login,
       granted_scopes, access_token_reference_id, refresh_token_reference_id,
       revocation_status, created_at, updated_at)
     VALUES ('wscr-int-ws', 'workspace', ?1, 'github', 'connected', 'healthy',
               'acct', 'team', '[]', ?2, ?3, 'not-requested', 'now', 'now'),
            ('wscr-int-me', 'personal', ?4, 'github', 'connected', 'healthy',
               'acct-me', 'me', '[]', ?5, NULL, 'not-requested', 'now', 'now')`,
  )
    .bind(
      workspaceId,
      workspaceAccess.id,
      workspaceRefresh.id,
      member,
      personalAccess.id,
    )
    .run();

  const server = (id: McpServerId, scope: "personal" | "workspace") => ({
    id,
    target: { scope, id: scope === "workspace" ? workspaceId : member },
  });
  const now = new Date();
  const store = (
    id: McpServerId,
    scope: "personal" | "workspace",
    userId: string,
    payload: McpOAuthGrantPayload,
  ) =>
    putMcpOAuthGrant(
      env.DB,
      keyring,
      server(id, scope) as never,
      userId,
      endpointOf(id),
      payload,
      now,
    );
  await store(
    revocable,
    "workspace",
    owner,
    grant(
      "https://auth-a.oauth.test",
      tokens.ownerRefresh,
      tokens.ownerAccess,
      true,
    ),
  );
  await store(
    revocable,
    "workspace",
    member,
    grant(
      "https://auth-a.oauth.test",
      tokens.memberRefresh,
      tokens.memberAccess,
      true,
    ),
  );
  await store(
    unrevocable,
    "workspace",
    owner,
    grant("https://auth-b.oauth.test", undefined, tokens.unrevocable, false),
  );
  await store(
    personal,
    "personal",
    member,
    grant(
      "https://auth-a.oauth.test",
      tokens.personal,
      "mcp-personal-access",
      true,
    ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const audits = () =>
  logged
    .flatMap((line) => JSON.parse(line) as Array<Record<string, unknown>>)
    .filter(
      (record) =>
        typeof record === "object" &&
        record !== null &&
        record.action === "workspace.credential.revoke",
    );

const remaining = async () => ({
  workspaceCredentials: (
    await env.DB.prepare(
      "SELECT count(*) AS n FROM integration_credential WHERE owner_scope = 'workspace' AND owner_id = ?",
    )
      .bind(workspaceId)
      .first<{ n: number }>()
  )?.n,
  workspaceGrants: (
    await env.DB.prepare(
      "SELECT count(*) AS n FROM mcp_oauth_grant WHERE server_id IN (?, ?)",
    )
      .bind(revocable, unrevocable)
      .first<{ n: number }>()
  )?.n,
  personalGrants: (
    await env.DB.prepare(
      "SELECT count(*) AS n FROM mcp_oauth_grant WHERE server_id = ?",
    )
      .bind(personal)
      .first<{ n: number }>()
  )?.n,
});

const expectNoTokenLogged = () => {
  const output = logged.join("\n");
  for (const token of Object.values(tokens))
    expect(output, "a token was logged").not.toContain(token);
};

describe("revoking a deleted workspace's OAuth tokens at their providers", () => {
  it("asks each provider once per credential, before erasing it", async () => {
    const response = await deleteWorkspace();
    expect(response.status).toBe(200);

    const github = network.sent.filter(
      ({ url }) =>
        url === `https://api.github.com/applications/${githubClientId}/token`,
    );
    expect(github).toHaveLength(1);
    expect(github[0]).toMatchObject({ method: "DELETE", heldLocally: true });
    expect(JSON.parse(github[0]?.body ?? "{}")).toEqual({
      access_token: tokens.github,
    });

    const mcp = network.sent.filter(
      ({ url }) => url === "https://auth-a.oauth.test/revoke",
    );
    expect(mcp).toHaveLength(2);
    const bodies = mcp.map(({ body }) =>
      Object.fromEntries(new URLSearchParams(body)),
    );
    expect(bodies).toEqual(
      expect.arrayContaining(
        [tokens.ownerRefresh, tokens.memberRefresh].map((token) => ({
          token,
          token_type_hint: "refresh_token",
          client_id: "dx-registered-client",
          client_secret: "dx-registered-secret",
        })),
      ),
    );
    for (const request of mcp) {
      expect(request.method).toBe("POST");
      expect(request.heldLocally).toBe(true);
    }

    // Nothing else went out: no request for the member's own connection or
    // personal server.
    expect(network.sent).toHaveLength(3);

    await expect(remaining()).resolves.toEqual({
      workspaceCredentials: 0,
      workspaceGrants: 0,
      personalGrants: 1,
    });
    expect(audits()).toHaveLength(4);
    expect(
      audits().filter(({ revocation }) => revocation === "completed"),
    ).toHaveLength(3);
    expectNoTokenLogged();
  });

  it("deletes the workspace even when every provider fails", async () => {
    network.fail = true;
    const response = await deleteWorkspace();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { deleted: true },
    });
    // Each was tried once; none was retried.
    expect(network.sent).toHaveLength(3);
    await expect(remaining()).resolves.toEqual({
      workspaceCredentials: 0,
      workspaceGrants: 0,
      personalGrants: 1,
    });
    const failed = audits().filter(({ revocation }) => revocation === "failed");
    expect(failed).toHaveLength(3);
    for (const record of failed) expect(record.outcome).toBe("rejected");
    expectNoTokenLogged();
  });

  it("sends nothing for a server that advertises no revocation endpoint", async () => {
    const response = await deleteWorkspace();
    expect(response.status).toBe(200);
    expect(
      network.sent.filter(({ url }) => url.includes("auth-b.oauth.test")),
    ).toEqual([]);
    expect(
      audits().filter(({ mcpServerId }) => mcpServerId === unrevocable),
    ).toEqual([
      expect.objectContaining({
        revocation: "unsupported",
        outcome: "success",
      }),
    ]);
    await expect(remaining()).resolves.toMatchObject({ workspaceGrants: 0 });
    expectNoTokenLogged();
  });
});
