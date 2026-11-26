import { env } from "cloudflare:test";
import { PLUGIN_SERVICE_HTTP_TOKEN_PREFIX } from "@dx/domain";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { loadServiceInstall } from "../../src/plugins/services/installs.js";
import { createMcpNetworkFetch } from "../../src/settings/mcp-servers/transport.js";
import { pluginPermissionDiff } from "../../src/settings/plugins/bundles/permission-diff.js";
import { createTestBindings } from "../../src/testing/bindings.js";
import { direct as r2Transfer } from "./r2-harness.js";

/**
 * A plugin program's internet address (`service.http`), Core's half over
 * real D1, with dxd on the plugin Orb behind a fake execution object that
 * answers `service.call` as a small MCP server would. dxd's own half (the
 * buffered `service.call`) is proven in apps/dxd/tests and on the preview.
 *
 * Ways it could fail, each covered below:
 * - a request with no token, an unknown token, or a token for another path
 *   wakes the Orb, or reaches the program;
 * - a revoked token keeps working;
 * - a disabled plugin, or one that never declared `service.http`, still
 *   answers, or wakes its Orb;
 * - an oversized body or a flood of bad requests reaches the Orb, or
 *   a rate limit slows callers that hold a valid token;
 * - the token, cookies, or the body leak to the program or the audit;
 * - dx's own MCP client (the network fetch Code uses) cannot initialize,
 *   list, and call a tool through the address;
 * - an update that adds `service.http` installs without a new review;
 * - the program is never told its address.
 */

const now = "2026-11-26T10:00:00.000Z";
const ORIGIN = "https://dx.example.com";

const sha256Hex = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const installService = async (http: boolean) => {
  const userId = `usr_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
     VALUES (?, 'p', ?, 1, 1, 1)`,
  )
    .bind(userId, `${userId}@example.com`)
    .run();
  await env.DB.prepare(
    `INSERT INTO plugin_orb_choice (scope, target_id, runner_profile_id, updated_by, updated_at)
     VALUES ('personal', ?, 'a1.medium', ?, ?)`,
  )
    .bind(userId, userId, now)
    .run();
  const pluginId = `plg_${crypto.randomUUID()}`;
  const name = `local-mcp-${crypto.randomUUID().slice(0, 8)}`;
  const manifest = {
    format: "agent-plugins",
    name,
    displayName: "Local MCP",
    description: "Runs MCP servers.",
    skills: [],
    mcpServers: [],
    code: {
      apiVersion: 1,
      host: "worker",
      modules: [],
      permissions: {
        events: [],
        network: [],
        secrets: [],
        tools: [],
        ai: false,
      },
      settings: [],
      service: {
        run: "node service.mjs",
        orb: "own",
        keepRunning: true,
        ...(http ? { http: true } : {}),
      },
    },
    skipped: [],
    package: { sha256: "a".repeat(64), size: 10 },
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO trusted_plugin (
         id, scope, target_id, name, enabled, active_version, health_status,
         created_at, updated_at, kind
       ) VALUES (?, 'personal', ?, ?, 1, '1.0.0', 'unchecked', ?, ?, 'bundle')`,
    ).bind(pluginId, userId, name, now, now),
    env.DB.prepare(
      `INSERT INTO trusted_plugin_version (
         plugin_id, version, manifest_json, grants_json, source_json,
         integrity, trusted, trusted_at, trusted_by_user_id
       ) VALUES (?, '1.0.0', ?, '{}', '{"type":"zip","label":"t.zip"}', ?, 1, ?, ?)`,
    ).bind(pluginId, JSON.stringify(manifest), "b".repeat(64), now, userId),
  ]);
  return { pluginId, userId };
};

const issueToken = async (pluginId: string, token: string, path?: string) =>
  env.DB.prepare(
    `INSERT INTO plugin_install_storage (plugin_id, key, value_json, updated_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(
      pluginId,
      `${PLUGIN_SERVICE_HTTP_TOKEN_PREFIX}${await sha256Hex(token)}`,
      JSON.stringify(path === undefined ? {} : { path }),
      now,
    )
    .run();

interface Envelope {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** What a stdio MCP server behind the plugin's bridge answers. */
const mcpProgram = (envelope: Envelope) => {
  if (envelope.method === "GET")
    return { status: 405, headers: { allow: "POST, DELETE" }, body: null };
  if (envelope.method === "DELETE") return { status: 200, body: null };
  const message = JSON.parse(envelope.body) as {
    id?: number;
    method: string;
    params?: { protocolVersion?: string; arguments?: { text?: string } };
  };
  if (message.id === undefined) return { status: 202, body: null };
  const json = (result: unknown) => ({
    status: 200,
    headers: {
      "content-type": "application/json",
      "mcp-session-id": "session-1",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
  });
  switch (message.method) {
    case "initialize":
      return json({
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "grafana", version: "1.0.0" },
      });
    case "tools/list":
      return json({
        tools: [
          {
            name: "search_dashboards",
            description: "Finds dashboards.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
            },
          },
        ],
      });
    case "tools/call":
      return json({
        content: [
          {
            type: "text",
            text: `found: ${message.params?.arguments?.text ?? ""}`,
          },
        ],
      });
    default:
      return json({});
  }
};

/** dxd on the plugin Orb: every operation Core sent, and what it saw. */
const fakeDxd = () => {
  const operations: Array<{
    readonly operation: string;
    readonly path?: string;
    readonly body?: Envelope;
    readonly spec?: { readonly env: Record<string, string> };
  }> = [];
  const execution = {
    pluginService: async (
      _orbId: string,
      operation: {
        readonly operation: string;
        readonly path?: string;
        readonly body?: Envelope;
        readonly spec?: { readonly env: Record<string, string> };
      },
    ) => {
      operations.push(operation);
      if (operation.operation === "service.ensure")
        return {
          kind: "result",
          value: { kind: "status", state: "running", port: 41007 },
        };
      if (operation.path !== "/http" || operation.body === undefined)
        return {
          kind: "result",
          value: { kind: "response", status: 404, body: {} },
        };
      return {
        kind: "result",
        value: {
          kind: "response",
          status: 200,
          body: mcpProgram(operation.body),
        },
      };
    },
    keepPluginOrbAwake: async () => true,
  };
  const bindings = {
    ...createTestBindings(),
    ...r2Transfer,
    DB: env.DB,
    DX_AUTH_URL: ORIGIN,
    THREAD_EXECUTION: {
      idFromName: (name: string) => name,
      get: () => execution,
    } as unknown as Bindings["THREAD_EXECUTION"],
  } satisfies Bindings;
  return { operations, bindings };
};

const request = (
  bindings: Bindings,
  path: string,
  init: RequestInit = {},
): Promise<Response> =>
  Promise.resolve(app.request(`${ORIGIN}${path}`, init, bindings));

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "curl", version: "1" },
  },
});

const post = (token?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  },
  body: initializeBody,
});

describe("a plugin program's internet address", () => {
  it("lets dx's own MCP client initialize, list, and call a tool through it, with the token checked by Core and kept from the program", async () => {
    const { pluginId } = await installService(true);
    const token = "lmcp_grafana_0123456789abcdef0123456789abcdef";
    await issueToken(pluginId, token, "/mcp/grafana");
    const { bindings, operations } = fakeDxd();
    const endpoint = `${ORIGIN}/api/plugin-services/${pluginId}/http/mcp/grafana`;

    // The same network fetch Code's MCP connections use, reaching the
    // Worker in process instead of over the internet.
    const client = new Client({ name: "dx", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        fetch: createMcpNetworkFetch(endpoint, 30_000, {
          resolveDns: async () => ["104.16.0.1"],
          fetch: (input, init) =>
            Promise.resolve(
              app.request(new Request(input, init), {}, bindings),
            ),
        }),
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["search_dashboards"]);
    const result = await client.callTool({
      name: "search_dashboards",
      arguments: { text: "latency" },
    });
    expect(result.content).toEqual([{ type: "text", text: "found: latency" }]);
    await client.close();

    const calls = operations.filter((op) => op.operation === "service.call");
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) {
      expect(call.path).toBe("/http");
      expect(call.body?.path).toBe("/mcp/grafana");
      // The program never sees the token or any credential header.
      expect(JSON.stringify(call.body)).not.toContain(token);
      expect(Object.keys(call.body?.headers ?? {})).not.toContain(
        "authorization",
      );
    }
    // The program learns its own address.
    const ensure = operations.find((op) => op.operation === "service.ensure");
    expect(ensure?.spec?.env.DX_HTTP_URL).toBe(
      `${ORIGIN}/api/plugin-services/${pluginId}/http`,
    );

    // One audit row per accepted request, with no body or token.
    const { results: audits } = await env.DB.prepare(
      "SELECT action, target, outcome, detail_json FROM plugin_audit WHERE plugin_id = ?",
    )
      .bind(pluginId)
      .all<{
        action: string;
        target: string;
        outcome: string;
        detail_json: string;
      }>();
    expect(audits.length).toBe(calls.length);
    for (const row of audits) {
      expect(row).toMatchObject({
        action: "service.http",
        target: "/mcp/grafana",
        outcome: "success",
      });
      expect(row.detail_json).not.toContain(token);
      expect(row.detail_json).not.toContain("latency");
    }
  });

  it("refuses a missing, unknown, wrong-path, or revoked token with 401 before any Orb work", async () => {
    const { pluginId } = await installService(true);
    const token = "lmcp_one_0123456789abcdef0123456789abcdef";
    await issueToken(pluginId, token, "/mcp/one");
    const { bindings, operations } = fakeDxd();
    const base = `/api/plugin-services/${pluginId}/http`;

    for (const init of [
      post(),
      post("lmcp_unknown_0123456789abcdef0123456789abcd"),
      { ...post(), headers: { authorization: `Basic ${btoa("a:b")}` } },
    ]) {
      const refused = await request(bindings, `${base}/mcp/one`, init);
      expect(refused.status).toBe(401);
      expect(refused.headers.get("www-authenticate")).toBe("Bearer");
    }
    // A token for one server opens no other path.
    expect(
      (await request(bindings, `${base}/mcp/two`, post(token))).status,
    ).toBe(401);
    expect(
      (await request(bindings, `${base}/mcp/one-more`, post(token))).status,
    ).toBe(401);
    expect(operations).toEqual([]);

    // The right token on its path reaches the program.
    expect(
      (await request(bindings, `${base}/mcp/one`, post(token))).status,
    ).toBe(200);
    expect(operations.length).toBeGreaterThan(0);

    // Revoking it (the program deletes the key) works on the next request.
    await env.DB.prepare(
      "DELETE FROM plugin_install_storage WHERE plugin_id = ? AND key = ?",
    )
      .bind(
        pluginId,
        `${PLUGIN_SERVICE_HTTP_TOKEN_PREFIX}${await sha256Hex(token)}`,
      )
      .run();
    const before = operations.length;
    expect(
      (await request(bindings, `${base}/mcp/one`, post(token))).status,
    ).toBe(401);
    expect(operations.length).toBe(before);
  });

  it("answers 404 at once for a disabled plugin, a removed one, or one with no service.http", async () => {
    const { bindings, operations } = fakeDxd();
    const token = "lmcp_any_0123456789abcdef0123456789abcdef0";

    const plain = await installService(false);
    await issueToken(plain.pluginId, token);
    expect(
      (
        await request(
          bindings,
          `/api/plugin-services/${plain.pluginId}/http/mcp`,
          post(token),
        )
      ).status,
    ).toBe(404);

    const off = await installService(true);
    await issueToken(off.pluginId, token);
    await env.DB.prepare("UPDATE trusted_plugin SET enabled = 0 WHERE id = ?")
      .bind(off.pluginId)
      .run();
    expect(
      (
        await request(
          bindings,
          `/api/plugin-services/${off.pluginId}/http/mcp`,
          post(token),
        )
      ).status,
    ).toBe(404);

    const removed = await installService(true);
    await issueToken(removed.pluginId, token);
    await env.DB.prepare(
      "UPDATE trusted_plugin SET removed_at = ? WHERE id = ?",
    )
      .bind(now, removed.pluginId)
      .run();
    expect(
      (
        await request(
          bindings,
          `/api/plugin-services/${removed.pluginId}/http/mcp`,
          post(token),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          bindings,
          "/api/plugin-services/plg_nobody/http/mcp",
          post(token),
        )
      ).status,
    ).toBe(404);
    expect(operations).toEqual([]);
  });

  it("refuses a body over 1 MiB and a flood without reaching the Orb", async () => {
    const { pluginId } = await installService(true);
    const token = "lmcp_big_0123456789abcdef0123456789abcdef0";
    await issueToken(pluginId, token);
    const { bindings, operations } = fakeDxd();
    const path = `/api/plugin-services/${pluginId}/http/mcp`;

    const large = await request(bindings, path, {
      ...post(token),
      body: "x".repeat(1_048_577),
    });
    expect(large.status).toBe(413);
    expect(operations).toEqual([]);

    // A flood of requests with no token ends in 429 without a single wake,
    // while a caller with a valid token is never limited.
    const flood = await Promise.all(
      Array.from({ length: 1_000 }, () =>
        request(bindings, path, post()).then((response) => response.status),
      ),
    );
    const limited = flood.filter((status) => status === 429).length;
    expect(flood.every((status) => status === 401 || status === 429)).toBe(
      true,
    );
    expect(limited).toBeGreaterThan(0);
    expect(operations).toEqual([]);
    for (let index = 0; index < 20; index += 1)
      expect((await request(bindings, path, post(token))).status).toBe(200);
  });

  it("serves many callers at once with no per-caller limit", async () => {
    const { pluginId } = await installService(true);
    const token = "lmcp_many_0123456789abcdef0123456789abcdef";
    await issueToken(pluginId, token);
    const { bindings } = fakeDxd();
    const path = `/api/plugin-services/${pluginId}/http/mcp`;
    const statuses = await Promise.all(
      Array.from({ length: 200 }, () =>
        request(bindings, path, post(token)).then(
          (response) => response.status,
        ),
      ),
    );
    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  it("asks for a new review when an update adds service.http, and loads it from an install", async () => {
    const { pluginId } = await installService(true);
    const install = await loadServiceInstall(env.DB, pluginId);
    expect(install?.code.service?.http).toBe(true);
    const code = install?.code;
    if (code === undefined) throw new Error("install not found");
    const withoutHttp = {
      ...code,
      service: { ...code.service, http: undefined },
    } as typeof code;
    const diff = pluginPermissionDiff(
      { code: withoutHttp, mcpServers: [] },
      { code, mcpServers: [] },
    );
    expect(diff.widens).toBe(true);
    expect(diff.changes).toContainEqual({
      permission: "service",
      added: [
        "has a URL reachable from the internet; requests need a token this plugin issues",
      ],
      removed: [],
    });
  });
});
