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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
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
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Plugin panes, end to end through real Dynamic Workers and the Thread
 * page's HTTP routes: a plugin registers a pane, its code opens it and
 * posts to it, the page reads the view and the posts, and the view's
 * `dx/plugin.post` reaches the pane's `onMessage`, which posts back. What
 * can go wrong, and where each case is checked:
 *
 * - a pane shows without the `pane` grant, or `ctx.panes` exists without it.
 * - the page cannot find the pane, or gets another plugin's HTML.
 * - posts arrive out of order, are lost, or pile up past the kept 20.
 * - an open request never reaches the page.
 * - a view's message never reaches `onMessage`, or its answer never
 *   comes back, or `onMessage` cannot update the pane live.
 * - an open-pane quick action without the grant, a bad pane id, or an
 *   oversized post is accepted.
 */

const origin = "http://dx.test";
const loaderBindings = {
  DB: env.DB,
  LOADER: env.LOADER,
  REALTIME_HUB: env.REALTIME_HUB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  BETTER_AUTH_SECRET: "plugin-panes-secret-0000000000000000",
} as unknown as Bindings;
/** The deployment the cases run against; the QuickJS case drops LOADER. */
let bindings = loaderBindings;

const BOARD =
  "<!doctype html><title>Board</title><body><ul id=board></ul></body>";

const code = `
export default function (dx) {
  let clicks = 0;
  dx.registerPane({
    id: "board",
    title: "Release board",
    html: ${JSON.stringify(BOARD)},
    async onMessage(message, ctx) {
      clicks += 1;
      await ctx.panes.get("board").post({ echo: message, clicks });
      return { got: message };
    },
  });
  dx.registerPane({ id: "log", title: "Log", html: "<p>log</p>" });
  dx.on("tool.result", async (event, ctx) => {
    await ctx.panes.get("board").post({ tool: event.tool });
  });
  dx.registerTool({
    name: "open_board",
    description: "Opens the board and posts to it.",
    async execute(input, ctx) {
      const board = ctx.panes.get("board");
      await board.open();
      for (let i = 0; i < (input.posts ?? 0); i += 1) await board.post({ n: i });
      const unknown = (() => { try { ctx.panes.get("nope"); return "found"; } catch (error) { return error.message; } })();
      const big = await board.post({ text: "x".repeat(70000) }).then(() => "posted", (error) => error.message);
      const { id } = await ctx.thread.createQuickAction({ label: "Board", action: "open-pane", args: { pane: "board" } });
      return { unknown, big, quick: id };
    },
  });
}
`;

const ungranted = `
export default function (dx) {
  dx.registerPane({ id: "secret", title: "Secret", html: "<p>no</p>" });
  dx.registerTool({
    name: "try_pane",
    description: "Tries panes it was not granted.",
    async execute(_input, ctx) {
      const quick = await ctx.thread.createQuickAction({ label: "Open", action: "open-pane", args: { pane: "secret" } }).then(() => "made", (error) => error.message);
      return { panes: ctx.panes === undefined, quick };
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
            events: ["tool.call", "tool.result"],
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
    `plg_00000000-0000-4000-8000-${String(950 + seq).padStart(12, "0")}` as PluginId;
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
  const email = `plugin-pane-${signups}@example.test`;
  const signedUp = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `203.0.113.${signups + 140}`,
      },
      body: JSON.stringify({
        name: "Plugin Owner",
        email,
        password: "plugin-pane-password-123",
      }),
    },
    bindings,
  );
  expect(signedUp.status).toBe(200);
  const cookie = signedUp.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const userId = (await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id")) as UserId;
  const suffix = String(950 + signups).padStart(12, "0");
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

interface PaneEntry {
  readonly plugin: string;
  readonly pane: string;
  readonly title: string;
  readonly openedAt?: string;
}

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

const json = async <T>(response: Response) => {
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: T }).data;
};

/** A view's `dx/plugin.post` reaches `onMessage`, which posts back. */
const messageCase = async (seq: number) => {
  const { userId, page } = await owner();
  await install(userId, files("com.acme.board", code, ["pane"]), seq);
  const post = (pane: string, message: unknown) =>
    page(`/panes/com.acme.board/${pane}/messages`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  const answered = await json<{ result: unknown }>(
    await post("board", { click: "ship" }),
  );
  expect(answered.result).toEqual({ got: { click: "ship" } });
  const { messages } = await json<{
    messages: ReadonlyArray<{ message: unknown }>;
  }>(await page("/panes/com.acme.board/board/messages"));
  expect(messages.map(({ message }) => message)).toEqual([
    { echo: { click: "ship" }, clicks: 1 },
  ]);
  // A pane without onMessage takes no messages.
  expect((await post("log", { hi: true })).status).toBe(404);
};

describe("plugin panes in a Thread", () => {
  it("opens a pane, serves its view, and delivers posts in order, live and to late openers", async () => {
    const { userId, threadId, page } = await owner();
    await install(
      userId,
      files("com.acme.board", code, ["pane", "quick-action"]),
      1,
    );
    const dependencies = await pluginOf(threadId, userId);
    const result = (await callPluginTool(dependencies, "open_board", {
      posts: 23,
    })) as { unknown: string; big: string; quick: string };
    expect(result.unknown).toContain("registered no pane nope");
    expect(result.big).toContain("64 KB");

    const ui = await json<{
      panes: ReadonlyArray<PaneEntry>;
      quickActions: ReadonlyArray<{ action: string; args: { pane?: string } }>;
    }>(await page(""));
    expect(ui.panes.map(({ pane, title }) => [pane, title])).toEqual([
      ["board", "Release board"],
      ["log", "Log"],
    ]);
    const board = ui.panes.find(({ pane }) => pane === "board");
    expect(board?.plugin).toBe("com.acme.board");
    expect(board?.openedAt).toBeDefined();
    expect(
      ui.panes.find(({ pane }) => pane === "log")?.openedAt,
    ).toBeUndefined();
    expect(ui.quickActions).toEqual([
      expect.objectContaining({
        action: "open-pane",
        args: { pane: "com.acme.board/board" },
      }),
    ]);

    const view = await json<{ html: string }>(
      await page("/panes/com.acme.board/board"),
    );
    expect(view.html).toBe(BOARD);
    expect((await page("/panes/com.acme.board/missing")).status).toBe(404);
    expect((await page("/panes/com.other/board")).status).toBe(404);

    // 23 posts within a minute: an open pane that missed the burst gets
    // every one, in order.
    const read = async (after = 0) =>
      (
        await json<{
          messages: ReadonlyArray<{ seq: number; message: unknown }>;
        }>(await page(`/panes/com.acme.board/board/messages?after=${after}`))
      ).messages;
    const burst = await read();
    expect(burst.map(({ message }) => (message as { n: number }).n)).toEqual(
      Array.from({ length: 23 }, (_, index) => index),
    );
    const last = burst.at(-1)?.seq ?? 0;

    // An event handler posts; an open pane reads only what is new.
    await dispatchPluginEvent(dependencies, "tool.result", {
      threadId,
      tool: "shell_command",
      callId: "call-1",
      input: {},
      status: "done",
    });
    expect((await read(last)).map(({ message }) => message)).toEqual([
      { tool: "shell_command" },
    ]);

    // Once the posts are a minute old, the next post leaves the newest 20.
    await env.DB.prepare(
      "UPDATE plugin_pane_event SET created_at = '2020-01-01T00:00:00.000Z' WHERE thread_id = ?",
    )
      .bind(threadId)
      .run();
    await dispatchPluginEvent(dependencies, "tool.result", {
      threadId,
      tool: "read_file",
      callId: "call-2",
      input: {},
      status: "done",
    });
    const kept = await read();
    expect(kept).toHaveLength(20);
    expect(kept.at(-2)?.message).toEqual({ tool: "shell_command" });
    expect(kept.at(-1)?.message).toEqual({ tool: "read_file" });
    expect(kept[0]?.message).toEqual({ n: 5 });
  });

  it("hands a view's message to onMessage, answers it, and lets the plugin post back", () =>
    messageCase(2));

  it("shows no pane, and no ctx.panes, without the pane grant", async () => {
    const { userId, threadId, page } = await owner();
    await install(
      userId,
      files("com.acme.quiet", ungranted, ["quick-action"]),
      3,
    );
    const result = (await callPluginTool(
      await pluginOf(threadId, userId),
      "try_pane",
      {},
    )) as { panes: boolean; quick: string };
    expect(result.panes).toBe(true);
    expect(result.quick).toContain("not granted the pane UI permission");
    const ui = await json<{ panes: ReadonlyArray<unknown> }>(await page(""));
    expect(ui.panes).toEqual([]);
    expect((await page("/panes/com.acme.quiet/secret")).status).toBe(404);
  });
});

describe("plugin panes on the QuickJS fallback (no Dynamic Worker loader)", () => {
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
  it("hands a view's message to onMessage, answers it, and lets the plugin post back", () =>
    messageCase(4));
});
