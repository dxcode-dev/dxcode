import { env } from "cloudflare:test";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import { codeModules } from "../../src/plugins/code/catalog.js";
import { codeMcpCall } from "../../src/plugins/code/mcp.js";
import { loadConfigEncryptionKeyring } from "../../src/settings/config-encryption.js";
import { putMcpServerCredential } from "../../src/settings/mcp-servers/credential.js";
import { resolveMcpAgentConnections } from "../../src/settings/mcp-servers/execution.js";
import {
  mcpHeaderSecretName,
  putMcpServerSecret,
} from "../../src/settings/mcp-servers/secrets.js";
import { mcpToolContractHash } from "../../src/settings/mcp-servers/transport.js";
import { countD1Calls } from "./d1-call-counter.js";

/**
 * A Code MCP call resolves its server's connection (grants, allowed tools,
 * credential, configured headers) once, in one D1 round trip, and its
 * initialize, notification, listing, and tool call share it (#1496). The next
 * call resolves it again, so every way of taking the server away stops the
 * next call before anything reaches the server, and a connection never
 * carries one origin's secret headers to another.
 */

const owner = "code-mcp-owner";
const stranger = "code-mcp-stranger";
const workspaceId = "code-mcp-workspace";
const projectId = "prj_00000000-0000-4000-8000-000000001496";
const threadId = "thr_00000000-0000-4000-8000-000000001496";
const strangerProjectId = "prj_00000000-0000-4000-8000-000000001497";
const strangerThreadId = "thr_00000000-0000-4000-8000-000000001497";
const serverId = "mcp_00000000-0000-4000-8000-000000001496";
const originA = "https://93.184.216.34/mcp";
const originB = "https://93.184.216.35/mcp";
const timestamp = "2026-11-02T00:00:00.000Z";
const tool = { name: "read_status", description: "Read status" };
const inputSchema = { type: "object" };

const bindings = env as unknown as Bindings;

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly rpc: string | undefined;
  readonly authorization: string | null;
  readonly apiKey: string | null;
}

/** A Streamable HTTP MCP server that records every request it receives. */
const server = (onRequest?: (rpc: string | undefined) => Promise<void>) => {
  const seen: Seen[] = [];
  const fetchStub = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    const message =
      request.method === "POST"
        ? ((await request.clone().json()) as {
            id?: number;
            method: string;
            params?: { protocolVersion?: string };
          })
        : undefined;
    seen.push({
      url: request.url,
      method: request.method,
      rpc: message?.method,
      authorization: request.headers.get("authorization"),
      apiKey: request.headers.get("x-api-key"),
    });
    await onRequest?.(message?.method);
    if (message === undefined) return new Response(null, { status: 405 });
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : message.method === "tools/list"
          ? { tools: [{ ...tool, inputSchema }] }
          : { content: [{ type: "text", text: "status ok" }] };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  });
  vi.stubGlobal("fetch", fetchStub);
  return seen;
};

const keyring = () => Effect.runPromise(loadConfigEncryptionKeyring(bindings));
const personal = { scope: "personal", id: owner } as never;

const offered = async () =>
  (await Effect.runPromise(resolveMcpAgentConnections(env.DB, threadId))).find(
    ({ id }) => id === serverId,
  );

/** Code calling read_status with the module the Thread was offered. */
const call = async (
  connection: Awaited<ReturnType<typeof offered>>,
  options: { readonly thread?: string; readonly db?: D1Database } = {},
) => {
  if (connection === undefined) throw new Error("The server must be offered");
  const module = codeModules([connection])[0];
  if (module === undefined) throw new Error("Missing module");
  return codeMcpCall(options.thread ?? threadId, {
    ...bindings,
    DB: options.db ?? env.DB,
  })(module, tool.name, {}, false, new AbortController().signal).then(
    (value) => ({ value }),
    (error: unknown) => ({ error: String(error) }),
  );
};

beforeEach(async () => {
  const hash = await mcpToolContractHash({ ...tool, inputSchema });
  await env.DB.batch([
    ...[owner, stranger].map((id) =>
      env.DB.prepare(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
      ).bind(id, id, `${id}@example.com`, 1, 1),
    ),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(workspaceId, "Code MCP", "code-mcp-workspace", 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', 1)",
    ).bind("code-mcp-member", workspaceId, owner),
    env.DB.prepare(
      "INSERT INTO workspace_policy (workspace_id, updated_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
    ).bind(workspaceId, timestamp),
    ...[
      [projectId, threadId, owner],
      [strangerProjectId, strangerThreadId, stranger],
    ].flatMap(([project, thread, user]) => [
      env.DB.prepare(
        "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, 'Code MCP', ?, ?)",
      ).bind(project, user, timestamp, timestamp),
      env.DB.prepare(
        "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(thread, project, user, timestamp, timestamp),
    ]),
    env.DB.prepare(
      `INSERT INTO mcp_server (
         id, scope, target_id, name, endpoint, transport, timeout_ms, enabled,
         project_ids_json, roles_json, health_status, created_at, updated_at,
         headers_json
       ) VALUES (?, 'personal', ?, 'Status', ?, 'streamable-http', 10000, 1,
         '[]', '["owner","admin","member"]', 'healthy', ?, ?, ?)`,
    ).bind(
      serverId,
      owner,
      originA,
      timestamp,
      timestamp,
      JSON.stringify([{ name: "X-Api-Key", secret: true }]),
    ),
    env.DB.prepare(
      `INSERT INTO mcp_tool (
         server_id, name, description, input_schema_json, schema_hash,
         approved_schema_hash, discovered_at, reviewed_at, reviewed_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      serverId,
      tool.name,
      tool.description,
      JSON.stringify(inputSchema),
      hash,
      hash,
      timestamp,
      timestamp,
      owner,
    ),
  ]);
  await putMcpServerSecret(
    env.DB,
    await keyring(),
    { id: serverId as never, target: personal },
    mcpHeaderSecretName("X-Api-Key"),
    "origin-a-secret",
    timestamp,
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("Code MCP calls resolve their connection once", () => {
  it("serves every request of a call from one D1 round trip, and resolves again per call", async () => {
    // Without secret headers, the connection is the one batch.
    await env.DB.prepare(
      "UPDATE mcp_server SET headers_json = '[]' WHERE id = ?",
    )
      .bind(serverId)
      .run();
    const seen = server();
    const connection = await offered();
    const counter = countD1Calls(env.DB);

    expect(await call(connection, { db: counter.db })).toEqual({
      value: "status ok",
    });
    const rpcs = seen.filter(({ method }) => method === "POST");
    expect(rpcs.map(({ rpc }) => rpc)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(counter.calls.map(({ method }) => method)).toEqual(["batch"]);

    expect(await call(connection, { db: counter.db })).toEqual({
      value: "status ok",
    });
    expect(counter.calls.map(({ method }) => method)).toEqual([
      "batch",
      "batch",
    ]);
  }, 30_000);

  it("stops the next call when the review, server, sign-in, credential, or grant is revoked", async () => {
    const seen = server();
    const connection = await offered();
    expect(await call(connection)).toEqual({ value: "status ok" });
    const reached = () => seen.length;

    const revocations: ReadonlyArray<{
      readonly name: string;
      readonly revoke: () => Promise<unknown>;
      readonly restore: () => Promise<unknown>;
    }> = [
      {
        name: "tool review",
        revoke: () =>
          env.DB.prepare(
            "UPDATE mcp_tool SET approved_schema_hash = NULL WHERE server_id = ?",
          )
            .bind(serverId)
            .run(),
        restore: () =>
          env.DB.prepare(
            "UPDATE mcp_tool SET approved_schema_hash = schema_hash WHERE server_id = ?",
          )
            .bind(serverId)
            .run(),
      },
      {
        name: "disabled server",
        revoke: () =>
          env.DB.prepare("UPDATE mcp_server SET enabled = 0 WHERE id = ?")
            .bind(serverId)
            .run(),
        restore: () =>
          env.DB.prepare("UPDATE mcp_server SET enabled = 1 WHERE id = ?")
            .bind(serverId)
            .run(),
      },
      {
        name: "Project grant",
        revoke: () =>
          env.DB.prepare(
            "UPDATE mcp_server SET project_ids_json = ? WHERE id = ?",
          )
            .bind(JSON.stringify([strangerProjectId]), serverId)
            .run(),
        restore: () =>
          env.DB.prepare(
            "UPDATE mcp_server SET project_ids_json = '[]' WHERE id = ?",
          )
            .bind(serverId)
            .run(),
      },
      {
        name: "workspace policy on personal servers",
        revoke: () =>
          env.DB.prepare(
            "UPDATE workspace_policy SET allow_personal_mcp_overrides = 0 WHERE workspace_id = ?",
          )
            .bind(workspaceId)
            .run(),
        restore: () =>
          env.DB.prepare(
            "UPDATE workspace_policy SET allow_personal_mcp_overrides = 1 WHERE workspace_id = ?",
          )
            .bind(workspaceId)
            .run(),
      },
      {
        name: "secret header value",
        revoke: () =>
          env.DB.prepare("DELETE FROM mcp_server_secret WHERE server_id = ?")
            .bind(serverId)
            .run(),
        restore: async () =>
          putMcpServerSecret(
            env.DB,
            await keyring(),
            { id: serverId as never, target: personal },
            mcpHeaderSecretName("X-Api-Key"),
            "origin-a-secret",
            timestamp,
          ),
      },
    ];
    for (const { name, revoke, restore } of revocations) {
      await revoke();
      const before = reached();
      const outcome = await call(connection);
      expect({ name, outcome }).toMatchObject({
        name,
        outcome: { error: expect.stringContaining("McpInvocationForbidden") },
      });
      expect({ name, reached: reached() - before }).toEqual({
        name,
        reached: 0,
      });
      await restore();
      expect({ name, outcome: await call(connection) }).toEqual({
        name,
        outcome: { value: "status ok" },
      });
    }

    // A stored bearer token: rotating it reaches the next call, and removing
    // it stops that call.
    await env.DB.prepare(
      "UPDATE mcp_server SET auth_type = 'bearer' WHERE id = ?",
    )
      .bind(serverId)
      .run();
    await putMcpServerCredential(
      env.DB,
      await keyring(),
      { id: serverId as never, target: personal },
      "token-1",
      timestamp,
    );
    const bearer = await offered();
    expect(await call(bearer)).toEqual({ value: "status ok" });
    await putMcpServerCredential(
      env.DB,
      await keyring(),
      { id: serverId as never, target: personal },
      "token-2",
      timestamp,
    );
    let before = reached();
    expect(await call(bearer)).toEqual({ value: "status ok" });
    expect(
      new Set(
        seen
          .slice(before)
          .filter(({ method }) => method === "POST")
          .map(({ authorization }) => authorization),
      ),
    ).toEqual(new Set(["Bearer token-2"]));
    await env.DB.prepare(
      "DELETE FROM mcp_server_credential WHERE server_id = ?",
    )
      .bind(serverId)
      .run();
    before = reached();
    expect(await call(bearer)).toMatchObject({
      error: expect.stringContaining("McpInvocationForbidden"),
    });
    expect(reached() - before).toBe(0);

    // Removing the server stops it too.
    await env.DB.prepare("DELETE FROM mcp_server WHERE id = ?")
      .bind(serverId)
      .run();
    before = reached();
    expect(await call(connection)).toMatchObject({
      error: expect.stringContaining("McpInvocationForbidden"),
    });
    expect(reached() - before).toBe(0);
  }, 60_000);

  it("never serves another user's Thread", async () => {
    const seen = server();
    const connection = await offered();
    expect(await call(connection, { thread: strangerThreadId })).toMatchObject({
      error: expect.stringContaining("McpInvocationForbidden"),
    });
    expect(seen).toEqual([]);
  });

  it("keeps a connection on its origin, and never carries its secret headers to another", async () => {
    const connectionA = await offered();
    // The server moves to another origin in the middle of a call, as a
    // plugin update does: its secret headers are cleared before the move.
    // The approval stays, the worst case for a connection already in use.
    const move = async () => {
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM mcp_server_secret WHERE server_id = ?",
        ).bind(serverId),
        env.DB.prepare(
          "UPDATE mcp_server SET endpoint = ?, headers_json = '[]' WHERE id = ?",
        ).bind(originB, serverId),
      ]);
    };
    let moved = false;
    const seen = server(async (rpc) => {
      if (rpc === "initialize" && !moved) {
        moved = true;
        await move();
      }
    });

    // The call already in progress finishes on origin A with A's header.
    expect(await call(connectionA)).toEqual({ value: "status ok" });
    expect(moved).toBe(true);
    expect(new Set(seen.map(({ url }) => url))).toEqual(new Set([originA]));
    expect(
      new Set(
        seen
          .filter(({ method }) => method === "POST")
          .map(({ apiKey }) => apiKey),
      ),
    ).toEqual(new Set(["origin-a-secret"]));

    // The next call with the old module stops before reaching either origin.
    let before = seen.length;
    expect(await call(connectionA)).toMatchObject({
      error: expect.stringContaining("McpInvocationForbidden"),
    });
    expect(seen.length - before).toBe(0);

    // A Thread offered the moved server reaches origin B without the secret.
    const connectionB = await offered();
    expect(connectionB?.endpoint).toBe(originB);
    before = seen.length;
    expect(await call(connectionB)).toEqual({ value: "status ok" });
    const atB = seen.slice(before);
    expect(atB.length).toBeGreaterThan(0);
    expect(atB.every(({ url }) => url === originB)).toBe(true);
    expect(atB.every(({ apiKey }) => apiKey === null)).toBe(true);
  }, 30_000);
});
