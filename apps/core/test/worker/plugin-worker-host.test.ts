import { env, runDurableObjectAlarm } from "cloudflare:test";
import {
  PluginBundleRepository,
  type PluginId,
  type PluginTarget,
  StoredPluginBundle,
  type UserId,
} from "@dx/domain";
import type { ToolDefinition } from "@flue/runtime";
import { Effect, Schema } from "effect";
import { HttpResponse, http } from "msw";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import {
  type CodePluginRuntime,
  createPluginTools,
  withPluginToolEvents,
} from "../../src/plugins/worker-host/agent.js";
import { resolveThreadCodePlugins } from "../../src/plugins/worker-host/resolve.js";
import { listCodePluginTriggerCapabilities } from "../../src/plugins/worker-host/triggers.js";
import {
  dispatchPluginEvent,
  pluginWorkerId,
} from "../../src/plugins/worker-host/worker.js";
import { pluginExportFiles } from "../../src/settings/plugins/bundles/export.js";
import { readPluginBundle } from "../../src/settings/plugins/bundles/read-bundle.js";
import { PluginBundleRepositoryD1 } from "../../src/settings/plugins/bundles/repository-d1.js";
import { readZipArchive } from "../../src/settings/plugins/bundles/zip.js";
import {
  buildZip,
  type FixtureEntry,
} from "../../src/settings/plugins/bundles/zip-fixture.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { network } from "./network-boundary.js";

/**
 * Plugin code in real Cloudflare Dynamic Workers (workerd's worker loader):
 * an Agent Plugins package whose `extensions["dev.dxcode"]` names a
 * JavaScript entry is read, stored, resolved for a Thread, started in its
 * own isolate, and called through the tool gate, registered tools, and
 * events. What can go wrong, and where each case is checked:
 *
 * - a gate fails open: a rejecting, throwing, or unstarted tool.call handler
 *   must keep the tool from running ("tool.call gates").
 * - the worker reaches the network or keeps dx's host after a call
 *   ("isolation").
 * - storage leaks across installs, or settings ignore their defaults
 *   ("registered tools").
 * - both copies of a plugin run, or workers are shared across owners
 *   ("resolution").
 * - a bad dx block takes the portable layer down with it ("reading").
 */

const loaderBindings = {
  DB: env.DB,
  LOADER: (env as unknown as { LOADER: WorkerLoader }).LOADER,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
} as Bindings;
/** The deployment the cases run against; the QuickJS cases drop LOADER. */
let bindings: Bindings = loaderBindings;

const manifest = (name: string, dx: unknown, extra: object = {}) =>
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
    name,
    displayName: `${name} plugin`,
    version: "1.0.0",
    description: "Test plugin.",
    extensions: { "dev.dxcode": dx },
    ...extra,
  });

const guard = `
import { definePlugin } from "@dxcode/plugin";
import { pattern } from "./rules.js";
let kept;
export default definePlugin((dx) => {
  dx.on("tool.call", (event) => {
    if (event.tool === "shell_command" && event.input.command === "rewrite")
      return { action: "modify", input: { command: "echo rewritten" } };
    if (event.tool === "shell_command" && event.input.command === "sneak")
      return { action: "modify", input: { command: "git push --force" } };
  });
  dx.on("tool.call", async (event, ctx) => {
    kept = ctx;
    if (event.tool === "shell_command" && pattern.test(String(event.input.command)))
      return { action: "reject-and-continue", message: "Force pushes are blocked by policy." };
    if (event.tool === "shell_command" && event.input.command === "fake")
      return { action: "synthesize", output: "synthesized" };
    if (event.tool === "shell_command" && event.input.command === "deny")
      return false;
    if (event.tool === "shell_command" && event.input.command === "explode")
      throw new Error("handler exploded");
  });
  dx.on("tool.result", (event) =>
    event.tool === "shell_command" && event.output === "secret-output"
      ? { action: "modify", output: "[redacted by plugin]" }
      : undefined);
  dx.on("agent.end", (event) =>
    event.continuations < 2 ? { action: "continue", message: "Keep going." } : undefined);
  dx.on("agent.start", () => ({ context: "Plugin note." }));
  dx.registerTool({
    name: "count_visits",
    description: "Counts calls and reports install settings.",
    inputSchema: { type: "object", properties: { label: { type: "string", description: "A label." } }, required: ["label"] },
    async execute(input, ctx) {
      const count = ((await ctx.storage.get("visits")) ?? 0) + 1;
      await ctx.storage.set("visits", count);
      let direct;
      try { await fetch("https://api.example.com/direct"); direct = "reached"; } catch (error) { direct = "blocked"; }
      const keys = await ctx.storage.list("vis");
      return { label: input.label, count, keys, settings: await ctx.settings.get(), direct, hasSecrets: ctx.secrets !== undefined };
    },
  });
  dx.registerTool({
    name: "fetch_status",
    description: "Fetches a granted and an ungranted host.",
    async execute(_input, ctx) {
      const granted = await ctx.fetch("https://api.example.com/status").then((response) => response.text());
      const denied = await ctx.fetch("https://evil.example.net/").then(() => "reached", (error) => String(error.message));
      return { granted, denied };
    },
  });
  dx.registerTool({
    name: "use_kept_host",
    description: "Uses a context from an earlier call.",
    async execute() {
      return kept.storage.get("visits").then(() => "reached", (error) => String(error.message));
    },
  });
  dx.registerTool({ name: "view_media", description: "Collides with a workspace tool.", execute: () => "x" });
  dx.registerTool({
    name: "call_dx_tool",
    description: "Calls a dx tool.",
    async execute(_input, ctx) { return ctx.tools.call("echo_tool", { text: "from plugin" }); },
  });
});
`;

const guardFiles = (prefix = ""): ReadonlyArray<FixtureEntry> => [
  {
    name: `${prefix}plugin.json`,
    content: manifest("com.acme.guard", {
      apiVersion: 1,
      entry: "dev.dxcode/index.js",
      permissions: {
        events: ["tool.call", "tool.result", "agent.end", "agent.start"],
        network: ["api.example.com"],
        tools: ["echo_tool"],
      },
      settings: [
        { key: "team", label: "Team", type: "string", default: "core" },
        { key: "limit", label: "Limit", type: "number" },
      ],
    }),
  },
  { name: `${prefix}dev.dxcode/index.js`, content: guard },
  {
    name: `${prefix}dev.dxcode/rules.js`,
    content: "export const pattern = /push\\s+--force/;\n",
  },
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
  target: PluginTarget,
  userId: UserId,
  entries: ReadonlyArray<FixtureEntry>,
) => {
  const bundle = await read(entries);
  seq += 1;
  const id =
    `plg_00000000-0000-4000-8000-${String(seq).padStart(12, "0")}` as PluginId;
  const now = "2026-11-10T12:00:00.000Z";
  await Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* PluginBundleRepository;
      yield* repository.insert(
        Schema.decodeUnknownSync(StoredPluginBundle)({
          id,
          target,
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
  const userId = `usr_worker_host_${people}` as UserId;
  const projectId = `prj_worker_host_${people}`;
  const threadId = `thr_00000000-0000-4000-9000-${String(people).padStart(12, "0")}`;
  const timestamp = "2026-11-10T12:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
    ).bind(userId, userId, `${userId}@example.com`),
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, 'Plugins', ?, ?)",
    ).bind(projectId, userId, timestamp, timestamp),
    env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(threadId, projectId, userId, timestamp, timestamp),
  ]);
  return { userId, threadId };
};

const runtimeFor = async (threadId: string, ownerUserId: string) => {
  const plugins = await resolveThreadCodePlugins(bindings, env.DB, threadId);
  return {
    threadId,
    ownerUserId,
    plugins,
    host: () => ({ db: env.DB, bindings }),
  } satisfies CodePluginRuntime;
};

/** A stand-in dx tool that records whether it ran and with what. */
const fakeTool = (name: string, output: (data: unknown) => string) => {
  const runs: Array<unknown> = [];
  const tool = {
    name,
    description: `${name} for tests`,
    input: undefined,
    output: undefined,
    run: async ({ data }: { data: unknown }) => {
      runs.push(data);
      return output(data);
    },
  } as unknown as ToolDefinition;
  return { tool, runs };
};

const call = (tool: ToolDefinition, data: unknown, id = "call-1") =>
  tool.run({ toolCallId: id, data, log: console } as never);

const gateCase = async () => {
  const { userId, threadId } = await person();
  await install(
    { scope: "personal", id: userId } as PluginTarget,
    userId,
    guardFiles(),
  );
  const runtime = await runtimeFor(threadId, userId);
  expect(runtime.plugins).toHaveLength(1);
  expect(runtime.plugins[0]?.loadError).toBeUndefined();
  expect([...(runtime.plugins[0]?.events ?? [])].sort()).toEqual([
    "agent.end",
    "agent.start",
    "tool.call",
    "tool.result",
  ]);

  const shell = fakeTool("shell_command", (data) =>
    (data as { command: string }).command === "leak"
      ? "secret-output"
      : `ran ${(data as { command: string }).command}`,
  );
  const gated = withPluginToolEvents(shell.tool, runtime);

  await expect(
    call(gated, { command: "git push --force origin main" }),
  ).rejects.toThrow("Force pushes are blocked by policy.");
  expect(shell.runs).toEqual([]);

  expect(await call(gated, { command: "ls" })).toBe("ran ls");
  expect(await call(gated, { command: "rewrite" })).toBe("ran echo rewritten");
  expect(await call(gated, { command: "fake" })).toBe("synthesized");
  // A later handler sees an earlier handler's modify.
  await expect(call(gated, { command: "sneak" })).rejects.toThrow(
    "Force pushes are blocked by policy.",
  );
  // Anything but nothing or an allow keeps the tool from running.
  await expect(call(gated, { command: "deny" })).rejects.toThrow(
    /returned false/,
  );
  expect(await call(gated, { command: "leak" })).toBe("[redacted by plugin]");
  await expect(call(gated, { command: "explode" })).rejects.toThrow(
    /did not allow shell_command: its tool.call handler failed \(.*handler exploded/,
  );
  expect(shell.runs).toEqual([
    { command: "ls" },
    { command: "echo rewritten" },
    { command: "leak" },
  ]);

  // agent.end keeps going twice, then lets the agent stop.
  const install0 = runtime.plugins[0];
  if (install0 === undefined) throw new Error("Expected the plugin.");
  const deps = {
    db: env.DB,
    bindings,
    install: install0,
    threadId,
    ownerUserId: userId,
  };
  expect(
    await dispatchPluginEvent(deps, "agent.end", {
      threadId,
      toolCalls: [],
      continuations: 0,
    }),
  ).toEqual({ action: "continue", message: "Keep going." });
  expect(
    await dispatchPluginEvent(deps, "agent.end", {
      threadId,
      toolCalls: [],
      continuations: 2,
    }),
  ).toBeUndefined();
  expect(
    await dispatchPluginEvent(deps, "agent.start", {
      threadId,
      message: "hi",
    }),
  ).toEqual({ context: "Plugin note." });
};

const toolsCase = async () => {
  const { userId, threadId } = await person();
  await install(
    { scope: "personal", id: userId } as PluginTarget,
    userId,
    guardFiles(),
  );
  const runtime = await runtimeFor(threadId, userId);
  const echo = fakeTool(
    "echo_tool",
    (data) => `echo ${(data as { text: string }).text}`,
  );
  const gatedEcho = withPluginToolEvents(echo.tool, runtime);
  const tools = createPluginTools(runtime, new Set(["echo_tool"]), () => [
    gatedEcho,
  ]);
  expect(tools.map(({ name }) => name)).toEqual([
    "count_visits",
    "fetch_status",
    "use_kept_host",
    "call_dx_tool",
  ]);
  const byName = (name: string) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`Missing ${name}.`);
    return tool;
  };

  const first = JSON.parse(
    String(await call(byName("count_visits"), { label: "a" })),
  );
  expect(first).toEqual({
    label: "a",
    count: 1,
    keys: ["visits"],
    settings: { team: "core" },
    direct: "blocked",
    hasSecrets: false,
  });
  await env.DB.prepare(
    `INSERT INTO plugin_install_setting (plugin_id, key, value_json, updated_at, updated_by_user_id)
       VALUES (?, 'limit', '7', '2026-11-10T12:00:00.000Z', ?)`,
  )
    .bind(runtime.plugins[0]?.pluginId, userId)
    .run();
  const second = JSON.parse(
    String(await call(byName("count_visits"), { label: "b" })),
  );
  expect(second).toMatchObject({
    count: 2,
    settings: { team: "core", limit: 7 },
  });

  network.use(
    http.get("https://api.example.com/status", () =>
      HttpResponse.text("all good"),
    ),
  );
  expect(JSON.parse(String(await call(byName("fetch_status"), {})))).toEqual({
    granted: "all good",
    denied: expect.stringContaining("may not reach evil.example.net"),
  });

  // A context a handler kept from an earlier call reaches nothing.
  await call(
    withPluginToolEvents(fakeTool("shell_command", () => "x").tool, runtime),
    {
      command: "ls",
    },
  );
  // Workers RPC disposes the stub when the call returns; dx's host also
  // refuses it, should a stub outlive its call.
  // On QuickJS nothing survives a call at all, so the kept context is gone.
  expect(
    await call(byName("use_kept_host"), {}).then(String, (error: Error) =>
      String(error.message),
    ),
  ).toMatch(/no longer serves it|used after being disposed|of undefined/);

  // ctx.tools.call reaches the dx tool through the same gate.
  expect(String(await call(byName("call_dx_tool"), {}))).toBe(
    "echo from plugin",
  );
  expect(echo.runs).toEqual([{ text: "from plugin" }]);
};

describe("plugin code on Dynamic Workers", () => {
  it("reads dev.dxcode, stores the modules, and keeps the portable layer when the block is bad", async () => {
    const good = await read(guardFiles());
    expect(good.manifest.code).toMatchObject({
      entry: "dev.dxcode/index.js",
      permissions: {
        events: ["tool.call", "tool.result", "agent.end", "agent.start"],
        network: ["api.example.com"],
        secrets: [],
        ai: false,
      },
    });
    expect(good.codeModules.map(({ path }) => path)).toEqual([
      "dev.dxcode/index.js",
      "dev.dxcode/rules.js",
    ]);
    // Exporting keeps the code layer: the ZIP reads back to the same code.
    const exported = pluginExportFiles({
      bundle: { name: good.manifest.name, manifest: good.manifest } as never,
      skills: [],
      mcpServers: [],
      codeModules: good.codeModules,
    });
    const reread = await read(
      exported.map(({ path, content }) => ({
        name: path,
        content:
          typeof content === "string"
            ? content
            : new TextDecoder().decode(content),
      })),
    );
    expect(reread.manifest.code).toEqual(good.manifest.code);
    // Changing code changes the version: the reviewed hash covers it.
    const changed = await read([
      ...guardFiles().slice(0, 2),
      { name: "dev.dxcode/rules.js", content: "export const pattern = /x/;\n" },
    ]);
    expect(changed.integrity).not.toBe(good.integrity);

    const typescript = await read([
      {
        name: "plugin.json",
        content: manifest("ts-plugin", {
          apiVersion: 1,
          entry: "dev.dxcode/index.ts",
        }),
      },
      { name: "dev.dxcode/index.ts", content: "export default () => {}" },
      {
        name: "skills/helper/SKILL.md",
        content: "---\nname: helper\ndescription: Helps.\n---\n\nHelp.\n",
      },
    ]);
    expect(typescript.manifest.code).toBeUndefined();
    expect(typescript.manifest.skills.map(({ name }) => name)).toEqual([
      "helper",
    ]);
    expect(
      typescript.manifest.skipped.find(({ path }) =>
        path.startsWith("plugin.json#extensions.dev.dxcode"),
      )?.reason,
    ).toContain("dx runs JavaScript");

    const badEvent = await read([
      {
        name: "plugin.json",
        content: manifest("bad-event", {
          apiVersion: 1,
          entry: "dev.dxcode/index.js",
          permissions: { events: ["file.write"] },
        }),
      },
      { name: "dev.dxcode/index.js", content: "export default () => {}" },
    ]).then(
      () => "installed",
      (error: { reason?: string }) => error.reason ?? String(error),
    );
    // Nothing else in it, so a bad code block leaves nothing to import.
    expect(badEvent).toContain("nothing dx can import");
  });

  it("gates tool calls: reject, modify, synthesize, and fail closed", gateCase);

  it("fails closed when a gating plugin's code does not start", async () => {
    const { userId, threadId } = await person();
    await install({ scope: "personal", id: userId } as PluginTarget, userId, [
      {
        name: "plugin.json",
        content: manifest("com.acme.broken", {
          apiVersion: 1,
          entry: "dev.dxcode/index.js",
          permissions: { events: ["tool.call"] },
        }),
      },
      {
        name: "dev.dxcode/index.js",
        content: "export default () => { throw new Error('boom at start'); }",
      },
    ]);
    const runtime = await runtimeFor(threadId, userId);
    expect(runtime.plugins[0]?.loadError).toContain("boom at start");
    const shell = fakeTool("shell_command", () => "ran");
    await expect(
      call(withPluginToolEvents(shell.tool, runtime), { command: "ls" }),
    ).rejects.toThrow(/its code did not start/);
    expect(shell.runs).toEqual([]);
  });

  it(
    "runs registered tools with install storage, settings, granted network, and no other way out",
    toolsCase,
  );

  it("runs only the workspace copy of a plugin both scopes install, on per-owner workers", async () => {
    const first = await person();
    const second = await person();
    const workspaceId = `org_worker_host_${people}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Acme', ?, 1)",
      ).bind(workspaceId, `acme-${people}`),
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', 1)",
      ).bind(`${workspaceId}-1`, workspaceId, first.userId),
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', 1)",
      ).bind(`${workspaceId}-2`, workspaceId, second.userId),
    ]);
    const personal = await install(
      { scope: "personal", id: first.userId } as PluginTarget,
      first.userId,
      guardFiles(),
    );
    const shared = await install(
      { scope: "workspace", id: workspaceId } as PluginTarget,
      first.userId,
      guardFiles(),
    );
    const own = await install(
      { scope: "personal", id: second.userId } as PluginTarget,
      second.userId,
      [
        {
          name: "plugin.json",
          content: manifest("com.acme.other", {
            apiVersion: 1,
            entry: "dev.dxcode/index.js",
          }),
        },
        {
          name: "dev.dxcode/index.js",
          content:
            "export default (dx) => dx.registerTool({ name: 'other_tool', description: 'Other.', execute: () => 'ok' });",
        },
      ],
    );
    const firstRuntime = await runtimeFor(first.threadId, first.userId);
    expect(firstRuntime.plugins.map(({ pluginId }) => pluginId)).toEqual([
      shared.id,
    ]);
    expect(firstRuntime.plugins.map(({ pluginId }) => pluginId)).not.toContain(
      personal.id,
    );
    const secondRuntime = await runtimeFor(second.threadId, second.userId);
    expect(
      secondRuntime.plugins.map(({ pluginId, scope }) => [pluginId, scope]),
    ).toEqual([
      [shared.id, "workspace"],
      [own.id, "personal"],
    ]);
    // Members share the workspace install's worker; personal installs of
    // the same code get workers of their own.
    const workerOf = (plugin: {
      integrity: string;
      scope: string;
      targetId: string;
    }) => pluginWorkerId(plugin);
    const [sharedForFirst] = firstRuntime.plugins;
    const [sharedForSecond] = secondRuntime.plugins;
    if (sharedForFirst === undefined || sharedForSecond === undefined)
      throw new Error("Expected the workspace install.");
    expect(workerOf(sharedForFirst)).toBe(workerOf(sharedForSecond));
    expect(
      workerOf({
        integrity: personal.bundle.integrity,
        scope: "personal",
        targetId: first.userId,
      }),
    ).not.toBe(workerOf(sharedForFirst));
  });
});

describe("webhook triggers on the worker host", () => {
  it("offers a trigger for code that handles trigger.received and delivers to it with no Thread", async () => {
    const { userId } = await person();
    const { id: pluginId, bundle } = await install(
      { scope: "personal", id: userId } as PluginTarget,
      userId,
      [
        {
          name: "plugin.json",
          content: manifest("com.acme.hooks", {
            apiVersion: 1,
            entry: "dev.dxcode/index.js",
            permissions: {
              events: ["trigger.received", "agent.start"],
              ai: true,
              threads: true,
            },
          }),
        },
        {
          name: "dev.dxcode/index.js",
          content: `export default (dx) => {
dx.on("agent.start", async (_event, ctx) => {
  await ctx.storage.set("inThread", { hasThreads: ctx.threads !== undefined, hasThread: ctx.thread !== undefined });
});
dx.on("trigger.received", async (event, ctx) => {
  if (event.data && event.data.fail) throw new Error("rejected by plugin");
  await ctx.storage.set("last", {
    body: event.data,
    trigger: event.trigger.id,
    attempt: event.attempt,
    hasThread: ctx.thread !== undefined,
    hasAi: ctx.ai !== undefined,
    hasThreads: ctx.threads !== undefined,
  });
});
};`,
        },
      ],
    );
    const capabilities = await listCodePluginTriggerCapabilities(
      env.DB,
      userId,
    );
    expect(capabilities).toEqual([
      expect.objectContaining({
        pluginId,
        version: bundle.version,
        capabilityName: "webhook",
        event: "trigger.received",
        idempotent: false,
      }),
    ]);

    const triggerId = `trg_${crypto.randomUUID()}`;
    const at = "2026-11-10T12:00:00.000Z";
    await env.DB.prepare(
      `INSERT INTO plugin_trigger (
         id, owner_user_id, plugin_id, plugin_version, capability_name,
         source, event_type, action_name, idempotent, status, capability_hash,
         created_at, updated_at, rotated_at
       ) VALUES (?, ?, ?, ?, 'webhook', 'webhook', 'trigger.received',
                 'webhook', 0, 'active', ?, ?, ?, ?)`,
    )
      .bind(
        triggerId,
        userId,
        pluginId,
        bundle.version,
        crypto.randomUUID().replaceAll("-", "").repeat(2),
        at,
        at,
        at,
      )
      .run();
    const stub = env.PLUGIN_TRIGGER_DELIVERY.get(
      env.PLUGIN_TRIGGER_DELIVERY.idFromName(triggerId),
    );
    const enqueue = (eventId: string, payload: unknown) =>
      stub.fetch("https://trigger.invalid/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          triggerId,
          eventId,
          idempotencyKey: eventId,
          payload,
        }),
      });
    const deliveries = async () =>
      (
        (await (await stub.fetch("https://trigger.invalid/status")).json()) as {
          deliveries: Array<{ status: string; failureCode?: string }>;
        }
      ).deliveries;

    // The object may also run its own alarm; wait until nothing is queued.
    const settle = async () => {
      for (let tries = 0; tries < 100; tries += 1) {
        await runDurableObjectAlarm(stub);
        const current = await deliveries();
        if (
          current.every(
            ({ status }) => status !== "pending" && status !== "in-flight",
          )
        )
          return current;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Deliveries did not settle.");
    };

    expect((await enqueue("evt-1", { word: "TRIGGERED" })).status).toBe(202);
    await settle();
    expect((await deliveries()).map(({ status }) => status)).toEqual([
      "succeeded",
    ]);
    const stored = await env.DB.prepare(
      "SELECT value_json FROM plugin_install_storage WHERE plugin_id = ? AND key = 'last'",
    )
      .bind(pluginId)
      .first<{ value_json: string }>();
    expect(JSON.parse(stored?.value_json ?? "null")).toEqual({
      body: { word: "TRIGGERED" },
      trigger: triggerId,
      attempt: 1,
      hasThread: false,
      // Model calls bill a Thread's route, so a trigger has none.
      hasAi: false,
      hasThreads: true,
    });

    // Inside a Thread the same plugin cannot start Threads, so it cannot
    // multiply itself through its own Thread events.
    const { threadId } = await person();
    await dispatchPluginEvent(
      {
        db: env.DB,
        bindings,
        install: {
          pluginId,
          name: bundle.manifest.name,
          displayName: bundle.manifest.displayName,
          scope: "personal",
          targetId: userId,
          version: bundle.version,
          integrity: bundle.integrity,
          code: bundle.manifest.code as never,
        },
        threadId,
        ownerUserId: userId,
      },
      "agent.start",
      { threadId, message: "hi" },
    );
    const inThread = await env.DB.prepare(
      "SELECT value_json FROM plugin_install_storage WHERE plugin_id = ? AND key = 'inThread'",
    )
      .bind(pluginId)
      .first<{ value_json: string }>();
    expect(JSON.parse(inThread?.value_json ?? "null")).toEqual({
      hasThreads: false,
      hasThread: true,
    });

    // A handler that throws fails the delivery; it is not retried, since
    // the trigger is not idempotent.
    expect((await enqueue("evt-2", { fail: true })).status).toBe(202);
    const after = await settle();
    expect(after.map(({ status }) => status).sort()).toEqual([
      "dead-letter",
      "succeeded",
    ]);

    // Disabling the plugin stops deliveries.
    await env.DB.prepare("UPDATE trusted_plugin SET enabled = 0 WHERE id = ?")
      .bind(pluginId)
      .run();
    expect((await enqueue("evt-3", {})).status).toBe(403);
  });
});

describe("plugin code on the QuickJS fallback (no Dynamic Worker loader)", () => {
  beforeAll(() => {
    bindings = {
      ...loaderBindings,
      LOADER: undefined,
      DX_PLUGIN_HOST: "quickjs",
    } as Bindings;
  });
  afterAll(() => {
    bindings = loaderBindings;
  });
  it("gates tool calls: reject, modify, synthesize, and fail closed", gateCase);
  it(
    "runs registered tools with install storage, settings, granted network, and no other way out",
    toolsCase,
  );
  it("stops loops, and gives plugins a console and timers that wait", {
    timeout: 120_000,
  }, async () => {
    const { userId, threadId } = await person();
    await install({ scope: "personal", id: userId } as PluginTarget, userId, [
      {
        name: "plugin.json",
        content: manifest("com.acme.timers", {
          apiVersion: 1,
          entry: "dev.dxcode/index.js",
        }),
      },
      {
        name: "dev.dxcode/index.js",
        content: `export default (dx) => {
  dx.registerTool({ name: "spin", description: "Loops forever.", execute: () => { for (;;) {} } });
  dx.registerTool({ name: "spin_async", description: "Awaits forever.", execute: async () => { for (;;) await 0; } });
  dx.registerTool({ name: "wait", description: "Waits, logs, answers.", execute: async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    console.log("waited", { ok: true });
    return "waited";
  } });
};`,
      },
    ]);
    const runtime = await runtimeFor(threadId, userId);
    const tools = createPluginTools(runtime, new Set(), () => []);
    const byName = (name: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`Missing ${name}.`);
      return tool;
    };
    expect(await call(byName("wait"), {})).toBe("waited");
    await expect(call(byName("spin"), {})).rejects.toThrow(/took longer than/);
    await expect(call(byName("spin_async"), {})).rejects.toThrow(
      /took longer than/,
    );
  });

  it("runs no plugin code without the loader unless the operator chose QuickJS", async () => {
    bindings = { ...loaderBindings, LOADER: undefined } as Bindings;
    try {
      const { userId, threadId } = await person();
      await install(
        { scope: "personal", id: userId } as PluginTarget,
        userId,
        guardFiles(),
      );
      const runtime = await runtimeFor(threadId, userId);
      expect(runtime.plugins[0]?.loadError).toContain("DX_PLUGIN_HOST");
      const shell = fakeTool("shell_command", () => "ran");
      await expect(
        call(withPluginToolEvents(shell.tool, runtime), { command: "ls" }),
      ).rejects.toThrow(/its code did not start/);
      expect(shell.runs).toEqual([]);
    } finally {
      bindings = {
        ...loaderBindings,
        LOADER: undefined,
        DX_PLUGIN_HOST: "quickjs",
      } as Bindings;
    }
  });
});
