import { env } from "cloudflare:test";
import {
  PluginBundleRepository,
  type PluginId,
  type PluginTarget,
  type ProjectId,
  ProjectRepository,
  StoredPluginBundle,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { answerPrompt } from "../../src/plugins/thread-ui/store.js";
import { resolveThreadCodePlugins } from "../../src/plugins/worker-host/resolve.js";
import {
  callPluginTool,
  dispatchPluginEvent,
} from "../../src/plugins/worker-host/worker.js";
import { readPluginBundle } from "../../src/settings/plugins/bundles/read-bundle.js";
import { PluginBundleRepositoryD1 } from "../../src/settings/plugins/bundles/repository-d1.js";
import { readZipArchive } from "../../src/settings/plugins/bundles/zip.js";
import {
  buildZip,
  type FixtureEntry,
} from "../../src/settings/plugins/bundles/zip-fixture.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { chunkedBody } from "./chunked-body.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Plugin UI in a Thread, end to end through real Dynamic Workers and the
 * Thread page's HTTP routes: plugin code asks with `ctx.ui.confirm`,
 * `input`, or `select`, the person's answer comes back through
 * `/plugin-ui`, and the plugin's call resolves with it. What can go wrong,
 * and where each case is checked:
 *
 * - the answer never reaches the waiting call, or reaches it wrong
 *   (confirm with fields, select).
 * - the handler's 10 seconds run out while a person reads the prompt.
 * - nobody answers and the call hangs instead of resolving null.
 * - someone other than the owner answers a secret input.
 * - a plugin shows UI its manifest did not grant.
 * - commands, quick actions, notices, and link patterns do not reach the
 *   page, or a command cannot ask.
 */

const origin = "http://dx.test";
const bindings = {
  DB: env.DB,
  LOADER: env.LOADER,
  REALTIME_HUB: env.REALTIME_HUB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  BETTER_AUTH_SECRET: "plugin-thread-ui-secret-000000000000",
} as unknown as Bindings;

const code = `
export default function (dx) {
  dx.on("tool.call", async (event, ctx) => {
    if (event.tool !== "shell_command") return;
    if (event.input.command === "deploy") {
      const answer = await ctx.ui.confirm({
        title: "Deploy?",
        message: "Ships to production.",
        confirmLabel: "Deploy",
        fields: [{ key: "target", label: "Target", value: "prod" }],
      });
      if (answer === null) return { action: "reject-and-continue", message: "nobody answered" };
      if (answer === false) return { action: "reject-and-continue", message: "declined" };
      return { action: "modify", input: { command: "deploy " + answer.target } };
    }
    if (event.input.command === "quick") {
      const answer = await ctx.ui.confirm({ title: "Quick?", timeoutSeconds: 1 });
      return { action: "synthesize", output: String(answer) };
    }
  });
  dx.registerTool({
    name: "ask_token",
    description: "Asks the owner for a token.",
    async execute(_input, ctx) {
      return { token: await ctx.ui.input({ title: "Token", secret: true }) };
    },
  });
  dx.registerTool({
    name: "decorate",
    description: "Adds a quick action and a notice.",
    async execute(_input, ctx) {
      const { id } = await ctx.thread.createQuickAction({ label: "Run checks", action: "send-message", args: { text: "Run the checks." } });
      await ctx.thread.createQuickAction({ label: "Pick", action: "run-command", args: { command: "pick-env" } });
      const bad = await ctx.thread.createQuickAction({ label: "Bad", action: "open-url", args: { url: "javascript:alert(1)" } }).then(() => "made", (error) => error.message);
      await ctx.ui.notify("Checks are ready", { level: "success" });
      return { id, bad };
    },
  });
  dx.registerCommand({
    id: "pick-env",
    title: "Pick a deploy target",
    async run(ctx) {
      const env = await ctx.ui.select({
        title: "Deploy to",
        options: [{ value: "staging", label: "Staging" }, { value: "prod", label: "Production", description: "Live" }],
      });
      await ctx.storage.set("picked", env);
    },
  });
  dx.registerTool({
    name: "read_pick",
    description: "Reads what the command stored.",
    execute: (_input, ctx) => ctx.storage.get("picked"),
  });
  dx.registerLinkPattern({ pattern: /\\bACME-(\\d+)\\b/, url: "https://acme.example/issues/$1", title: "Acme issue" });
  // Catastrophic backtracking on a near-miss: dx never sends it to a page.
  dx.registerLinkPattern({ pattern: /(a+)+$/, url: "https://acme.example/$0" });
  dx.registerTool({
    name: "ask_twice",
    description: "Asks again without awaiting the first question.",
    async execute(_input, ctx) {
      const first = ctx.ui.confirm({ title: "First?", timeoutSeconds: 2 });
      const second = await ctx.ui.confirm({ title: "Second?" }).then(() => "asked", (error) => error.message);
      return { first: await first, second };
    },
  });
}
`;

const unprivileged = `
export default function (dx) {
  dx.registerTool({
    name: "try_ui",
    description: "Tries UI it was not granted.",
    async execute(_input, ctx) {
      return { ui: ctx.ui === undefined, quick: ctx.thread.createQuickAction === undefined };
    },
  });
}
`;

const files = (
  name: string,
  source: string,
  ui: ReadonlyArray<string> | undefined,
): ReadonlyArray<FixtureEntry> => [
  {
    name: "plugin.json",
    content: JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
      name,
      displayName: `${name} plugin`,
      version: "1.0.0",
      description: "Test plugin.",
      extensions: {
        "dev.dxcode": {
          apiVersion: 1,
          entry: "dev.dxcode/index.js",
          permissions: {
            events: ["tool.call"],
            ...(ui === undefined ? {} : { ui }),
          },
        },
      },
    }),
  },
  { name: "dev.dxcode/index.js", content: source },
];

const install = async (
  userId: UserId,
  entries: ReadonlyArray<FixtureEntry>,
  seq: number,
) => {
  const bundle = await Effect.runPromise(
    readZipArchive(await buildZip(entries), {
      maxArchiveBytes: 16 * 1024 * 1024,
      maxEntries: 1_000,
    }).pipe(
      Effect.flatMap((archive) =>
        readPluginBundle(archive, { root: "", fallbackName: "fixture" }),
      ),
    ),
  );
  const id =
    `plg_00000000-0000-4000-8000-${String(900 + seq).padStart(12, "0")}` as PluginId;
  const now = "2026-11-10T12:00:00.000Z";
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
  return bundle;
};

let signups = 0;
/** A signed-in owner with a project and a Thread. */
const owner = async () => {
  signups += 1;
  const email = `plugin-ui-${signups}@example.test`;
  const signedUp = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `203.0.113.${signups + 40}`,
      },
      body: JSON.stringify({
        name: "Plugin Owner",
        email,
        password: "plugin-ui-password-123",
      }),
    },
    bindings,
  );
  expect(signedUp.status).toBe(200);
  const cookie = signedUp.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const userId = (await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id")) as UserId;
  const suffix = String(900 + signups).padStart(12, "0");
  const ownProject = project(
    `prj_00000000-0000-4000-8000-${suffix}`,
    userId,
    "Plugins",
  );
  const ownThread = thread(
    `thr_00000000-0000-4000-9000-${suffix}`,
    ownProject.id as ProjectId,
    userId,
  );
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(ownProject);
      yield* (yield* ThreadRepository).insert(ownThread);
    }),
  );
  const threadId: string = ownThread.id;
  const page = (path: string, init: RequestInit = {}) =>
    app.request(
      `/v1/threads/${threadId}/plugin-ui${path}`,
      {
        ...init,
        headers: {
          cookie,
          origin,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
      },
      bindings,
    );
  return { userId, threadId, page };
};

interface PluginUiBody {
  readonly data: {
    readonly prompts: ReadonlyArray<Record<string, unknown> & { id: string }>;
    readonly notices: ReadonlyArray<Record<string, unknown>>;
    readonly quickActions: ReadonlyArray<Record<string, unknown>>;
    readonly commands: ReadonlyArray<Record<string, unknown> & { id: string }>;
    readonly linkPatterns: ReadonlyArray<Record<string, unknown>>;
  };
}

const read = async (page: Awaited<ReturnType<typeof owner>>["page"]) => {
  const response = await page("");
  expect(response.status).toBe(200);
  return ((await response.json()) as PluginUiBody).data;
};

/** Waits until the page lists a prompt, as the Thread page would. */
const nextPrompt = async (page: Awaited<ReturnType<typeof owner>>["page"]) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [prompt] = (await read(page)).prompts;
    if (prompt !== undefined) return prompt;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("No prompt appeared.");
};

const answer = (
  page: Awaited<ReturnType<typeof owner>>["page"],
  id: string,
  value: unknown,
) =>
  page(`/prompts/${id}`, {
    method: "POST",
    body: JSON.stringify({ answer: value }),
  });

const pluginOf = async (threadId: string, userId: UserId) => {
  const [plugin] = await resolveThreadCodePlugins(bindings, env.DB, threadId);
  if (plugin === undefined) throw new Error("No plugin resolved.");
  return {
    db: env.DB,
    bindings,
    install: plugin,
    threadId,
    ownerUserId: userId,
  };
};

describe("plugin UI in a Thread", () => {
  it("stops reading an oversized request body at its cap", async () => {
    const { page } = await owner();
    // Chunked, with no Content-Length: the route stops at its cap instead of
    // holding the whole 8 MB before parsing it.
    const chunked = chunkedBody({ totalBytes: 8 * 1_024 * 1_024 });
    const refused = await page("/prompts/pui_missing", {
      method: "POST",
      body: chunked.stream,
    });
    expect(refused.status).toBe(400);
    expect(chunked.read.chunks).toBeLessThan(chunked.chunks);
    expect(chunked.read.chunks).toBeLessThanOrEqual(20);
    // A small body still reaches the route, which answers for the prompt.
    const small = await page("/prompts/pui_missing", {
      method: "POST",
      body: JSON.stringify({ answer: true }),
    });
    expect(small.status).toBe(404);
  });

  it("asks above the composer and hands the person's answer back to the waiting handler", async () => {
    const { userId, threadId, page } = await owner();
    await install(
      userId,
      files("com.acme.ui", code, ["prompt", "notify", "quick-action"]),
      1,
    );
    const dependencies = await pluginOf(threadId, userId);

    const decision = dispatchPluginEvent(dependencies, "tool.call", {
      threadId,
      tool: "shell_command",
      callId: "call-1",
      input: { command: "deploy" },
    });
    const prompt = await nextPrompt(page);
    expect(prompt).toMatchObject({
      kind: "confirm",
      plugin: "com.acme.ui plugin",
      title: "Deploy?",
      message: "Ships to production.",
      confirmLabel: "Deploy",
      fields: [{ key: "target", label: "Target", value: "prod" }],
    });
    // Longer than the handler's 10 seconds: its clock stops while it waits.
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    expect((await answer(page, prompt.id, { target: "staging" })).status).toBe(
      200,
    );
    expect(await decision).toEqual({
      action: "modify",
      input: { command: "deploy staging" },
    });
    expect((await read(page)).prompts).toEqual([]);
    // An answered prompt takes no second answer.
    expect((await answer(page, prompt.id, true)).status).toBe(404);

    // Declined.
    const declined = dispatchPluginEvent(dependencies, "tool.call", {
      threadId,
      tool: "shell_command",
      callId: "call-2",
      input: { command: "deploy" },
    });
    await answer(page, (await nextPrompt(page)).id, false);
    expect(await declined).toEqual({
      action: "reject-and-continue",
      message: "declined",
    });

    // Nobody answers: the prompt expires and resolves null.
    expect(
      await dispatchPluginEvent(dependencies, "tool.call", {
        threadId,
        tool: "shell_command",
        callId: "call-3",
        input: { command: "quick" },
      }),
    ).toEqual({ action: "synthesize", output: "null" });
    expect((await read(page)).prompts).toEqual([]);
  }, 40_000);

  it("takes a secret input only from the owner and keeps no copy", async () => {
    const { userId, threadId, page } = await owner();
    await install(userId, files("com.acme.secret", code, ["prompt"]), 2);
    const dependencies = await pluginOf(threadId, userId);
    const result = callPluginTool(dependencies, "ask_token", {});
    const prompt = await nextPrompt(page);
    expect(prompt).toMatchObject({ kind: "input", secret: true });
    expect(
      await answerPrompt(env.DB, {
        threadId,
        promptId: prompt.id,
        userId: "usr_contributor",
        isOwner: false,
        answer: "stolen",
      }),
    ).toBe("owner-only");
    expect((await answer(page, prompt.id, "tok-123")).status).toBe(200);
    expect(await result).toEqual({ token: "tok-123" });
    const kept = await env.DB.prepare(
      "SELECT status, answer_json FROM plugin_ui_prompt WHERE id = ?",
    )
      .bind(prompt.id)
      .first();
    expect(kept).toEqual({ status: "answered", answer_json: null });
  }, 20_000);

  it("shows quick actions, notices, commands, and link patterns, and a command can ask", async () => {
    const { userId, threadId, page } = await owner();
    await install(
      userId,
      files("com.acme.extras", code, ["prompt", "notify", "quick-action"]),
      3,
    );
    const dependencies = await pluginOf(threadId, userId);
    const made = (await callPluginTool(dependencies, "decorate", {})) as {
      id: string;
      bad: string;
    };
    expect(made.bad).toContain("https://");
    const shown = await read(page);
    const pluginId = dependencies.install.pluginId;
    expect(shown.quickActions).toEqual([
      {
        id: made.id,
        plugin: "com.acme.extras plugin",
        pluginName: "com.acme.extras",
        label: "Run checks",
        action: "send-message",
        args: { text: "Run the checks." },
      },
      expect.objectContaining({
        label: "Pick",
        action: "run-command",
        args: { command: `${pluginId}:pick-env` },
      }),
    ]);
    expect(shown.notices).toEqual([
      expect.objectContaining({
        message: "Checks are ready",
        level: "success",
        plugin: "com.acme.extras plugin",
        pluginName: "com.acme.extras",
      }),
    ]);
    expect(shown.commands).toEqual([
      {
        id: `${pluginId}:pick-env`,
        plugin: "com.acme.extras plugin",
        pluginName: "com.acme.extras",
        title: "Pick a deploy target",
      },
    ]);
    expect(shown.linkPatterns).toEqual([
      {
        plugin: "com.acme.extras plugin",
        pluginName: "com.acme.extras",
        pattern: "\\bACME-(\\d+)\\b",
        url: "https://acme.example/issues/$1",
        title: "Acme issue",
      },
    ]);

    const ran = page("/commands", {
      method: "POST",
      body: JSON.stringify({ command: `${pluginId}:pick-env` }),
    });
    const select = await nextPrompt(page);
    expect(select).toMatchObject({
      kind: "select",
      title: "Deploy to",
      options: [
        { value: "staging", label: "Staging" },
        { value: "prod", label: "Production", description: "Live" },
      ],
    });
    expect((await answer(page, select.id, "prod")).status).toBe(200);
    expect((await ran).status).toBe(200);
    expect(await callPluginTool(dependencies, "read_pick", {})).toBe("prod");

    expect(
      (
        await page("/commands", {
          method: "POST",
          body: JSON.stringify({ command: `${pluginId}:missing` }),
        })
      ).status,
    ).toBe(404);
  }, 20_000);

  it("asks one question at a time per call", async () => {
    const { userId, threadId } = await owner();
    await install(userId, files("com.acme.twice", code, ["prompt"]), 5);
    expect(
      await callPluginTool(await pluginOf(threadId, userId), "ask_twice", {}),
    ).toEqual({
      first: null,
      second: expect.stringContaining("one question at a time"),
    });
  }, 20_000);

  it("gives a plugin no UI its manifest did not grant", async () => {
    const { userId, threadId } = await owner();
    await install(userId, files("com.acme.plain", unprivileged, undefined), 4);
    expect(
      await callPluginTool(await pluginOf(threadId, userId), "try_ui", {}),
    ).toEqual({ ui: true, quick: true });
  });
});
