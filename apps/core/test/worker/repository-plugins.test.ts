import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import { codeModules } from "../../src/plugins/code/catalog.js";
import { codeMcpCall } from "../../src/plugins/code/mcp.js";
import { discoverRepositoryMcpServers } from "../../src/plugins/repository/repository-mcp.js";
import {
  type RepositoryPluginsRead,
  readRepositoryPluginsOutput,
  resolveRepositoryPlugins,
} from "../../src/plugins/repository/repository-plugins.js";
import { describeCodePlugins } from "../../src/plugins/worker-host/resolve.js";
import { callPluginTool } from "../../src/plugins/worker-host/worker.js";
import {
  buildZip,
  type FixtureEntry,
} from "../../src/settings/plugins/bundles/zip-fixture.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

/**
 * Plugins a repository carries, resolved for a Thread and run in real
 * Dynamic Workers (workerd's worker loader). What can go wrong, and where
 * each case is checked:
 *
 * - a repository plugin runs beside an installed copy of the same plugin,
 *   or past a workspace that turned repository plugins off ("which load");
 * - a repository plugin reads the owner's or workspace's secrets, or
 *   shares storage with another Project or with an install ("code");
 * - its code is swapped between resolution and the worker loading it
 *   ("code");
 * - its skills lose their folder, or a skill name the Thread already has
 *   fails the Thread ("which load");
 * - its MCP server is called from another Thread, after a later submission
 *   dropped it, or after its tool's contract changed; or a server that
 *   wants a token gets one ("MCP servers").
 */

const bindings = {
  DB: env.DB,
  LOADER: (env as unknown as { LOADER: WorkerLoader }).LOADER,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
} as Bindings;

const now = "2026-11-10T12:00:00.000Z";

const counter = `
export default (dx) => {
  dx.registerTool({
    name: "count_runs",
    description: "Counts its runs in storage.",
    async execute(_input, ctx) {
      const count = ((await ctx.storage.get("runs")) ?? 0) + 1;
      await ctx.storage.set("runs", count);
      return { count, scope: ctx.install.scope, hasSecrets: ctx.secrets !== undefined };
    },
  });
};
`;

const repositoryFiles = (prefix: string): ReadonlyArray<FixtureEntry> => [
  {
    name: `${prefix}.agents/plugins/counter/plugin.json`,
    content: JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
      name: "com.acme.counter",
      displayName: "Counter",
      version: "1.0.0",
      description: "Counts.",
      extensions: {
        "dev.dxcode": {
          apiVersion: 1,
          entry: "dev.dxcode/index.js",
          permissions: { secrets: ["DEPLOY_TOKEN"] },
        },
      },
    }),
  },
  {
    name: `${prefix}.agents/plugins/counter/dev.dxcode/index.js`,
    content: counter,
  },
  {
    name: `${prefix}.agents/plugins/counter/skills/count-notes/SKILL.md`,
    content:
      "---\nname: count-notes\ndescription: Notes on counting.\n---\n\nCount.\n",
  },
  {
    name: `${prefix}.agents/plugins/counter/skills/taken/SKILL.md`,
    content: "---\nname: taken\ndescription: Taken.\n---\n\nTaken.\n",
  },
  {
    name: `${prefix}.dx/plugins/release/plugin.json`,
    content: JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
      name: "com.acme.release",
      displayName: "Release",
      version: "1.0.0",
      description: "Also installed personally.",
    }),
  },
  {
    name: `${prefix}.dx/plugins/release/skills/release-notes/SKILL.md`,
    content:
      "---\nname: release-notes\ndescription: Release notes.\n---\n\nWrite them.\n",
  },
];

/** The guest command's output for a checkout holding these files. */
const read = async (): Promise<RepositoryPluginsRead> => {
  const zip = await buildZip(repositoryFiles("repo/"));
  const output = `/home/user/workspace/repo\n${"a".repeat(40)}\n${btoa(
    String.fromCharCode(...zip),
  )}\n`;
  const result = await readRepositoryPluginsOutput(output);
  if (result === undefined) throw new Error("Expected the plugins to read.");
  return result;
};

let seeded = 0;
const seed = async () => {
  seeded += 1;
  const userId = `usr_repo_plugins_${seeded}`;
  const workspaceId = `org_repo_plugins_${seeded}`;
  const projectId = `prj_repo_plugins_${seeded}`;
  const threadId = `thr_00000000-0000-4000-9100-${String(seeded).padStart(12, "0")}`;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
    ).bind(userId, userId, `${userId}@example.com`),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Acme', ?, 1)",
    ).bind(workspaceId, `repo-plugins-${seeded}`),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', 1)",
    ).bind(`${workspaceId}-m`, workspaceId, userId),
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, 'Repo', ?, ?)",
    ).bind(projectId, userId, workspaceId, now, now),
    env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(threadId, projectId, userId, now, now),
  ]);
  return { userId, workspaceId, projectId, threadId };
};

/** A personal install row of the plugin name, enough for resolution. */
const installPersonally = (userId: string, name: string) =>
  env.DB.prepare(
    `INSERT INTO trusted_plugin (
       id, scope, target_id, name, enabled, active_version, created_at,
       updated_at, kind
     ) VALUES (?, 'personal', ?, ?, 0, '1.0.0+abc', ?, ?, 'bundle')`,
  )
    .bind(`plg_repo_${userId}_${name}`.slice(0, 120), userId, name, now, now)
    .run();

describe("repository plugins", () => {
  it("load beside installs only where no install has the plugin, and a workspace can turn them off", async () => {
    const { userId, workspaceId, threadId } = await seed();
    // Disabled, yet still installed: its name is taken.
    await installPersonally(userId, "com.acme.release");
    const resolved = await resolveRepositoryPlugins(
      env.DB,
      threadId,
      await read(),
      new Set(["taken"]),
    );
    expect(resolved?.ownerUserId).toBe(userId);
    expect(
      resolved?.plugins.map(({ name, folder, skills }) => [
        name,
        folder,
        skills.map(({ name: skill, directory }) => [skill, directory]),
      ]),
    ).toEqual([
      [
        "com.acme.counter",
        ".agents/plugins/counter",
        [
          [
            "count-notes",
            "/home/user/workspace/repo/.agents/plugins/counter/skills/count-notes",
          ],
        ],
      ],
    ]);
    expect(resolved?.skipped.map(({ reason }) => reason).sort()).toEqual([
      "Release is installed in your plugins or your workspace's, so that copy is used.",
      "The Thread already has a skill named taken.",
    ]);
    expect(resolved?.skipped.map(({ folder }) => folder).sort()).toEqual([
      ".agents/plugins/counter/skills/taken",
      ".dx/plugins/release",
    ]);

    await env.DB.prepare(
      "UPDATE workspace_policy SET allow_repository_plugins = 0 WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .run();
    const off = await resolveRepositoryPlugins(env.DB, threadId, await read());
    expect(off?.plugins).toEqual([]);
    expect(off?.skipped.map(({ reason }) => reason)).toEqual([
      "The workspace turned repository plugins off.",
      "The workspace turned repository plugins off.",
    ]);
  });

  it("runs their code per Project, with storage of its own and no secrets", async () => {
    const first = await seed();
    const second = await seed();
    const installsFor = async (threadId: string) => {
      const resolved = await resolveRepositoryPlugins(
        env.DB,
        threadId,
        await read(),
      );
      return resolved?.plugins.flatMap(({ code }) =>
        code === undefined ? [] : [code],
      );
    };
    const [firstInstall] = (await installsFor(first.threadId)) ?? [];
    const [secondInstall] = (await installsFor(second.threadId)) ?? [];
    if (firstInstall === undefined || secondInstall === undefined)
      throw new Error("Expected the code to resolve.");
    expect(firstInstall).toMatchObject({
      scope: "repository",
      targetId: first.projectId,
      pluginId: `repository:${first.projectId}:com.acme.counter`,
    });
    // Declared, but a repository plugin gets no secrets.
    expect(firstInstall.code.permissions.secrets).toEqual([]);

    const [described] = await describeCodePlugins(bindings, env.DB, [
      firstInstall,
    ]);
    expect(described?.loadError).toBeUndefined();
    expect(described?.tools.map(({ name }) => name)).toEqual(["count_runs"]);

    const run = (
      install: typeof firstInstall,
      threadId: string,
      owner: string,
    ) =>
      callPluginTool(
        {
          db: env.DB,
          bindings,
          install,
          threadId,
          ownerUserId: owner,
        },
        "count_runs",
        {},
      );
    expect(await run(firstInstall, first.threadId, first.userId)).toEqual({
      count: 1,
      scope: "repository",
      hasSecrets: false,
    });
    expect(await run(firstInstall, first.threadId, first.userId)).toMatchObject(
      { count: 2 },
    );
    // Another Project's copy of the same code keeps its own count.
    expect(
      await run(secondInstall, second.threadId, second.userId),
    ).toMatchObject({ count: 1 });
    const stored = await env.DB.prepare(
      "SELECT plugin_id, value_json FROM repository_plugin_storage ORDER BY plugin_id",
    ).all<{ plugin_id: string; value_json: string }>();
    expect(stored.results).toEqual([
      {
        plugin_id: `repository:${first.projectId}:com.acme.counter`,
        value_json: "2",
      },
      {
        plugin_id: `repository:${second.projectId}:com.acme.counter`,
        value_json: "1",
      },
    ]);
    const installStorage = await env.DB.prepare(
      "SELECT count(*) AS n FROM plugin_install_storage",
    ).first<{ n: number }>();
    expect(installStorage?.n).toBe(0);
  });

  it("refuses code whose stored modules no longer match the resolved manifest", async () => {
    const { threadId } = await seed();
    const resolved = await resolveRepositoryPlugins(
      env.DB,
      threadId,
      await read(),
    );
    const install = resolved?.plugins[0]?.code;
    if (install === undefined) throw new Error("Expected code.");
    const tampered = {
      ...install,
      integrity: "b".repeat(64),
    };
    const [described] = await describeCodePlugins(bindings, env.DB, [tampered]);
    expect(described?.loadError).toMatch(/does not match/);
  });
});

afterEach(() => vi.unstubAllGlobals());

/** A Streamable HTTP MCP server that records the requests it gets. */
const mcpFixture = (description = "Read status") => {
  const seen: Array<{ rpc?: string; team: string | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const message =
        request.method === "POST"
          ? ((await request.clone().json()) as {
              id?: number;
              method: string;
              params?: { protocolVersion?: string };
            })
          : undefined;
      seen.push({ rpc: message?.method, team: request.headers.get("x-team") });
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
            ? {
                tools: [
                  {
                    name: "read_status",
                    description,
                    inputSchema: { type: "object" },
                  },
                ],
              }
            : { content: [{ type: "text", text: "status ok" }] };
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    }),
  );
  return seen;
};

describe("repository plugin MCP servers", () => {
  const plugin = {
    name: "com.acme.status",
    servers: [
      {
        name: "status",
        endpoint: "https://93.184.216.36/mcp",
        authType: "none" as const,
        headers: [{ name: "X-Team", value: "core" }],
      },
      {
        name: "private",
        endpoint: "https://93.184.216.37/mcp",
        authType: "bearer" as const,
        headers: [],
      },
    ],
  } as never;

  const callFrom = (
    threadId: string,
    connection: Parameters<typeof codeModules>[0][number],
  ) => {
    const module = codeModules([connection])[0];
    if (module === undefined) throw new Error("Missing module");
    return codeMcpCall(threadId, bindings)(
      module,
      "read_status",
      {},
      false,
      new AbortController().signal,
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error: String(error) }),
    );
  };

  it("lists a server's tools, calls them from this Thread only, and stops when a submission drops it", async () => {
    const { threadId, projectId } = await seed();
    const other = await seed();
    const seen = mcpFixture();
    const found = await discoverRepositoryMcpServers(
      env.DB,
      threadId,
      projectId,
      [plugin],
    );
    expect(found.skipped.map(({ reason }) => reason)).toEqual([
      "MCP server private wants a token, and a repository plugin gets no secrets; install the plugin to use it.",
    ]);
    const [connection] = found.connections;
    if (connection === undefined) throw new Error("Expected a connection.");
    expect(connection).toMatchObject({
      displayName: "status",
      tools: ["read_status"],
      authenticated: false,
    });
    // Its declared header goes out with every request.
    expect(seen.every(({ team }) => team === "core")).toBe(true);

    expect(await callFrom(threadId, connection)).toEqual({
      value: "status ok",
    });
    expect(seen.some(({ rpc }) => rpc === "tools/call")).toBe(true);
    // Another Thread never recorded this server.
    const elsewhere = await callFrom(other.threadId, connection);
    expect(elsewhere).toHaveProperty("error");

    // The next submission no longer has the plugin: the server is gone.
    await discoverRepositoryMcpServers(env.DB, threadId, projectId, []);
    const dropped = await callFrom(threadId, connection);
    expect(dropped).toHaveProperty("error");
  });

  it("blocks a tool whose contract changed since the submission listed it", async () => {
    const { threadId, projectId } = await seed();
    mcpFixture();
    const found = await discoverRepositoryMcpServers(
      env.DB,
      threadId,
      projectId,
      [plugin],
    );
    const [connection] = found.connections;
    if (connection === undefined) throw new Error("Expected a connection.");
    vi.unstubAllGlobals();
    mcpFixture("Now deletes everything");
    const changed = await callFrom(threadId, connection);
    expect(JSON.stringify(changed)).toMatch(/changed|TOOL_REVIEW_REQUIRED/);
  });
});
