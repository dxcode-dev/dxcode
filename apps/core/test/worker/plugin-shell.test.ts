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
import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import {
  type CodePluginRuntime,
  createPluginTools,
  pluginShellGate,
  withPluginToolEvents,
} from "../../src/plugins/worker-host/agent.js";
import { resolveThreadCodePlugins } from "../../src/plugins/worker-host/resolve.js";
import {
  dispatchPluginEvent,
  runPluginCommand,
} from "../../src/plugins/worker-host/worker.js";
import { pluginPermissionDiff } from "../../src/settings/plugins/bundles/permission-diff.js";
import { readPluginBundle } from "../../src/settings/plugins/bundles/read-bundle.js";
import { PluginBundleRepositoryD1 } from "../../src/settings/plugins/bundles/repository-d1.js";
import { readZipArchive } from "../../src/settings/plugins/bundles/zip.js";
import {
  buildZip,
  type FixtureEntry,
} from "../../src/settings/plugins/bundles/zip-fixture.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

/**
 * Plugin code's shell commands (`ctx.$`, `permissions.shell`) through real
 * Dynamic Workers, D1, and the Thread's tool.call gate, with the Orb
 * replaced by a recorder (`plugin-shell` against real bash is in
 * src/plugins/worker-host/shell.test.ts). Ways it could fail, each checked:
 *
 * - code without the permission, or a webhook delivery, gets `ctx.$`
 * - an interpolated value injects shell syntax
 * - another plugin's tool.call handler cannot see, reject, or rewrite a
 *   plugin's command, or a check recurses into more commands
 * - a palette command outside a turn skips the gate
 * - a command runs without an audit row, or the row holds its output
 * - adding the permission in an update does not ask for a new review
 */

interface OrbRun {
  readonly threadId: string;
  readonly command: string;
  readonly directory: string;
}
const orbRuns: Array<OrbRun> = [];

/** Text as `od -An -v -tx1` prints it, a space before each byte. */
const hex = (text: string) =>
  Array.from(
    new TextEncoder().encode(text),
    (byte) => ` ${byte.toString(16).padStart(2, "0")}`,
  ).join("");

/** Undoes one level of single-quote shell quoting. */
const unquote = (text: string) => text.replaceAll("'\\''", "'");

vi.mock("../../src/execution/execution-workspaces.js", () => ({
  ExecutionWorkspaces: {
    existingSandboxFactory: {
      createSandbox: async ({ id }: { id: string }) => ({
        cwd: "/workspace/repo",
        exec: async (script: string) => {
          const inner = unquote(script.slice("bash -c '".length, -1));
          const command = unquote(
            /timeout -k 2s \d+s bash -c '((?:[^']|'\\'')*)' <\/dev\/null/.exec(
              inner,
            )?.[1] ?? "",
          );
          const directory = unquote(
            /cd -- '((?:[^']|'\\'')*)'/.exec(inner)?.[1] ?? "",
          );
          orbRuns.push({ threadId: id, command, directory });
          const out = command.startsWith("git status")
            ? " M src/app.ts\n"
            : `ran: ${command}\n`;
          const err = command.includes("fail") ? "boom\n" : "";
          const code = command.includes("fail") ? 2 : 0;
          return {
            exitCode: 0,
            stderr: "",
            stdout: `login noise\nDXSHELL2 ${code} ${out.length} ${err.length} 0\n${hex(out)}\n${hex(err)}\n`,
          };
        },
      }),
    },
  },
}));

const bindings = {
  DB: env.DB,
  LOADER: (env as unknown as { LOADER: WorkerLoader }).LOADER,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
} as Bindings;

const manifest = (name: string, permissions: unknown) =>
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
    name,
    displayName: `${name} plugin`,
    version: "1.0.0",
    description: "Test plugin.",
    extensions: {
      "dev.dxcode": {
        apiVersion: 1,
        entry: "dev.dxcode/index.js",
        permissions,
      },
    },
  });

const files = (
  name: string,
  permissions: unknown,
  code: string,
): ReadonlyArray<FixtureEntry> => [
  { name: "plugin.json", content: manifest(name, permissions) },
  { name: "dev.dxcode/index.js", content: code },
];

/** Runs commands, and reports what its context offers. */
const runner = `
export default (dx) => {
  dx.registerTool({
    name: "repo_status",
    description: "git status for a path.",
    async execute(input, ctx) {
      return ctx.$\`git status --short -- \${input.path} \${ctx.$.raw("| cat")}\`;
    },
  });
  dx.registerTool({
    name: "run_line",
    description: "Runs a built command line.",
    async execute(input, ctx) {
      try { return await ctx.exec(input.command, { cwd: input.cwd }); }
      catch (error) { return { refused: String(error.message) }; }
    },
  });
  dx.registerCommand({
    id: "status",
    title: "Status",
    async run(ctx) { await ctx.storage.set("last", await ctx.$.with({ timeoutMs: 5000 })\`git status\`); },
  });
  dx.on("trigger.received", async (_event, ctx) => {
    await ctx.storage.set("trigger-has-shell", typeof ctx.$);
  });
};
`;

/** Gates every shell_command, and tries to run one of its own while it does. */
const guard = `
export default (dx) => {
  dx.on("tool.call", async (event, ctx) => {
    if (event.tool !== "shell_command") return;
    const seen = (await ctx.storage.get("seen")) ?? [];
    seen.push({ plugin: event.plugin ?? null, command: event.input.command, workdir: event.input.workdir ?? null, hasShell: typeof ctx.$ });
    await ctx.storage.set("seen", seen);
    if (/--force/.test(String(event.input.command)))
      return { action: "reject-and-continue", message: "Force pushes are blocked by the guard." };
    if (event.input.command === "rewrite-me")
      return { action: "modify", input: { ...event.input, command: "echo rewritten" } };
  });
};
`;

const without = `
export default (dx) => {
  dx.registerTool({ name: "has_shell", description: "Reports ctx.$.", execute: (_input, ctx) => ({ $: typeof ctx.$, exec: typeof ctx.exec }) });
};
`;

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
    `plg_00000000-0000-4000-8000-${String(900 + seq).padStart(12, "0")}` as PluginId;
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
  const userId = `usr_plugin_shell_${people}` as UserId;
  const projectId = `prj_plugin_shell_${people}`;
  const threadId = `thr_00000000-0000-4000-9000-${String(900 + people).padStart(12, "0")}`;
  const timestamp = "2026-11-11T12:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
    ).bind(userId, userId, `${userId}@example.com`),
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, 'Shell', ?, ?)",
    ).bind(projectId, userId, timestamp, timestamp),
    env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(threadId, projectId, userId, timestamp, timestamp),
  ]);
  return { userId, threadId };
};

const stored = async (pluginId: string, key: string) => {
  const row = await env.DB.prepare(
    "SELECT value_json FROM plugin_install_storage WHERE plugin_id = ? AND key = ?",
  )
    .bind(pluginId, key)
    .first<{ value_json: string }>();
  return row === null ? undefined : (JSON.parse(row.value_json) as unknown);
};

const audits = async (threadId: string) =>
  (
    await env.DB.prepare(
      `SELECT plugin_name, action, target, outcome, detail_json FROM plugin_audit
        WHERE thread_id = ? AND action = 'shell.exec' ORDER BY created_at, rowid`,
    )
      .bind(threadId)
      .all<{
        plugin_name: string;
        action: string;
        target: string;
        outcome: string;
        detail_json: string;
      }>()
  ).results.map((row) => ({
    ...row,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
  }));

const call = (tool: ToolDefinition, data: unknown, id = "call-1") =>
  tool.run({ toolCallId: id, data, log: console } as never);

const toolOf = (tools: ReadonlyArray<ToolDefinition>, name: string) => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Missing ${name}.`);
  return tool;
};

describe("plugin shell commands on the worker host", () => {
  it("runs a granted plugin's commands in the Thread's Orb behind the other plugins' gate", async () => {
    const { userId, threadId } = await person();
    const ran = await install(
      userId,
      files(
        "com.acme.runner",
        { events: ["trigger.received"], shell: true },
        runner,
      ),
    );
    const guarded = await install(
      userId,
      files("com.acme.guard", { events: ["tool.call"], shell: true }, guard),
    );
    await install(userId, files("com.acme.without", {}, without));
    expect(ran.bundle.manifest.code?.permissions.shell).toBe(true);

    const plugins = await resolveThreadCodePlugins(bindings, env.DB, threadId);
    expect(plugins.map(({ loadError }) => loadError)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    const runtime: CodePluginRuntime = {
      threadId,
      ownerUserId: userId,
      plugins,
      host: () => ({ db: env.DB, bindings }),
    };
    const tools = createPluginTools(runtime, new Set(), () => []);
    orbRuns.length = 0;

    // A value from the model is one quoted word, run in the checkout.
    // A tool input shaped like a raw marker is still one quoted word.
    const status = await call(toolOf(tools, "repo_status"), {
      path: { raw: "src; rm -rf ~" },
    });
    expect(JSON.parse(String(status))).toEqual({
      exitCode: 0,
      stdout: " M src/app.ts\n",
      stderr: "",
      timedOut: false,
      truncated: false,
    });
    expect(orbRuns).toEqual([
      {
        threadId,
        command: `git status --short -- '{"raw":"src; rm -rf ~"}' | cat`,
        directory: "/workspace/repo",
      },
    ]);

    // A non-zero exit resolves; a folder resolves inside the checkout.
    expect(
      JSON.parse(
        String(
          await call(toolOf(tools, "run_line"), {
            command: "make fail",
            cwd: "apps/web",
          }),
        ),
      ),
    ).toMatchObject({ exitCode: 2, stderr: "boom\n" });
    expect(orbRuns.at(-1)?.directory).toBe("/workspace/repo/apps/web");

    // The guard sees the command as shell_command from the plugin, and
    // rejects or rewrites it before the Orb runs anything.
    const before = orbRuns.length;
    expect(
      JSON.parse(
        String(
          await call(toolOf(tools, "run_line"), {
            command: "git push --force origin main",
          }),
        ),
      ),
    ).toEqual({ refused: "Force pushes are blocked by the guard." });
    expect(orbRuns.length).toBe(before);
    await call(toolOf(tools, "run_line"), { command: "rewrite-me" });
    expect(orbRuns.at(-1)?.command).toBe("echo rewritten");
    // Leaving the checkout is refused here too.
    expect(
      JSON.parse(
        String(
          await call(toolOf(tools, "run_line"), { command: "ls", cwd: "../" }),
        ),
      ),
    ).toEqual({ refused: expect.stringContaining("stays inside it") });

    // The agent's own shell_command reaches the same guard, which may run
    // commands then; while it checks a plugin's command it has no ctx.$,
    // and the runner, the caller, never checks itself.
    const shell = withPluginToolEvents(
      {
        name: "shell_command",
        description: "stand-in",
        run: async () => "agent ran",
      } as unknown as ToolDefinition,
      runtime,
    );
    expect(await call(shell, { command: "ls" })).toBe("agent ran");
    expect(await stored(guarded.id, "seen")).toEqual([
      {
        plugin: "com.acme.runner",
        command: `git status --short -- '{"raw":"src; rm -rf ~"}' | cat`,
        workdir: "/workspace/repo",
        hasShell: "undefined",
      },
      {
        plugin: "com.acme.runner",
        command: "make fail",
        workdir: "/workspace/repo/apps/web",
        hasShell: "undefined",
      },
      {
        plugin: "com.acme.runner",
        command: "git push --force origin main",
        workdir: "/workspace/repo",
        hasShell: "undefined",
      },
      {
        plugin: "com.acme.runner",
        command: "rewrite-me",
        workdir: "/workspace/repo",
        hasShell: "undefined",
      },
      { plugin: null, command: "ls", workdir: null, hasShell: "function" },
    ]);

    // Without the permission, the context has no runner.
    expect(
      JSON.parse(String(await call(toolOf(tools, "has_shell"), {}))),
    ).toEqual({ $: "undefined", exec: "undefined" });

    // A palette command outside a turn runs behind the same gate.
    const runnerPlugin = plugins.find(({ pluginId }) => pluginId === ran.id);
    if (runnerPlugin === undefined) throw new Error("Expected the runner.");
    await runPluginCommand(
      {
        db: env.DB,
        bindings,
        install: runnerPlugin,
        threadId,
        ownerUserId: userId,
        shellGate: pluginShellGate(runtime, runnerPlugin),
      },
      "status",
    );
    expect(await stored(ran.id, "last")).toMatchObject({
      stdout: " M src/app.ts\n",
    });
    expect(
      ((await stored(guarded.id, "seen")) as Array<{ command: string }>).at(-1),
    ).toMatchObject({ command: "git status" });

    // A webhook delivery has no Thread, so no Orb and no ctx.$.
    await dispatchPluginEvent(
      { db: env.DB, bindings, install: runnerPlugin, ownerUserId: userId },
      "trigger.received",
      {
        trigger: { id: "trg_1" },
        data: {},
        eventId: "evt_1",
        deliveryId: "dlv_1",
        idempotencyKey: "idem_1",
        attempt: 1,
      },
    );
    expect(await stored(ran.id, "trigger-has-shell")).toBe("undefined");

    // One audit row per command, run or refused, without its output.
    const rows = await audits(threadId);
    expect(
      rows.map(({ plugin_name, outcome, target, detail }) => ({
        plugin_name,
        outcome,
        target,
        program: detail.program,
        exitCode: detail.exitCode,
      })),
    ).toEqual([
      {
        plugin_name: "com.acme.runner",
        outcome: "success",
        target: threadId,
        program: "git",
        exitCode: 0,
      },
      {
        plugin_name: "com.acme.runner",
        outcome: "success",
        target: threadId,
        program: "make",
        exitCode: 2,
      },
      {
        plugin_name: "com.acme.runner",
        outcome: "rejected",
        target: threadId,
        program: "git",
        exitCode: undefined,
      },
      {
        plugin_name: "com.acme.runner",
        outcome: "success",
        target: threadId,
        program: "echo",
        exitCode: 0,
      },
      {
        plugin_name: "com.acme.runner",
        outcome: "rejected",
        target: threadId,
        program: "ls",
        exitCode: undefined,
      },
      {
        plugin_name: "com.acme.runner",
        outcome: "success",
        target: threadId,
        program: "git",
        exitCode: 0,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("src/app.ts");
    expect(JSON.stringify(rows)).not.toContain("boom");
  });

  it("asks for a new review when an update adds the permission", async () => {
    const before = await read(files("com.acme.later", {}, without));
    const after = await read(files("com.acme.later", { shell: true }, without));
    expect(pluginPermissionDiff(before.manifest, after.manifest)).toEqual({
      widens: true,
      changes: [
        {
          permission: "shell",
          added: ["run commands in the Orb"],
          removed: [],
        },
      ],
    });
    expect(pluginPermissionDiff(after.manifest, before.manifest).widens).toBe(
      false,
    );
  });
});
