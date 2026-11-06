import { env } from "cloudflare:test";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { loadConfigEncryptionKeyring } from "../../src/settings/config-encryption.js";
import { mcpOAuthAccessToken } from "../../src/settings/mcp-servers/oauth.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

/**
 * Which kind of OAuth client dx registers with an MCP server's authorization
 * server (#1848), through the real routes, D1, and encryption. Each fake
 * authorization server enforces its own rule the way real ones do: it
 * refuses a registration of the wrong kind with `invalid_client_metadata`,
 * and its token endpoint refuses a request whose client authentication does
 * not match the method the client was registered with.
 */
const origin = "http://dx.test";
const password = "mcp-oauth-registration-123";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  BETTER_AUTH_SECRET: "mcp-oauth-secret-00000000000000000",
};
const callback = `${origin}/v1/settings/personal/mcp-servers/oauth/callback`;
const base = "/v1/settings/personal/mcp-servers";

type ClientKind = "public" | "confidential";

interface AuthorizationServer {
  /** `token_endpoint_auth_methods_supported`; undefined omits it. */
  readonly advertises?: ReadonlyArray<string>;
  /** Kinds of client registration accepts. */
  readonly accepts: ReadonlyArray<ClientKind>;
  /** Whether a refusal carries an `error_description`. */
  readonly describesRefusal?: boolean;
  /** The refusal's own `error_description`, as a real server words it. */
  readonly refusalDescription?: string;
  /** Refuses with `invalid_request` naming the field, as some servers do. */
  readonly refusesAsInvalidRequest?: boolean;
  /** Returns a client_secret even to a public client, as some servers do. */
  readonly issuesSecretToPublic?: boolean;
}

interface RegisteredClient {
  readonly method: string;
  readonly secret?: string;
}

interface Scenario {
  readonly server: AuthorizationServer;
  readonly registrations: Array<string>;
  readonly clients: Map<string, RegisteredClient>;
  readonly tokenAuth: Array<string>;
  challenge?: string;
  readonly tokens: Set<string>;
  toolCalls: number;
}

const scenarios = new Map<string, Scenario>();

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const base64Url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const kindOf = (method: string): ClientKind =>
  method === "none" ? "public" : "confidential";

/** The token endpoint's client authentication check (RFC 6749 §2.3). */
const authenticate = (
  scenario: Scenario,
  request: Request,
  form: URLSearchParams,
): string | undefined => {
  const header = request.headers.get("authorization");
  let clientId = form.get("client_id") ?? undefined;
  let basicSecret: string | undefined;
  if (header?.startsWith("Basic ")) {
    // RFC 6749 §2.3.1: base64 of UTF-8 bytes, each part form-urlencoded.
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(header.slice(6)), (char) => char.charCodeAt(0)),
    );
    const [id = "", secret = ""] = decoded.split(":");
    const formDecoded = (value: string) =>
      decodeURIComponent(value.replace(/\+/g, " "));
    clientId = formDecoded(id);
    basicSecret = formDecoded(secret);
  }
  const client =
    clientId === undefined ? undefined : scenario.clients.get(clientId);
  if (client === undefined) return undefined;
  const postSecret = form.get("client_secret") ?? undefined;
  const used =
    basicSecret !== undefined
      ? "client_secret_basic"
      : postSecret !== undefined
        ? "client_secret_post"
        : "none";
  scenario.tokenAuth.push(used);
  if (used !== client.method) return undefined;
  if (used === "client_secret_basic" && basicSecret !== client.secret)
    return undefined;
  if (used === "client_secret_post" && postSecret !== client.secret)
    return undefined;
  return clientId;
};

const fakeNetwork = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname === "1.1.1.1") {
    return json({
      Status: 0,
      Answer:
        url.searchParams.get("type") === "A"
          ? [{ type: 1, data: "93.184.216.34" }]
          : [],
    });
  }
  const match = /^(mcp|auth)-([a-z-]+)\.oauth\.test$/.exec(url.hostname);
  const scenario = match === null ? undefined : scenarios.get(match[2] ?? "");
  if (match === null || scenario === undefined)
    return new Response("unexpected", { status: 599 });
  const issuer = `https://auth-${match[2]}.oauth.test`;
  if (match[1] === "mcp") {
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json({
        resource: `${url.origin}/mcp`,
        authorization_servers: [issuer],
      });
    if (url.pathname.startsWith("/.well-known/")) return json({}, 404);
    if (request.method === "GET") return new Response(null, { status: 405 });
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (token === undefined || !scenario.tokens.has(token))
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"`,
        },
      });
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
    if (message.method === "tools/list") {
      scenario.toolCalls += 1;
      return json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "lookup",
              description: "Look something up.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      });
    }
    return json({ jsonrpc: "2.0", id: message.id, result: {} });
  }
  const server = scenario.server;
  if (url.pathname === "/.well-known/oauth-authorization-server")
    return json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      ...(server.advertises === undefined
        ? {}
        : { token_endpoint_auth_methods_supported: server.advertises }),
    });
  if (url.pathname.startsWith("/.well-known/")) return json({}, 404);
  if (url.pathname === "/register") {
    const metadata = (await request.json()) as Record<string, unknown>;
    // RFC 7591 §2: omitted means client_secret_basic.
    const method =
      typeof metadata.token_endpoint_auth_method === "string"
        ? metadata.token_endpoint_auth_method
        : "client_secret_basic";
    scenario.registrations.push(method);
    if (!server.accepts.includes(kindOf(method))) {
      const required = server.accepts.includes("public")
        ? "none"
        : "client_secret_basic or client_secret_post";
      if (server.refusesAsInvalidRequest)
        return json(
          {
            error: "invalid_request",
            error_description:
              "Invalid value provided for: token_endpoint_auth_method",
          },
          400,
        );
      return json(
        {
          error: "invalid_client_metadata",
          ...(server.describesRefusal === false
            ? {}
            : {
                error_description:
                  server.refusalDescription ??
                  `token_endpoint_auth_method must be ${required}`,
              }),
        },
        400,
      );
    }
    const clientId = `client-${scenario.clients.size + 1}`;
    const secret =
      kindOf(method) === "confidential" || server.issuesSecretToPublic
        ? // Characters RFC 6749 §2.3.1 encoding must survive in Basic auth.
          `s3cr+t/${crypto.randomUUID()}:✓ é`
        : undefined;
    scenario.clients.set(clientId, {
      method,
      ...(secret === undefined ? {} : { secret }),
    });
    return json(
      {
        ...metadata,
        client_id: clientId,
        token_endpoint_auth_method: method,
        ...(secret === undefined ? {} : { client_secret: secret }),
      },
      201,
    );
  }
  if (url.pathname === "/token") {
    const form = new URLSearchParams(await request.text());
    if (authenticate(scenario, request, form) === undefined)
      return json({ error: "invalid_client" }, 401);
    if (form.get("grant_type") === "authorization_code") {
      const challenge = base64Url(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(form.get("code_verifier") ?? ""),
        ),
      );
      if (
        form.get("code") !== "good-code" ||
        challenge !== scenario.challenge ||
        form.get("redirect_uri") !== callback
      )
        return json({ error: "invalid_grant" }, 400);
      scenario.tokens.add(`access-${match[2]}-1`);
      return json({
        access_token: `access-${match[2]}-1`,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: `refresh-${match[2]}`,
      });
    }
    if (
      form.get("grant_type") === "refresh_token" &&
      form.get("refresh_token") === `refresh-${match[2]}`
    ) {
      scenario.tokens.add(`access-${match[2]}-2`);
      return json({
        access_token: `access-${match[2]}-2`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return json({ error: "invalid_grant" }, 400);
  }
  return new Response("unexpected", { status: 599 });
};

let signupIndex = 140;

const signup = async (name: string) => {
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
      body: JSON.stringify({
        name: "MCP registration",
        email: `mcp-registration-${name}@example.com`,
        password,
      }),
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
  method: "GET" | "POST" = "GET",
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

const scenario = (name: string, server: AuthorizationServer): Scenario => {
  const created: Scenario = {
    server,
    registrations: [],
    clients: new Map(),
    tokenAuth: [],
    tokens: new Set(),
    toolCalls: 0,
  };
  scenarios.set(name, created);
  return created;
};

const addServer = async (name: string) => {
  const { cookie, userId } = await signup(name);
  const created = await call(base, cookie, "POST", {
    name: `Server ${name}`,
    endpoint: `https://mcp-${name}.oauth.test/mcp`,
    authType: "oauth",
    timeoutMs: 10_000,
  });
  expect(created.status).toBe(201);
  const id = (await created.json<{ data: { id: string } }>()).data.id;
  return { cookie, userId, id };
};

/** Adds the server, signs in, and lists its tools; returns what happened. */
const signIn = async (name: string, current: Scenario) => {
  const { cookie, userId, id } = await addServer(name);
  const started = await call(
    `${base}/${id}/oauth/authorize`,
    cookie,
    "POST",
    {},
  );
  expect(started.status).toBe(201);
  const authorizationUrl = new URL(
    (await started.json<{ data: { authorizationUrl: string } }>()).data
      .authorizationUrl,
  );
  expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
    "S256",
  );
  current.challenge =
    authorizationUrl.searchParams.get("code_challenge") ?? undefined;
  const state = authorizationUrl.searchParams.get("state") ?? "";
  const finished = await call(
    `${base}/oauth/callback?code=good-code&state=${encodeURIComponent(state)}`,
    cookie,
  );
  expect(finished.status).toBe(303);
  expect(
    new URL(finished.headers.get("location") ?? "").searchParams.get(
      "mcpStatus",
    ),
  ).toBe("connected");

  const listed = await call(base, cookie);
  const listedText = await listed.text();
  for (const client of current.clients.values())
    if (client.secret !== undefined)
      expect(listedText).not.toContain(client.secret);
  const server = (
    JSON.parse(listedText).data.items as Array<{
      id: string;
      signedIn: boolean;
      tools: Array<{ name: string }>;
    }>
  ).find((item) => item.id === id);
  expect(server).toMatchObject({ signedIn: true, tools: [{ name: "lookup" }] });
  expect(current.toolCalls).toBeGreaterThan(0);

  // Refresh authenticates the same way the code exchange did.
  await env.DB.prepare(
    "UPDATE mcp_oauth_grant SET access_expires_at = ? WHERE server_id = ?",
  )
    .bind("2000-01-01T00:00:00.000Z", id)
    .run();
  await expect(
    mcpOAuthAccessToken(
      env.DB,
      await Effect.runPromise(loadConfigEncryptionKeyring(bindings)),
      {
        id: id as never,
        target: { scope: "personal", id: userId } as never,
        endpoint: `https://mcp-${name}.oauth.test/mcp`,
      },
      userId,
    ),
  ).resolves.toBe(`access-${name}-2`);
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP OAuth client registration (#1848)", () => {
  it("registers a public client when the server lists none beside secret methods", async () => {
    vi.stubGlobal("fetch", vi.fn(fakeNetwork));
    const current = scenario("lists-all", {
      advertises: ["client_secret_basic", "client_secret_post", "none"],
      accepts: ["public"],
    });
    await signIn("lists-all", current);
    expect(current.registrations).toEqual(["none"]);
    expect(current.tokenAuth).toEqual(["none", "none"]);
  });

  it("registers a public client with a server that lists every method but issues only public clients, as Basecamp does", async () => {
    vi.stubGlobal("fetch", vi.fn(fakeNetwork));
    // Basecamp's metadata and its answer to a secret registration, as
    // observed on 2026-11-05.
    const current = scenario("basecamp-like", {
      advertises: ["none", "client_secret_post", "client_secret_basic"],
      accepts: ["public"],
      refusalDescription:
        "Dynamic registration issues public clients only: register with token_endpoint_auth_method=none and use PKCE (S256), or skip registration and use a Client ID Metadata Document URL as client_id",
    });
    await signIn("basecamp-like", current);
    expect(current.registrations).toEqual(["none"]);
    expect(current.tokenAuth).toEqual(["none", "none"]);
  });

  it("registers a public client when the server lists no methods", async () => {
    vi.stubGlobal("fetch", vi.fn(fakeNetwork));
    const current = scenario("lists-nothing", { accepts: ["public"] });
    await signIn("lists-nothing", current);
    expect(current.registrations).toEqual(["none"]);
    expect(current.tokenAuth).toEqual(["none", "none"]);
  });

  it("sends no secret as a public client even when the server issued one", async () => {
    vi.stubGlobal("fetch", vi.fn(fakeNetwork));
    const current = scenario("public-with-secret", {
      advertises: ["none", "client_secret_basic"],
      accepts: ["public"],
      issuesSecretToPublic: true,
    });
    await signIn("public-with-secret", current);
    expect(current.registrations).toEqual(["none"]);
    expect(current.tokenAuth).toEqual(["none", "none"]);
  });

  it("registers a confidential client when the server lists only secret methods", async () => {
    vi.stubGlobal("fetch", vi.fn(fakeNetwork));
    const current = scenario("secret-post", {
      advertises: ["client_secret_post"],
      accepts: ["confidential"],
    });
    await signIn("secret-post", current);
    expect(current.registrations).toEqual(["client_secret_post"]);
    expect(current.tokenAuth).toEqual([
      "client_secret_post",
      "client_secret_post",
    ]);
  });

  it("retries once as a confidential client when a server that lists nothing requires a secret", async () => {
    vi.stubGlobal("fetch", vi.fn(fakeNetwork));
    const current = scenario("secret-unlisted", { accepts: ["confidential"] });
    await signIn("secret-unlisted", current);
    expect(current.registrations).toEqual(["none", "client_secret_basic"]);
    expect(current.tokenAuth).toEqual([
      "client_secret_basic",
      "client_secret_basic",
    ]);
  });

  it("retries when the server names the auth method in an invalid_request refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(fakeNetwork));
    const current = scenario("invalid-request", {
      accepts: ["confidential"],
      refusesAsInvalidRequest: true,
    });
    await signIn("invalid-request", current);
    expect(current.registrations).toEqual(["none", "client_secret_basic"]);
    expect(current.tokenAuth).toEqual([
      "client_secret_basic",
      "client_secret_basic",
    ]);
  });

  it("retries once as a public client when a server that lists only secrets requires none", async () => {
    vi.stubGlobal("fetch", vi.fn(fakeNetwork));
    const current = scenario("public-misadvertised", {
      advertises: ["client_secret_basic"],
      accepts: ["public"],
      describesRefusal: false,
    });
    await signIn("public-misadvertised", current);
    expect(current.registrations).toEqual(["client_secret_basic", "none"]);
    expect(current.tokenAuth).toEqual(["none", "none"]);
  });

  it("explains a refusal of both kinds in plain words", async () => {
    vi.stubGlobal("fetch", vi.fn(fakeNetwork));
    const current = scenario("refuses-both", { accepts: [] });
    const { cookie, id } = await addServer("refuses-both");
    const refused = await call(
      `${base}/${id}/oauth/authorize`,
      cookie,
      "POST",
      {},
    );
    expect(refused.status).toBe(502);
    const message = (
      await refused.json<{ data: { code: string; message: string } }>()
    ).data;
    expect(message.code).toBe("MCP_SERVER_OAUTH_FAILED");
    expect(current.registrations).toEqual(["none", "client_secret_basic"]);
    expect(message.message).toContain("token_endpoint_auth_method must be");
    expect(message.message).not.toMatch(
      /[{}]|HTTP 400|invalid_client_metadata/,
    );
  });
});
