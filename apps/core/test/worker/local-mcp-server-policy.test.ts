import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { listLocalMcpServers } from "../../src/settings/mcp-servers/local-servers.js";

/**
 * A personal plugin's local (stdio) MCP server runs in its owner's Threads
 * only while the owner's workspace allows personal MCP servers, under both of
 * the workspace's switches, as a personal remote server does (#2358).
 */

const owner = "local-mcp-owner";
const workspaceId = "local-mcp-workspace";
const projectId = "prj_00000000-0000-4000-8000-000000002358";
const threadId = "thr_00000000-0000-4000-8000-000000002358";
const pluginId = "plg_00000000-0000-4000-8000-000000002358";
const at = "2026-11-23T00:00:00.000Z";

const manifest = {
  format: "agent-plugins",
  name: "com.example.local",
  displayName: "Local",
  description: "A plugin with a local MCP server.",
  skills: [],
  mcpServers: [
    {
      transport: "stdio",
      name: "local-tools",
      command: "node",
      args: [],
      env: [],
    },
  ],
  skipped: [],
  package: { sha256: "a".repeat(64), size: 1, files: 1 },
};

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
    ).bind(owner, owner, `${owner}@example.com`),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Local MCP', ?, 1)",
    ).bind(workspaceId, workspaceId),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('local-mcp-member', ?, ?, 'member', 1)",
    ).bind(workspaceId, owner),
    env.DB.prepare(
      "INSERT INTO workspace_policy (workspace_id, updated_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
    ).bind(workspaceId, at),
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, 'Local MCP', ?, ?)",
    ).bind(projectId, owner, at, at),
    env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(threadId, projectId, owner, at, at),
    env.DB.prepare(
      `INSERT INTO trusted_plugin (id, scope, target_id, name, enabled,
         active_version, health_status, created_at, updated_at, kind)
       VALUES (?, 'personal', ?, 'com.example.local', 1, '1.0.0', 'unchecked', ?, ?, 'bundle')`,
    ).bind(pluginId, owner, at, at),
    env.DB.prepare(
      `INSERT INTO trusted_plugin_version (plugin_id, version, manifest_json,
         grants_json, source_json, integrity, trusted, trusted_at,
         trusted_by_user_id)
       VALUES (?, '1.0.0', ?, '{}', '{"type":"zip","label":"local.zip"}', ?, 1, ?, ?)`,
    ).bind(pluginId, JSON.stringify(manifest), "b".repeat(64), at, owner),
  ]);
});

const names = async () =>
  (await listLocalMcpServers(env.DB, threadId)).map(
    ({ server }) => server.name,
  );

describe("local MCP servers under the workspace policy", () => {
  it("runs a personal plugin's server only while both switches allow personal MCP servers", async () => {
    expect(await names()).toEqual(["local-tools"]);

    // The workspace policy's "personal MCP overrides" switch.
    await env.DB.prepare(
      "UPDATE workspace_policy SET allow_personal_mcp_overrides = 0 WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .run();
    expect(await names()).toEqual([]);
    await env.DB.prepare(
      "UPDATE workspace_policy SET allow_personal_mcp_overrides = 1 WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .run();
    expect(await names()).toEqual(["local-tools"]);

    // The MCP page's "personal servers" switch.
    await env.DB.prepare(
      "INSERT INTO mcp_workspace_policy (workspace_id, allow_personal_servers) VALUES (?, 0)",
    )
      .bind(workspaceId)
      .run();
    expect(await names()).toEqual([]);
  });
});
