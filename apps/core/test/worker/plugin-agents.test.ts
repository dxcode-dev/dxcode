import { env } from "cloudflare:test";
import {
  PluginBundleRepository,
  type PluginId,
  type PluginTarget,
  StoredPluginBundle,
  type UserId,
} from "@dx/domain";
import type { ToolDefinition } from "@flue/runtime";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import { resolveAgentCodePlugins } from "../../src/plugins/agent-context.js";
import { pluginAgentDefinitionOf } from "../../src/plugins/agents/definition.js";
import { startAgentThread } from "../../src/plugins/agents/threads.js";
import {
  type CodePluginRuntime,
  createPluginTools,
} from "../../src/plugins/worker-host/agent.js";
import {
  listThreadCodePluginInstalls,
  resolveThreadCodePlugins,
} from "../../src/plugins/worker-host/resolve.js";
import { pluginPermissionDiff } from "../../src/settings/plugins/bundles/permission-diff.js";
import { readPluginBundle } from "../../src/settings/plugins/bundles/read-bundle.js";
import { PluginBundleRepositoryD1 } from "../../src/settings/plugins/bundles/repository-d1.js";
import { readZipArchive } from "../../src/settings/plugins/bundles/zip.js";
import {
  buildZip,
  type FixtureEntry,
} from "../../src/settings/plugins/bundles/zip-fixture.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";

/**
 * Plugin agents and model choice, through real Dynamic Workers. What can go
 * wrong, and where each case checks it:
 *
 * - A plugin uses a model it was not granted: `ai.generate` with an
 *   unlisted model, or an agent naming one ("grants").
 * - A plugin reaches the owner's Claude plan for its own model call
 *   ("grants").
 * - A plugin without `permissions.agents` starts agent Threads ("grants").
 * - A refused action leaves no audit trail ("grants": each refusal is a
 *   `plugin_audit` row).
 * - An agent mode runs that the manifest did not declare, so the install
 *   review never showed it ("modes").
 * - Agent Threads start agent Threads without end, through one plugin,
 *   two, or `create_thread` ("nesting").
 * - A Thread bound to an agent runs as a plain dx agent once its plugin is
 *   gone, without the agent's instructions or tool limits ("fail closed").
 * - An update adds models or agents without a new review ("updates").
 * - A malformed manifest grants a half-read permission ("reading").
 * - A long request makes the agent Thread's title too long, so dx refuses
 *   to start the Thread at all ("title").
 */

const bindings = {
  DB: env.DB,
  LOADER: (env as unknown as { LOADER: WorkerLoader }).LOADER,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
} as Bindings;

const manifest = (name: string, dx: unknown) =>
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
    name,
    displayName: `${name} plugin`,
    version: "1.0.0",
    description: "Test plugin.",
    extensions: { "dev.dxcode": dx },
  });

const AGENTS = `
export default function (dx) {
  const reviewer = dx.createAgent({
    name: "reviewer",
    model: "cloudflare/@cf/moonshotai/kimi-k2.6",
    reasoningEffort: "low",
    instructions: "Review only.",
    tools: { exclude: ["edit_file"] },
  });
  const rogue = dx.createAgent({ name: "rogue", model: "openai/gpt-9", instructions: "x" });
  dx.registerAgentMode({ key: "reviewer", agent: reviewer.definition });
  dx.registerAgentMode({ key: "rogue", agent: rogue.definition });
  dx.registerAgentMode({ key: "sneaky", agent: reviewer.definition });
  const attempt = (work) => work.then((value) => ({ ok: value }), (error) => ({ error: String(error.message) }));
  dx.registerTool({
    name: "try_models",
    description: "Asks for models it was and was not granted.",
    async execute(_input, ctx) {
      return {
        ungranted: await attempt(ctx.ai.generate({ prompt: "hi", model: "openai/gpt-9" })),
        plan: await attempt(ctx.ai.generate({ prompt: "hi", model: "claude-code/claude-opus-5-5" })),
      };
    },
  });
  dx.registerTool({
    name: "run_rogue",
    description: "Runs an agent on an ungranted model.",
    execute: () => attempt(rogue.run("review this")),
  });
  dx.registerTool({
    name: "run_reviewer",
    description: "Runs the reviewer.",
    execute: () => attempt(reviewer.run("review this")),
  });
}
`;

const agentsFiles = (permissions: object = {}): FixtureEntry[] => [
  {
    name: "plugin.json",
    content: manifest("com.acme.agents", {
      apiVersion: 1,
      entry: "dev.dxcode/index.js",
      permissions: {
        ai: true,
        models: [
          "cloudflare/@cf/moonshotai/kimi-k2.6",
          "low",
          "claude-code/claude-opus-5-5",
        ],
        agents: true,
        ...permissions,
      },
      agentModes: [
        { key: "reviewer", label: "Reviewer", color: "#7c3aed" },
        { key: "rogue", label: "Rogue" },
      ],
    }),
  },
  { name: "dev.dxcode/index.js", content: AGENTS },
];

const read = async (entries: ReadonlyArray<FixtureEntry>) =>
  Effect.runPromise(
    readZipArchive(await buildZip(entries), {
      maxArchiveBytes: 16 * 1024 * 1024,
      maxEntries: 1_000,
    }).pipe(
      Effect.flatMap((archive) =>
        readPluginBundle(archive, { root: "", fallbackName: "fixture" }),
      ),
    ),
  );

let seq = 0;
const install = async (
  userId: UserId,
  entries: ReadonlyArray<FixtureEntry>,
) => {
  const bundle = await read(entries);
  seq += 1;
  const id =
    `plg_00000000-0000-4000-8000-a${String(seq).padStart(11, "0")}` as PluginId;
  const now = "2026-11-11T12:00:00.000Z";
  await Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* PluginBundleRepository;
      yield* repository.insert(
        Schema.decodeUnknownSync(StoredPluginBundle)({
          id,
          target: { scope: "personal", id: userId } as PluginTarget,
          name: bundle.manifest.name,
          enabled: true,
          version: bundle.version,
          manifest: bundle.manifest,
          source: { type: "zip", label: "fixture.zip" },
          integrity: bundle.integrity,
          installedAt: now,
          installedByUserId: userId,
          updatedAt: now,
        }),
        bundle.codeModules,
      );
    }).pipe(Effect.provide(PluginBundleRepositoryD1(env.DB))),
  );
  return { id, bundle };
};

let people = 0;
const person = async () => {
  people += 1;
  const userId = `usr_plugin_agents_${people}` as UserId;
  const projectId = `prj_plugin_agents_${people}`;
  const threadId = `thr_00000000-0000-4000-9000-a${String(people).padStart(11, "0")}`;
  const timestamp = "2026-11-11T12:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
    ).bind(userId, userId, `${userId}@example.com`),
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, 'Agents', ?, ?)",
    ).bind(projectId, userId, timestamp, timestamp),
    env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(threadId, projectId, userId, timestamp, timestamp),
  ]);
  return { userId, threadId };
};

const toolsFor = async (threadId: string, ownerUserId: string) => {
  const runtime = {
    threadId,
    ownerUserId,
    plugins: await resolveThreadCodePlugins(bindings, env.DB, threadId),
    host: () => ({ db: env.DB, bindings }),
  } satisfies CodePluginRuntime;
  const tools = createPluginTools(runtime, new Set(), () => []);
  return {
    runtime,
    call: async (name: string) => {
      const tool = tools.find((candidate) => candidate.name === name) as
        | ToolDefinition
        | undefined;
      if (tool === undefined) throw new Error(`Missing ${name}.`);
      return JSON.parse(
        String(await tool.run({ toolCallId: name, data: {} } as never)),
      ) as Record<string, unknown>;
    },
  };
};

const audit = async (pluginId: string) =>
  (
    await env.DB.prepare(
      "SELECT action, outcome, detail_json FROM plugin_audit WHERE plugin_id = ? ORDER BY created_at, rowid",
    )
      .bind(pluginId)
      .all<{ action: string; outcome: string; detail_json: string | null }>()
  ).results.map((row) => ({
    action: row.action,
    outcome: row.outcome,
    detail: row.detail_json === null ? {} : JSON.parse(row.detail_json),
  }));

describe("plugin agents and model choice", () => {
  it("reading: keeps models, agents, and declared modes; refuses malformed ones", async () => {
    const { manifest: read1 } = await read(agentsFiles());
    expect(read1.code?.permissions.models).toEqual([
      "cloudflare/@cf/moonshotai/kimi-k2.6",
      "low",
      "claude-code/claude-opus-5-5",
    ]);
    expect(read1.code?.permissions.agents).toBe(true);
    expect(read1.code?.agentModes?.map(({ key }) => key)).toEqual([
      "reviewer",
      "rogue",
    ]);
    // Modes need the agents grant; a model must be provider/model or a mode.
    // Either turns the whole code layer off, never a narrower half of it:
    // with nothing else in the bundle, there is nothing to install.
    await expect(read(agentsFiles({ agents: false }))).rejects.toMatchObject({
      reason: expect.stringContaining(
        "agentModes needs permissions.agents set to true",
      ),
    });
    await expect(
      read(agentsFiles({ models: ["gpt 9 with spaces"] })),
    ).rejects.toMatchObject({
      reason: expect.stringContaining(
        "permissions.models lists gpt 9 with spaces",
      ),
    });
  });

  it("updates: added models and agent modes widen the grants", async () => {
    const before = (await read(agentsFiles({ models: ["low"] }))).manifest;
    const after = (await read(agentsFiles())).manifest;
    const diff = pluginPermissionDiff(before, after);
    expect(diff.widens).toBe(true);
    expect(diff.changes).toEqual([
      {
        permission: "models",
        added: [
          "cloudflare/@cf/moonshotai/kimi-k2.6",
          "claude-code/claude-opus-5-5",
        ],
        removed: [],
      },
    ]);
    const without = (
      await read([
        {
          name: "plugin.json",
          content: manifest("com.acme.agents", {
            apiVersion: 1,
            entry: "dev.dxcode/index.js",
            permissions: { ai: true },
          }),
        },
        { name: "dev.dxcode/index.js", content: "export default () => {};" },
      ])
    ).manifest;
    expect(pluginPermissionDiff(without, after).changes).toContainEqual({
      permission: "agents",
      added: [
        "Runs its agents as Threads",
        "Reviewer mode (reviewer)",
        "Rogue mode (rogue)",
      ],
      removed: [],
    });
  });

  it("modes: lists only declared modes whose agent the grants allow", async () => {
    const { userId, threadId } = await person();
    await install(userId, agentsFiles());
    const { runtime } = await toolsFor(threadId, userId);
    const plugin = runtime.plugins[0];
    expect(plugin?.loadError).toBeUndefined();
    // `rogue` names an ungranted model; `sneaky` was never declared.
    expect(plugin?.agentModes).toEqual([
      {
        key: "reviewer",
        agent: {
          name: "reviewer",
          instructions: "Review only.",
          model: "cloudflare/@cf/moonshotai/kimi-k2.6",
          reasoningEffort: "low",
          tools: { exclude: ["edit_file"] },
        },
      },
    ]);
  });

  it("grants: refuses ungranted models, the Claude plan, and agents without the grant, and audits each", async () => {
    const { userId, threadId } = await person();
    const { id } = await install(userId, agentsFiles());
    const { call } = await toolsFor(threadId, userId);
    expect(await call("try_models")).toEqual({
      ungranted: {
        error: expect.stringContaining(
          "may not choose the model openai/gpt-9: the plugin's permissions.models does not list it",
        ),
      },
      plan: {
        error: expect.stringContaining(
          "runs only through Claude Code, not for a plugin's own model calls",
        ),
      },
    });
    expect(await call("run_rogue")).toEqual({
      error: expect.stringContaining(
        "asks for the model openai/gpt-9, which the plugin's permissions.models does not list",
      ),
    });
    expect(await audit(id)).toEqual([
      {
        action: "ai.generate",
        outcome: "rejected",
        detail: { reason: "model not granted", model: "openai/gpt-9" },
      },
      {
        action: "ai.generate",
        outcome: "rejected",
        detail: { reason: "claude plan", model: "claude-code/claude-opus-5-5" },
      },
      {
        action: "agent.run",
        outcome: "rejected",
        detail: {
          reason: expect.stringContaining("permissions.models does not list"),
        },
      },
    ]);

    // The same code without permissions.agents starts no Thread.
    const other = await person();
    const { id: ungranted } = await install(
      other.userId,
      agentsFiles({ agents: false }).map((entry) =>
        entry.name === "plugin.json"
          ? {
              ...entry,
              content: manifest("com.acme.agents", {
                apiVersion: 1,
                entry: "dev.dxcode/index.js",
                permissions: { ai: true, models: ["low"] },
              }),
            }
          : entry,
      ),
    );
    const plain = await toolsFor(other.threadId, other.userId);
    expect(plain.runtime.plugins[0]?.agentModes).toEqual([]);
    expect(await plain.call("run_reviewer")).toEqual({
      error: expect.stringContaining("was not granted running agents"),
    });
    expect(await audit(ungranted)).toContainEqual({
      action: "agent.run",
      outcome: "rejected",
      detail: { reason: "not granted agents" },
    });
    const threads = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM threads WHERE parent_thread_id IN (?, ?)",
    )
      .bind(threadId, other.threadId)
      .first<{ count: number }>();
    expect(threads?.count).toBe(0);
  });

  it("nesting: an agent Thread another Thread started starts no more agent Threads", async () => {
    const { userId, threadId } = await person();
    const { id } = await install(userId, agentsFiles());
    // This Thread is a subagent: another Thread started it.
    await env.DB.prepare(
      `INSERT INTO plugin_agent_thread (thread_id, owner_user_id, plugin_id, plugin_name,
         plugin_display_name, plugin_version, agent_name, mode_key, parent_thread_id,
         definition_json, created_at)
       VALUES (?, ?, ?, 'com.acme.agents', 'Agents', '1.0.0', 'reviewer', NULL, 'thr_parent', ?, ?)`,
    )
      .bind(
        threadId,
        userId,
        id,
        JSON.stringify({ name: "reviewer", instructions: "x", tools: {} }),
        "2026-11-11T12:00:00.000Z",
      )
      .run();
    const { call } = await toolsFor(threadId, userId);
    expect(await call("run_reviewer")).toEqual({
      error: expect.stringContaining("cannot start another agent Thread"),
    });
    expect(await audit(id)).toContainEqual({
      action: "agent.run",
      outcome: "rejected",
      detail: expect.objectContaining({
        agent: "reviewer",
        reason: "nested agent Thread",
      }),
    });
  });

  it("fail closed: an agent's Thread whose plugin is gone does not run as plain dx", async () => {
    const { userId, threadId } = await person();
    const { id } = await install(userId, agentsFiles());
    await env.DB.prepare(
      `INSERT INTO plugin_agent_thread (thread_id, owner_user_id, plugin_id, plugin_name,
         plugin_display_name, plugin_version, agent_name, mode_key, parent_thread_id,
         definition_json, created_at)
       VALUES (?, ?, ?, 'com.acme.agents', 'Agents', '1.0.0', 'reviewer', 'reviewer', NULL, ?, ?)`,
    )
      .bind(
        threadId,
        userId,
        id,
        JSON.stringify({
          name: "reviewer",
          instructions: "Review only.",
          tools: { exclude: ["edit_file"] },
          display: { label: "Reviewer" },
        }),
        "2026-11-11T12:00:00.000Z",
      )
      .run();
    const running = await resolveAgentCodePlugins(threadId);
    expect(running?.agent).toMatchObject({
      pluginId: id,
      modeKey: "reviewer",
      definition: { name: "reviewer", tools: { exclude: ["edit_file"] } },
    });
    await env.DB.prepare("UPDATE trusted_plugin SET enabled = 0 WHERE id = ?")
      .bind(id)
      .run();
    await expect(resolveAgentCodePlugins(threadId)).rejects.toThrow(
      /no longer runs for you.*\(dx_failure:account:PLUGIN_AGENT_UNAVAILABLE\)/,
    );
  });

  it("title: a request whose first line is long still starts the agent's Thread", async () => {
    const { userId, threadId } = await person();
    await install(userId, agentsFiles());
    const [installed] = await listThreadCodePluginInstalls(env.DB, threadId);
    if (installed === undefined) throw new Error("Missing the install.");
    const firstLine = `Review the change that moves plugin triggers onto the shared membership check ${"and its tests ".repeat(8)}`;
    const started = await startAgentThread({
      // Thread creation as the product routes run it, with a model served.
      bindings: {
        ...bindings,
        AI: { run: async () => ({}) } as unknown as Ai,
        DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
      },
      db: env.DB,
      install: installed,
      ownerUserId: userId,
      definition: pluginAgentDefinitionOf(installed.code, {
        name: "reviewer",
        instructions: "Review only.",
      }),
      prompt: `${firstLine}\nSecond line.`,
      // As agent.run names it: the agent's label and the first line.
      title: `Reviewer: ${firstLine.slice(0, 80)}`,
      startedBy: "plugin",
    });
    const row = await env.DB.prepare("SELECT title FROM threads WHERE id = ?")
      .bind(started.threadId)
      .first<{ title: string | null }>();
    expect(row?.title?.length).toBeLessThanOrEqual(80);
    expect(row?.title).toMatch(/^Reviewer: Review the change/);
  });
});
