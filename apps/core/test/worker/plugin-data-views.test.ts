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
import { verifyViewWatch } from "../../src/plugins/views/watch-token.js";
import { resolveThreadCodePlugins } from "../../src/plugins/worker-host/resolve.js";
import { callPluginTool } from "../../src/plugins/worker-host/worker.js";
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
import { countD1Calls } from "./d1-call-counter.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Views described as data, end to end through real Dynamic Workers and dx's
 * HTTP routes. Ways this could go wrong, each checked below:
 *
 * Install: a view file that does not describe a view installs anyway, or is
 * refused without naming the part and field at fault; a good view's file is
 * not stored, or its address (integrity) does not match its text.
 *
 * State: a page shows state before the plugin set any; `ctx.views.set`
 * from plugin code does not reach the store, or loses the file's initial
 * state; a set past 512 KB, to a malformed path, or to a view the plugin
 * does not declare is stored or half-stored; HTML in state comes back as
 * anything but the same text; a watch token is not tied to the person and
 * view.
 *
 * Calls: a view's call runs a function the manifest does not export; it
 * runs as someone other than the person who clicked; its reply does not
 * land at `result`; it leaves no audit row.
 *
 * Shared Threads: a member cannot see the owner's view; a member's click
 * reaches the owner's personal plugin; a member's click on a workspace
 * plugin is refused, or runs as the owner.
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
  BETTER_AUTH_SECRET: "plugin-data-views-secret-000000000000",
  AI: { run: async () => ({}) },
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
} as unknown as Bindings;

const dashboard = {
  title: "Log watch",
  state: { stats: { errors: 0 }, rows: [], note: "Waiting for events." },
  parts: [
    {
      type: "stat",
      label: "Errors",
      bind: "stats.errors",
      format: "number",
      hint: "Error lines in the last minute.",
    },
    {
      type: "table",
      id: "recent",
      bind: "rows",
      columns: [
        { key: "message", label: "Message" },
        {
          key: "level",
          label: "Level",
          hint: "The level the service logged.",
          tones: { error: "danger" },
        },
      ],
      rowAction: {
        type: "start_thread",
        label: "Investigate line",
        prompt: "Investigate {{row.message}}",
      },
    },
    {
      type: "form",
      id: "search",
      fields: [{ type: "input", name: "query", label: "Search" }],
      submit: {
        label: "Search",
        action: {
          type: "call",
          fn: "search",
          args: { query: "{{form.query}}" },
          result: "results",
        },
      },
    },
    { type: "text", bind: "note" },
  ],
};

const broken = {
  title: "Broken",
  parts: [
    {
      type: "table",
      id: "recent",
      bind: "rows",
      columns: [{ label: "Message" }],
    },
    { type: "sparkle" },
    {
      type: "table",
      id: "long",
      bind: "rows",
      columns: [{ key: "message", label: "Message", hint: "x".repeat(201) }],
      rowAction: { type: "call", fn: "filter", label: "y".repeat(41) },
    },
    { type: "stat", label: "Lines", bind: "lines", hint: "" },
  ],
};

const code = `
export default function (dx) {
  dx.registerTool({
    name: "record",
    description: "Records events into the dashboard.",
    async execute(input, ctx) {
      const results = {};
      for (const [path, value] of input.sets) {
        try {
          results[path] = { version: await ctx.views.set(input.view ?? "dashboard", path, value) };
        } catch (error) {
          results[path] = { error: error.message };
        }
      }
      return results;
    },
  });
  dx.registerTool({
    name: "summary",
    description: "The dashboard as a card.",
    async execute(_input, ctx) {
      return { errors: await ctx.views.get("dashboard", "stats.errors"), ...ctx.views.card("dashboard") };
    },
  });
  dx.expose({
    async search(args, ctx) {
      await ctx.views.set("dashboard", "lastSearchBy", ctx.caller.userId);
      return { query: args.query, caller: ctx.caller.userId, hits: 2 };
    },
  });
}
`;

const files = (
  name: string,
  views: ReadonlyArray<Record<string, unknown>>,
  extra: ReadonlyArray<FixtureEntry> = [],
): ReadonlyArray<FixtureEntry> => [
  {
    name: "plugin.json",
    content: JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
      name,
      displayName: "Log Watch",
      version: "1.0.0",
      description: "Test plugin.",
      extensions: {
        "dev.dxcode": {
          apiVersion: 1,
          entry: "dev.dxcode/index.js",
          permissions: { events: [] },
          views,
          exports: [{ name: "search", description: "Searches the log." }],
        },
      },
    }),
  },
  { name: "dev.dxcode/index.js", content: code },
  { name: "views/dashboard.json", content: JSON.stringify(dashboard) },
  ...extra,
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

let installs = 0;
const install = async (
  target: PluginTarget,
  userId: UserId,
  entries: ReadonlyArray<FixtureEntry>,
) => {
  installs += 1;
  const bundle = await read(entries);
  const id =
    `plg_00000000-0000-4000-8000-${String(3_100 + installs).padStart(12, "0")}` as PluginId;
  const now = "2026-11-25T12:00:00.000Z";
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* PluginBundleRepository).insert(
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
  return id;
};

let signups = 0;
const signUp = async () => {
  signups += 1;
  const email = `plugin-data-views-${signups}@example.test`;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `203.0.113.${signups + 60}`,
      },
      body: JSON.stringify({
        name: `Person ${signups}`,
        email,
        password: "plugin-data-views-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const userId = (await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id")) as UserId;
  const call = (path: string, init: RequestInit = {}) =>
    app.request(
      path,
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
  return { userId, call, cookie };
};

/** An owner's Thread, shared with a member of their workspace for Contribute. */
const sharedThread = async () => {
  const owner = await signUp();
  const member = await signUp();
  const n = String(3_100 + signups).padStart(12, "0");
  const projectId = `prj_00000000-0000-4000-8000-${n}` as ProjectId;
  const threadId = `thr_00000000-0000-4000-9000-${n}`;
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(
        project(projectId, owner.userId, "Ops"),
      );
      yield* (yield* ThreadRepository).insert(
        thread(threadId, projectId, owner.userId),
      );
    }),
  );
  const workspaceId = `org_data_views_${signups}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Acme', ?, 1)",
    ).bind(workspaceId, `acme-data-views-${signups}`),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', 1)",
    ).bind(`${workspaceId}-1`, workspaceId, owner.userId),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', 1)",
    ).bind(`${workspaceId}-2`, workspaceId, member.userId),
    env.DB.prepare("UPDATE projects SET workspace_id = ? WHERE id = ?").bind(
      workspaceId,
      projectId,
    ),
    env.DB.prepare(
      "UPDATE threads SET workspace_access = 'contribute', contribute_until = '2099-01-01T00:00:00.000Z', shared_workspace_id = ? WHERE id = ?",
    ).bind(workspaceId, threadId),
  ]);
  return {
    owner: {
      ...owner,
      // The same request through another binding, to count its D1 calls.
      callWith: (path: string, db: D1Database) =>
        app.request(
          path,
          { headers: { cookie: owner.cookie, origin } },
          { ...bindings, DB: db },
        ),
    },
    member,
    threadId,
    workspaceId,
  };
};

const data = async <T>(response: Response) => {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
};

interface StateData {
  readonly state: unknown;
  readonly version: number;
  readonly watch?: string;
  readonly key: string;
}

const record = async (
  threadId: string,
  userId: UserId,
  name: string,
  sets: ReadonlyArray<readonly [string, unknown]>,
  view?: string,
) => {
  const plugins = await resolveThreadCodePlugins(bindings, env.DB, threadId);
  const install = plugins.find((plugin) => plugin.name === name);
  if (install === undefined) throw new Error(`${name} did not resolve.`);
  return (await callPluginTool(
    { db: env.DB, bindings, install, threadId, ownerUserId: userId },
    "record",
    { sets, ...(view === undefined ? {} : { view }) },
  )) as Record<string, { version?: number; error?: string }>;
};

const audit = (pluginName: string) =>
  env.DB.prepare(
    `SELECT target, outcome, detail_json FROM plugin_audit
      WHERE plugin_name = ? AND action = 'view.call' ORDER BY created_at, id`,
  )
    .bind(pluginName)
    .all<{ target: string; outcome: string; detail_json: string }>();

describe("views described as data", () => {
  it("installs a good view, and leaves out a broken one with the part and field at fault", async () => {
    const bundle = await read(
      files(
        "logwatch",
        [
          {
            id: "dashboard",
            title: "Dashboard",
            file: "views/dashboard.json",
            show: ["page", "panel"],
          },
          { id: "broken", title: "Broken", file: "views/broken.json" },
        ],
        [{ name: "views/broken.json", content: JSON.stringify(broken) }],
      ),
    );
    const views = bundle.manifest.code?.dataViews ?? [];
    expect(views.map(({ id, show }) => ({ id, show }))).toEqual([
      { id: "dashboard", show: ["page", "panel"] },
    ]);
    const skipped = bundle.manifest.skipped.filter(
      ({ path }) => path.endsWith("views[1]") || path === "views/broken.json",
    );
    expect(skipped.map(({ reason }) => reason)).toEqual([
      "This view is left out. views/broken.json does not describe a view; its problems follow.",
      'parts[0] (table "recent"): columns[0].key is missing.',
      'parts[1] (sparkle): type is "sparkle"; it must be one of heading, text, stat, table, list, chart, log, form, button, tabs, code, badge, empty.',
      'parts[2] (table "long"): columns[0].hint is 201 characters; at most 200.',
      'parts[2] (table "long"): rowAction.label is 41 characters; at most 40.',
      'parts[3] (stat "Lines"): hint is ""; it must be text.',
    ]);
    // The file is stored beside the modules, at the address the manifest names.
    expect(bundle.codeModules.map(({ path }) => path)).toContain(
      "views/dashboard.json",
    );
  });

  it("serves a page's view, its state, ctx.views.set from plugin code, and the refusals", async () => {
    const owner = await signUp();
    const shared = await sharedThread();
    const installId = await install(
      { scope: "personal", id: shared.owner.userId },
      shared.owner.userId,
      files("logwatch", [
        {
          id: "dashboard",
          title: "Dashboard",
          file: "views/dashboard.json",
          show: ["page", "panel"],
        },
      ]),
    );
    void owner;
    const { call } = shared.owner;

    const catalog = await data<{
      dataViews: ReadonlyArray<{
        view: string;
        installId: string;
        integrity: string;
      }>;
    }>(await call("/v1/plugins/views"));
    const entry = catalog.dataViews.find(({ view }) => view === "dashboard");
    expect(entry?.installId).toBe(installId);

    const definition = await call(
      `/v1/plugins/views/definitions/${installId}/${entry?.integrity}`,
    );
    expect(definition.status).toBe(200);
    expect(definition.headers.get("cache-control")).toContain("immutable");
    expect(await definition.json()).toEqual(dashboard);
    // A wrong address serves nothing.
    expect(
      (
        await call(
          `/v1/plugins/views/definitions/${installId}/${"0".repeat(64)}`,
        )
      ).status,
    ).toBe(404);

    // Before the plugin sets anything, the page draws the file's state.
    const before = await data<StateData>(
      await call("/v1/plugins/views/logwatch/data/dashboard/state"),
    );
    expect(before).toMatchObject({
      state: null,
      version: 0,
      key: `${installId}/dashboard`,
    });
    const claims = await verifyViewWatch(bindings, before.watch);
    expect(claims).toMatchObject({
      userId: shared.owner.userId,
      key: `${installId}/dashboard`,
    });

    // Plugin code sets state from a tool call (the function tier).
    const html = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const results = await record(
      shared.threadId,
      shared.owner.userId,
      "logwatch",
      [
        ["stats.errors", 3],
        ["rows.0", { message: html, level: "error" }],
        ["bad..path", 1],
        ["huge", "x".repeat(600 * 1024)],
      ],
    );
    expect(results["stats.errors"]).toEqual({ version: 1 });
    expect(results["rows.0"]).toEqual({ version: 2 });
    expect(results["bad..path"]?.error).toContain("is not a state path");
    expect(results.huge?.error).toContain("at most 524,288");
    const unknown = await record(
      shared.threadId,
      shared.owner.userId,
      "logwatch",
      [["x", 1]],
      "ghost",
    );
    expect(unknown.x?.error).toContain('has no view "ghost"');

    const after = await data<StateData>(
      await call("/v1/plugins/views/logwatch/data/dashboard/state"),
    );
    expect(after.version).toBe(2);
    // The file's initial state is kept, the HTML is the same text, and the
    // refused sets left nothing.
    expect(after.state).toEqual({
      stats: { errors: 3 },
      rows: [{ message: html, level: "error" }],
      note: "Waiting for events.",
    });

    // The page's call runs the exposed function as the person who clicked,
    // and stores its reply at `result`.
    const reply = await data<{ value: unknown; version: number }>(
      await call("/v1/plugins/views/logwatch/data/dashboard/call", {
        method: "POST",
        body: JSON.stringify({
          fn: "search",
          args: { query: "timeout" },
          result: "results",
        }),
      }),
    );
    expect(reply.value).toEqual({
      query: "timeout",
      caller: shared.owner.userId,
      hits: 2,
    });
    const searched = await data<StateData>(
      await call("/v1/plugins/views/logwatch/data/dashboard/state"),
    );
    expect(searched.state).toMatchObject({
      lastSearchBy: shared.owner.userId,
      results: { query: "timeout", hits: 2 },
    });
    // A function the manifest does not export is refused.
    const refused = await call(
      "/v1/plugins/views/logwatch/data/dashboard/call",
      {
        method: "POST",
        body: JSON.stringify({ fn: "record", args: {} }),
      },
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      data: { code: "PLUGIN_VIEW_CALL_REFUSED" },
    });

    // In the owner's shared Thread, a member who can write sees the view
    // and acts on it as the owner does, as themselves.
    const ui = await data<{
      dataViews: ReadonlyArray<{ view: string }>;
    }>(await shared.member.call(`/v1/threads/${shared.threadId}/plugin-ui`));
    expect(ui.dataViews).toEqual([
      expect.objectContaining({ view: "dashboard" }),
    ]);
    const memberState = await data<StateData>(
      await shared.member.call(
        `/v1/threads/${shared.threadId}/plugin-ui/views/logwatch/dashboard/state`,
      ),
    );
    expect(memberState.version).toBe(searched.version);
    const memberClick = () =>
      shared.member.call(
        `/v1/threads/${shared.threadId}/plugin-ui/views/logwatch/dashboard/call`,
        {
          method: "POST",
          body: JSON.stringify({ fn: "search", args: { query: "x" } }),
        },
      );
    const memberCall = await memberClick();
    expect(memberCall.status, await memberCall.clone().text()).toBe(200);

    // Someone who can only view the Thread acts on none: the Thread refuses
    // the write before the plugin is asked.
    await env.DB.prepare(
      "UPDATE threads SET workspace_access = 'view' WHERE id = ?",
    )
      .bind(shared.threadId)
      .run();
    const viewerCall = await memberClick();
    expect(viewerCall.status).toBe(403);
    expect(await viewerCall.json()).toMatchObject({
      data: { code: "THREAD_READ_ONLY" },
    });

    const rows = (await audit("logwatch")).results;
    expect(rows.map(({ target, outcome }) => ({ target, outcome }))).toEqual([
      { target: "dashboard.search", outcome: "success" },
      { target: "dashboard.record", outcome: "rejected" },
      { target: "dashboard.search", outcome: "success" },
    ]);
    expect(JSON.parse(rows[2]?.detail_json ?? "{}")).toMatchObject({
      actorUserId: shared.member.userId,
    });
  });

  it("runs a member's click on a workspace plugin as the member", async () => {
    const shared = await sharedThread();
    await install(
      { scope: "workspace", id: shared.workspaceId },
      shared.owner.userId,
      files("teamwatch", [
        {
          id: "dashboard",
          title: "Dashboard",
          file: "views/dashboard.json",
          show: ["panel"],
        },
      ]),
    );
    const reply = await data<{ value: { caller: string } }>(
      await shared.member.call(
        `/v1/threads/${shared.threadId}/plugin-ui/views/teamwatch/dashboard/call`,
        {
          method: "POST",
          body: JSON.stringify({ fn: "search", args: { query: "db" } }),
        },
      ),
    );
    expect(reply.value.caller).toBe(shared.member.userId);
    const rows = (await audit("teamwatch")).results;
    expect(JSON.parse(rows[0]?.detail_json ?? "{}")).toMatchObject({
      actorUserId: shared.member.userId,
    });
  });

  it("adds no D1 read to the Thread's plugin UI, and reads state and the file once each", async () => {
    const shared = await sharedThread();
    const measure = async (path: string) => {
      const counter = countD1Calls(env.DB);
      const response = await shared.owner.callWith(path, counter.db);
      expect(response.status, await response.clone().text()).toBe(200);
      return counter.calls.map(({ sql }) => sql.join(" ; "));
    };
    const pluginTables = (sql: ReadonlyArray<string>) =>
      sql.filter((line) => /trusted_plugin|plugin_view_state/.test(line));
    // The control: the same plugin without views, in another owner's
    // Thread; each measured warm (its worker already described).
    const control = await sharedThread();
    await install(
      { scope: "personal", id: control.owner.userId },
      control.owner.userId,
      files("plainwatch", []).map((entry) =>
        entry.name === "plugin.json"
          ? { ...entry, content: entry.content.replace(',"views":[]', "") }
          : entry,
      ),
    );
    const measureFor = async (who: typeof control, path: string) => {
      await who.owner.call(path);
      const counter = countD1Calls(env.DB);
      const response = await who.owner.callWith(path, counter.db);
      expect(response.status, await response.clone().text()).toBe(200);
      return counter.calls.map(({ sql }) => sql.join(" ; "));
    };
    const before = await measureFor(
      control,
      `/v1/threads/${control.threadId}/plugin-ui`,
    );
    const installId = await install(
      { scope: "personal", id: shared.owner.userId },
      shared.owner.userId,
      files("logwatch", [
        {
          id: "dashboard",
          title: "Dashboard",
          file: "views/dashboard.json",
          show: ["panel"],
        },
      ]),
    );
    const after = await measureFor(
      shared,
      `/v1/threads/${shared.threadId}/plugin-ui`,
    );
    // A plugin with views costs what any plugin with code costs: its views
    // come with the installs already read.
    expect(after.length).toBe(before.length);
    const ui = await data<{ dataViews: ReadonlyArray<{ integrity: string }> }>(
      await shared.owner.call(`/v1/threads/${shared.threadId}/plugin-ui`),
    );
    const state = pluginTables(
      await measure(
        `/v1/threads/${shared.threadId}/plugin-ui/views/logwatch/dashboard/state`,
      ),
    );
    expect(state).toHaveLength(2);
    expect(state[1]).toContain("FROM plugin_view_state");
    const file = pluginTables(
      await measure(
        `/v1/plugins/views/definitions/${installId}/${ui.dataViews[0]?.integrity}`,
      ),
    );
    expect(file).toEqual([expect.stringContaining("FROM trusted_plugin_file")]);
    console.log(
      JSON.stringify({
        event: "plugin_data_view_d1_calls",
        pluginUiWithoutViews: before.length,
        pluginUiWithViews: after.length,
        stateTotal: (
          await measure(
            `/v1/threads/${shared.threadId}/plugin-ui/views/logwatch/dashboard/state`,
          )
        ).length,
        statePluginReads: state.length,
        definitionPluginReads: file.length,
      }),
    );
  });

  it("starts a Thread of a view's app type, and a tool's result names the view as a card", async () => {
    const shared = await sharedThread();
    await install(
      { scope: "personal", id: shared.owner.userId },
      shared.owner.userId,
      files("logwatch", [
        {
          id: "dashboard",
          title: "Log Watch",
          file: "views/dashboard.json",
          show: ["page", "app", "card"],
        },
        {
          id: "panel-only",
          title: "Panel",
          file: "views/dashboard.json",
          show: ["panel"],
        },
      ]),
    );
    const catalog = await data<{
      threadTypes: ReadonlyArray<{ ref: string; chat: string; title: string }>;
    }>(await shared.owner.call("/v1/plugins/views"));
    expect(catalog.threadTypes).toEqual([
      expect.objectContaining({
        ref: "logwatch/dashboard",
        chat: "side",
        title: "Log Watch",
      }),
    ]);
    const create = (pluginThreadType: string) =>
      shared.owner.call("/v1/threads", {
        method: "POST",
        body: JSON.stringify({ title: "Logs", pluginThreadType }),
      });
    const created = await create("logwatch/dashboard");
    expect(created.status, await created.clone().text()).toBe(201);
    const roomId = ((await created.json()) as { data: { id: string } }).data.id;
    // A view that does not show as an app is no Thread type.
    expect((await create("logwatch/panel-only")).status).toBe(422);
    const ui = await data<{
      threadType?: { view?: string; chat?: string; available: boolean };
      dataViews: ReadonlyArray<{ view: string; show: ReadonlyArray<string> }>;
    }>(await shared.owner.call(`/v1/threads/${roomId}/plugin-ui`));
    expect(ui.threadType).toMatchObject({
      view: "dashboard",
      chat: "side",
      available: true,
    });

    await record(shared.threadId, shared.owner.userId, "logwatch", [
      ["stats.errors", 4],
    ]);
    const plugins = await resolveThreadCodePlugins(
      bindings,
      env.DB,
      shared.threadId,
    );
    const plugin = plugins.find(({ name }) => name === "logwatch");
    if (plugin === undefined) throw new Error("logwatch did not resolve.");
    expect(
      await callPluginTool(
        {
          db: env.DB,
          bindings,
          install: plugin,
          threadId: shared.threadId,
          ownerUserId: shared.owner.userId,
        },
        "summary",
        {},
      ),
    ).toEqual({ errors: 4, _meta: { "dev.dxcode/view": "dashboard" } });
  });
});
