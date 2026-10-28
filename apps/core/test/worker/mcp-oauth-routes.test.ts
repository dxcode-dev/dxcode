import { env } from "cloudflare:test";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { loadConfigEncryptionKeyring } from "../../src/settings/config-encryption.js";
import { resolveMcpAgentConnectionsFor } from "../../src/settings/mcp-servers/execution.js";
import { mcpOAuthAccessToken } from "../../src/settings/mcp-servers/oauth.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

/**
 * MCP OAuth, headers, and module IDs through the real routes, D1, and
 * encryption. Only the network is fake: DNS answers, an MCP server that
 * requires a bearer token, and an authorization server with dynamic client
 * registration and PKCE.
 */
const origin = "http://dx.test";
const password = "mcp-oauth-password-123";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  BETTER_AUTH_SECRET: "mcp-oauth-secret-00000000000000000",
};
const endpoint = "https://mcp.oauth.test/mcp";
const issuer = "https://auth.oauth.test";
const callback = `${origin}/v1/settings/personal/mcp-servers/oauth/callback`;

interface FakeState {
  supportsS256: boolean;
  challenge?: string;
  issued: number;
  refreshed: number;
  mcpHeaders: Array<Record<string, string>>;
}

const fake: FakeState = {
  supportsS256: true,
  issued: 0,
  refreshed: 0,
  mcpHeaders: [],
};

const base64Url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const validTokens = new Set<string>();

const fakeNetwork = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname === "1.1.1.1") {
    const type = url.searchParams.get("type");
    return json({
      Status: 0,
      Answer: type === "A" ? [{ type: 1, data: "93.184.216.34" }] : [],
    });
  }
  if (
    url.origin === "https://mcp.oauth.test" ||
    url.origin === "https://mcp2.oauth.test"
  ) {
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json({
        resource: `${url.origin}/mcp`,
        authorization_servers: [issuer],
        scopes_supported: ["read"],
      });
    }
    if (url.pathname.startsWith("/.well-known/")) return json({}, 404);
    if (request.method === "GET") return new Response(null, { status: 405 });
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (token === undefined || !validTokens.has(token)) {
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    }
    fake.mcpHeaders.push(Object.fromEntries(request.headers));
    const message = (await request.json()) as {
      readonly id?: number;
      readonly method: string;
    };
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === "initialize")
      return json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1" },
        },
      });
    if (message.method === "tools/list")
      return json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "search_docs",
              description: "Search the docs.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      });
    return json({ jsonrpc: "2.0", id: message.id, result: {} });
  }
  if (url.origin === issuer) {
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        ...(fake.supportsS256
          ? { code_challenge_methods_supported: ["S256"] }
          : {}),
      });
    if (url.pathname.startsWith("/.well-known/")) return json({}, 404);
    if (url.pathname === "/register") {
      const metadata = (await request.json()) as Record<string, unknown>;
      return json(
        { ...metadata, client_id: `client-${String(metadata.client_name)}` },
        201,
      );
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await request.text());
      if (form.get("grant_type") === "authorization_code") {
        const verifier = form.get("code_verifier") ?? "";
        const challenge = base64Url(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(verifier),
          ),
        );
        if (
          form.get("code") !== "good-code" ||
          challenge !== fake.challenge ||
          form.get("redirect_uri") !== callback
        )
          return json({ error: "invalid_grant" }, 400);
        fake.issued += 1;
        validTokens.add("access-1");
        return json({
          access_token: "access-1",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "refresh-1",
        });
      }
      if (
        form.get("grant_type") === "refresh_token" &&
        form.get("refresh_token") === "refresh-1"
      ) {
        fake.refreshed += 1;
        validTokens.add("access-2");
        return json({
          access_token: "access-2",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      return json({ error: "invalid_grant" }, 400);
    }
  }
  return new Response("unexpected", { status: 599 });
};

let signupIndex = 400;

const signup = async (email: string) => {
  signupIndex += 1;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `203.0.113.${signupIndex}`,
      },
      body: JSON.stringify({ name: "MCP OAuth", email, password }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Expected session cookie.");
  const body = await response.json<{ user: { id: string } }>();
  return { cookie, userId: body.user.id };
};

const call = (
  path: string,
  cookie: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  body?: unknown,
) =>
  app.request(
    path,
    {
      method,
      redirect: "manual",
      headers: {
        cookie,
        origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );

const base = "/v1/settings/personal/mcp-servers";

const authorize = async (cookie: string, id: string) => {
  const response = await call(
    `${base}/${id}/oauth/authorize`,
    cookie,
    "POST",
    {},
  );
  expect(response.status).toBe(201);
  const url = new URL(
    (await response.json<{ data: { authorizationUrl: string } }>()).data
      .authorizationUrl,
  );
  fake.challenge = url.searchParams.get("code_challenge") ?? undefined;
  return url;
};

const keyring = () => Effect.runPromise(loadConfigEncryptionKeyring(bindings));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP OAuth, headers, and module IDs", () => {
  it("signs a person in with PKCE, keeps every secret out of responses, and gates Threads on the sign-in", async () => {
    vi.stubGlobal("fetch", vi.fn(fakeNetwork));
    const { cookie, userId } = await signup("mcp-oauth@example.com");

    const created = await call(base, cookie, "POST", {
      name: "OAuth Docs",
      endpoint,
      authType: "auto",
      timeoutMs: 10_000,
      clientName: "dx test client",
      headers: [
        { name: "X-Org", value: "acme" },
        { name: "X-Api-Key", value: "header-secret-value", secret: true },
      ],
    });
    expect(created.status).toBe(201);
    const createdText = await created.text();
    expect(createdText).not.toContain("header-secret-value");
    const server = JSON.parse(createdText).data as {
      id: string;
      authType: string;
      moduleId: string;
      signedIn: boolean;
      headers: unknown;
    };
    // Automatic detection: a 401 with OAuth metadata means OAuth.
    expect(server).toMatchObject({
      authType: "oauth",
      moduleId: "oauth_docs",
      signedIn: false,
      headers: [
        { name: "X-Org", secret: false, value: "acme" },
        { name: "X-Api-Key", secret: true },
      ],
    });
    const storedSecret = await env.DB.prepare(
      "SELECT * FROM mcp_server_secret WHERE server_id = ?",
    )
      .bind(server.id)
      .all();
    expect(storedSecret.results).toHaveLength(1);
    expect(JSON.stringify(storedSecret.results)).not.toContain(
      "header-secret-value",
    );

    // Not signed in: a Thread does not see the server.
    const before = await Effect.runPromise(
      resolveMcpAgentConnectionsFor(
        env.DB,
        userId as never,
        "prj_any" as never,
      ),
    );
    expect(before.map(({ id }) => id)).not.toContain(server.id);

    const authorizationUrl = await authorize(cookie, server.id);
    expect(authorizationUrl.origin).toBe(issuer);
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "client-dx test client",
    );
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(callback);
    expect(authorizationUrl.searchParams.get("resource")).toBe(endpoint);
    const state = authorizationUrl.searchParams.get("state") ?? "";

    // A forged state is refused and stores nothing.
    const forged = await call(
      `${base}/oauth/callback?code=good-code&state=${"x".repeat(43)}`,
      cookie,
    );
    expect(forged.status).toBe(303);
    expect(forged.headers.get("location")).toContain("mcpStatus=failed");

    const finished = await call(
      `${base}/oauth/callback?code=good-code&state=${encodeURIComponent(state)}`,
      cookie,
    );
    expect(finished.status).toBe(303);
    const location = new URL(finished.headers.get("location") ?? "");
    expect(location.pathname).toBe("/settings/integrations");
    expect(location.searchParams.get("mcpStatus")).toBe("connected");
    expect(fake.issued).toBe(1);

    // The same state cannot be used twice.
    const replay = await call(
      `${base}/oauth/callback?code=good-code&state=${encodeURIComponent(state)}`,
      cookie,
    );
    expect(replay.headers.get("location")).toContain("mcpStatus=failed");
    expect(fake.issued).toBe(1);

    const grant = await env.DB.prepare(
      "SELECT * FROM mcp_oauth_grant WHERE server_id = ? AND user_id = ?",
    )
      .bind(server.id, userId)
      .first();
    expect(grant).not.toBeNull();
    expect(JSON.stringify(grant)).not.toContain("access-1");
    expect(JSON.stringify(grant)).not.toContain("refresh-1");

    // Signing in discovered the tools with the token and both headers.
    const listed = await call(base, cookie);
    const listedText = await listed.text();
    expect(listedText).not.toContain("access-1");
    expect(listedText).not.toContain("header-secret-value");
    const listedServer = (
      JSON.parse(listedText).data.items as Array<{
        id: string;
        signedIn: boolean;
        tools: Array<{ name: string; policy: string }>;
      }>
    ).find(({ id }) => id === server.id);
    expect(listedServer).toMatchObject({
      signedIn: true,
      tools: [{ name: "search_docs", policy: "allow" }],
    });
    expect(fake.mcpHeaders.at(-1)).toMatchObject({
      authorization: "Bearer access-1",
      "x-org": "acme",
      "x-api-key": "header-secret-value",
    });

    const after = await Effect.runPromise(
      resolveMcpAgentConnectionsFor(
        env.DB,
        userId as never,
        "prj_any" as never,
      ),
    );
    expect(after.find(({ id }) => id === server.id)).toMatchObject({
      moduleId: "oauth_docs",
      clientName: "dx test client",
      tools: ["search_docs"],
    });

    // An expiring token is refreshed once and the new one is stored.
    await env.DB.prepare(
      "UPDATE mcp_oauth_grant SET access_expires_at = ? WHERE server_id = ?",
    )
      .bind("2000-01-01T00:00:00.000Z", server.id)
      .run();
    const found = {
      id: server.id as never,
      target: { scope: "personal", id: userId } as never,
      endpoint,
    };
    await expect(
      mcpOAuthAccessToken(env.DB, await keyring(), found, userId),
    ).resolves.toBe("access-2");
    await expect(
      mcpOAuthAccessToken(env.DB, await keyring(), found, userId),
    ).resolves.toBe("access-2");
    expect(fake.refreshed).toBe(1);

    // Changing the URL ends every sign-in to the old one.
    const moved = await call(`${base}/${server.id}`, cookie, "PATCH", {
      endpoint: "https://mcp2.oauth.test/mcp",
    });
    expect(moved.status).toBe(200);
    expect(
      (await moved.json<{ data: { signedIn: boolean } }>()).data.signedIn,
    ).toBe(false);
    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM mcp_oauth_grant WHERE server_id = ?",
    )
      .bind(server.id)
      .first<{ count: number }>();
    expect(remaining?.count).toBe(0);
  });

  it("rejects a duplicate module ID, an Authorization header beside OAuth, and servers without PKCE", async () => {
    vi.stubGlobal("fetch", vi.fn(fakeNetwork));
    const { cookie } = await signup("mcp-oauth-rules@example.com");
    const first = await call(base, cookie, "POST", {
      name: "Docs",
      endpoint,
      authType: "oauth",
      timeoutMs: 10_000,
    });
    expect(first.status).toBe(201);
    const id = (await first.json<{ data: { id: string } }>()).data.id;

    const duplicate = await call(base, cookie, "POST", {
      name: "Docs again",
      endpoint,
      authType: "oauth",
      moduleId: "docs",
      timeoutMs: 10_000,
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.text()).toContain('"field":"moduleId"');

    const authorizationHeader = await call(base, cookie, "POST", {
      name: "Header auth",
      endpoint,
      authType: "oauth",
      timeoutMs: 10_000,
      headers: [{ name: "Authorization", value: "Bearer nope" }],
    });
    expect(authorizationHeader.status).toBe(400);
    expect(await authorizationHeader.text()).toContain('"field":"headers"');

    fake.supportsS256 = false;
    const noPkce = await call(
      `${base}/${id}/oauth/authorize`,
      cookie,
      "POST",
      {},
    );
    fake.supportsS256 = true;
    expect(noPkce.status).toBe(502);
    expect(await noPkce.text()).toContain("PKCE");
  });
});
