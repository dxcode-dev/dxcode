import {
  McpServerRepository,
  ProjectId,
  UserId,
  WorkspaceId,
} from "@dx/domain";
import { env } from "cloudflare:test";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAuthorizedMcpFetch,
  McpInvocationForbidden,
} from "../../src/settings/mcp-servers/execution.js";
import { McpServerRepositoryD1 } from "../../src/settings/mcp-servers/repository-d1.js";
import { mcpToolContractHash } from "../../src/settings/mcp-servers/transport.js";

const owner = Schema.decodeUnknownSync(UserId)("mcp-policy-owner");
const workspaceId = Schema.decodeUnknownSync(WorkspaceId)(
  "mcp-policy-workspace",
);
const projectId = Schema.decodeUnknownSync(ProjectId)(
  "prj_00000000-0000-4000-8000-000000000036",
);
const otherProjectId = Schema.decodeUnknownSync(ProjectId)(
  "prj_00000000-0000-4000-8000-000000000037",
);
const threadId = "thr_00000000-0000-4000-8000-000000000036";
const timestamp = "2026-08-23T00:00:00.000Z";
const hash = "a".repeat(64);

const insertServer = (
  id: string,
  scope: "personal" | "workspace",
  targetId: string,
  roles: ReadonlyArray<string> = ["owner", "admin", "member"],
  projectIds: ReadonlyArray<string> = [],
) =>
  env.DB.prepare(
    `INSERT INTO mcp_server (
       id, scope, target_id, name, endpoint, transport, timeout_ms, enabled,
       project_ids_json, roles_json, health_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'streamable-http', 10000, 1, ?, ?, 'healthy', ?, ?)`,
  ).bind(
    id,
    scope,
    targetId,
    `${scope} tools`,
    "https://93.184.216.34/mcp",
    JSON.stringify(projectIds),
    JSON.stringify(roles),
    timestamp,
    timestamp,
  );

const insertApprovedTool = (serverId: string) =>
  env.DB.prepare(
    `INSERT INTO mcp_tool (
       server_id, name, description, input_schema_json, schema_hash,
       approved_schema_hash, discovered_at, reviewed_at, reviewed_by
     ) VALUES (?, 'read_status', 'Read status', '{}', ?, ?, ?, ?, ?)`,
  ).bind(serverId, hash, hash, timestamp, timestamp, owner);

const list = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* McpServerRepository;
      return yield* repository.listForExecution(owner, projectId);
    }).pipe(Effect.provide(McpServerRepositoryD1(env.DB))),
  );

const serverId = "mcp_00000000-0000-4000-8000-000000000036";
const endpoint = "https://93.184.216.34/mcp";

const authorizeStoredContract = async () => {
  const contractHash = await mcpToolContractHash({
    name: "read_status",
    description: "Read status",
    inputSchema: {},
  });
  await env.DB.prepare(
    "UPDATE mcp_tool SET schema_hash = ?, approved_schema_hash = ? WHERE server_id = ?",
  )
    .bind(contractHash, contractHash, serverId)
    .run();
};

const authorizedRequest = (body: unknown) =>
  createAuthorizedMcpFetch(
    threadId,
    serverId,
    endpoint,
    10_000,
  )(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const listingResponse = (description: string) => ({
  jsonrpc: "2.0",
  id: 1,
  result: {
    tools: [{ name: "read_status", description, inputSchema: {} }],
  },
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(owner, "MCP Owner", "mcp-policy@example.com", 1, 1),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(workspaceId, "MCP Workspace", "mcp-policy-workspace", 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("mcp-policy-membership", workspaceId, owner, "member", 1),
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(projectId, owner, "MCP policy project", timestamp, timestamp),
    env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(threadId, projectId, owner, timestamp, timestamp),
    insertServer("mcp_00000000-0000-4000-8000-000000000036", "personal", owner),
    insertServer(
      "mcp_00000000-0000-4000-8000-000000000037",
      "workspace",
      workspaceId,
    ),
    insertApprovedTool("mcp_00000000-0000-4000-8000-000000000036"),
    insertApprovedTool("mcp_00000000-0000-4000-8000-000000000037"),
  ]);
});

afterEach(() => vi.unstubAllGlobals());

describe("MCP current execution policy in D1", () => {
  it("combines personal and one-workspace grants and applies workspace personal policy", async () => {
    expect((await list()).map(({ server }) => server.target.scope)).toEqual([
      "personal",
      "workspace",
    ]);

    await env.DB.prepare(
      "INSERT INTO mcp_workspace_policy (workspace_id, allow_personal_servers) VALUES (?, 0)",
    )
      .bind(workspaceId)
      .run();
    const blocked = await list();
    expect(blocked.map(({ server }) => server.target.scope)).toEqual([
      "workspace",
    ]);
  });

  it("enforces current project, role, enabled, removal, and immutable schema approval", async () => {
    const workspaceServer = "mcp_00000000-0000-4000-8000-000000000037";
    await env.DB.prepare(
      "UPDATE mcp_server SET roles_json = '[\"owner\"]' WHERE id = ?",
    )
      .bind(workspaceServer)
      .run();
    expect((await list()).map(({ server }) => server.target.scope)).toEqual([
      "personal",
    ]);

    await env.DB.prepare(
      "UPDATE mcp_server SET roles_json = '[\"member\"]', project_ids_json = ? WHERE id = ?",
    )
      .bind(JSON.stringify([otherProjectId]), workspaceServer)
      .run();
    expect((await list()).map(({ server }) => server.target.scope)).toEqual([
      "personal",
    ]);

    await env.DB.prepare(
      "UPDATE mcp_server SET project_ids_json = ? WHERE id = ?",
    )
      .bind(JSON.stringify([projectId]), workspaceServer)
      .run();
    expect((await list()).map(({ server }) => server.target.scope)).toEqual([
      "personal",
      "workspace",
    ]);

    await env.DB.prepare(
      "UPDATE mcp_tool SET schema_hash = ? WHERE server_id = ?",
    )
      .bind("b".repeat(64), workspaceServer)
      .run();
    const changed = await list();
    expect(
      changed.find(({ server }) => server.id === workspaceServer)?.tools,
    ).toEqual([]);

    await env.DB.prepare("UPDATE mcp_server SET enabled = 0 WHERE id = ?")
      .bind(workspaceServer)
      .run();
    expect((await list()).map(({ server }) => server.target.scope)).toEqual([
      "personal",
    ]);

    await env.DB.prepare("DELETE FROM mcp_server WHERE id = ?")
      .bind("mcp_00000000-0000-4000-8000-000000000036")
      .run();
    expect(await list()).toEqual([]);
  });

  it("rechecks disable and exact approved tool names before every Flue MCP request", async () => {
    const authorizedFetch = createAuthorizedMcpFetch(
      threadId,
      serverId,
      "https://93.184.216.34/mcp",
      10_000,
    );
    const call = (body: unknown) =>
      authorizedFetch("https://93.184.216.34/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    await expect(
      call([
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "read_status", arguments: {} },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "unreviewed_tool", arguments: {} },
        },
      ]),
    ).rejects.toBeInstanceOf(McpInvocationForbidden);

    await env.DB.prepare("UPDATE mcp_server SET enabled = 0 WHERE id = ?")
      .bind(serverId)
      .run();
    await expect(
      call({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "read_status", arguments: {} },
      }),
    ).rejects.toBeInstanceOf(McpInvocationForbidden);
  });

  it("validates JSON tool listings after dispatch without rereading the outbound request", async () => {
    await authorizeStoredContract();
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(listingResponse("Read status")))
        .mockResolvedValueOnce(
          Response.json(listingResponse("Changed status")),
        ),
    );
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    };

    await expect(authorizedRequest(request)).resolves.toBeInstanceOf(Response);
    await expect(authorizedRequest(request)).rejects.toMatchObject({
      code: "TOOL_REVIEW_REQUIRED",
    });
  });

  it("validates SSE tool listings before delivering each frame", async () => {
    await authorizeStoredContract();
    const frame = (description: string) =>
      `data: ${JSON.stringify(listingResponse(description))}\n\n`;
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(frame("Read status"), {
            headers: { "content-type": "text/event-stream" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(frame("Changed status"), {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
    );
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    };

    const matching = await authorizedRequest(request);
    await expect(matching.text()).resolves.toBe(frame("Read status"));
    const mismatched = await authorizedRequest(request);
    await expect(mismatched.text()).rejects.toMatchObject({
      code: "TOOL_REVIEW_REQUIRED",
    });
  });

  it("executes an approved tool call without applying listing validation to its result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          jsonrpc: "2.0",
          id: 2,
          result: listingResponse("Changed status").result,
        }),
      ),
    );

    const response = await authorizedRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "read_status", arguments: {} },
    });
    await expect(response.json()).resolves.toMatchObject({ id: 2 });
  });
});
