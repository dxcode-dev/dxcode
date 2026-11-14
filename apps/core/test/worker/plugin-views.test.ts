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
import {
  listOwnerCodePluginInstalls,
  resolveThreadCodePlugins,
} from "../../src/plugins/worker-host/resolve.js";
import { deliverCodePluginTrigger } from "../../src/plugins/worker-host/triggers.js";
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
import { createThreadTools } from "../../src/threads/agent-tools.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * Plugin views and calls, end to end through real Dynamic Workers and dx's HTTP routes: plugin
 * tabs, pages, Thread types, and plugin-to-plugin calls. What can go wrong,
 * and where each case is checked:
 *
 * Calls (`ctx.plugins.call`):
 * - a call succeeds without `permissions.plugins` naming the callee.
 * - a call reaches a plugin that is not installed, or is off.
 * - a call reaches a function the callee's manifest does not export.
 * - a lower-tier caller reaches a higher-tier callee.
 * - a call loops back into the chain (A → B → A), or chains forever.
 * - the callee runs with the caller's permissions, not its own.
 * - a call, allowed or refused, leaves no audit row.
 * - the refusal reaches the caller's code without its code.
 *
 * Tabs: a tab shows below the trusted tier; a tab its code did not
 * register shows; a tab shows in an archived Thread set to hide; a tab's
 * view or message route serves another plugin's view; a tab's code cannot
 * post to it live.
 *
 * Thread types: a Thread starts as a type its owner's plugins do not offer;
 * the type changes after creation; a Thread whose type's plugin is turned
 * off shows a blank or failing view instead of "unavailable".
 *
 * Pages: the catalog lists a page below the trusted tier, or another
 * person's; a page's view or message route serves a page nobody declared;
 * a page's `onMessage` gets a Thread it has none of.
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
  BETTER_AUTH_SECRET: "plugin-views-secret-00000000000000000",
  // A blank Thread's model routing: Workers AI serves the default mode.
  AI: { run: async () => ({}) },
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
} as unknown as Bindings;

const ROOM_HTML = "<!doctype html><title>Room</title><main id=room></main>";
const BOARD_HTML = "<!doctype html><title>Board</title><main id=board></main>";

/** An incident plugin: a room tab, a Thread type it draws, a page, and exports. */
const incidentCode = `
export default function (dx) {
  dx.registerView({
    id: "room",
    html: ${JSON.stringify(ROOM_HTML)},
    async onMessage(message, ctx) {
      if (message?.snapshot !== undefined) {
        // The tab's state for an archived Thread; incident has no pane grant.
        await ctx.panes.get("room").snapshot(message.snapshot);
        return { saved: true };
      }
      await ctx.panes.get("room").post({ ack: message });
      return { thread: ctx.thread?.id ?? null };
    },
  });
  dx.registerView({
    id: "board",
    html: ${JSON.stringify(BOARD_HTML)},
    async onMessage(message, ctx) {
      return { page: true, thread: ctx.thread === undefined ? null : ctx.thread.id, message };
    },
  });
  // Declared nowhere in the manifest: dx never serves it.
  dx.registerView({ id: "hidden", html: "<p>hidden</p>" });
  dx.expose({
    async status(args, ctx) {
      return {
        severity: "sev2",
        args,
        calledBy: ctx.calledBy?.plugin ?? null,
        // Its own grants: incident has no network permission.
        fetch: typeof ctx.fetch,
        setting: (await ctx.settings.get()).region ?? null,
      };
    },
    secret() { return "not exported"; },
  });
  dx.registerTool({
    name: "loop_back",
    description: "Calls deploy, which calls incident again.",
    execute: async (_input, ctx) => ctx.plugins.call("deploy", "ping", {}).catch((error) => ({ name: error.name, code: error.code, message: error.message })),
  });
}
`;

const deployCode = `
export default function (dx) {
  const attempt = (ctx, plugin, fn, args) =>
    ctx.plugins.call(plugin, fn, args).then(
      (value) => ({ ok: value }),
      (error) => ({ name: error.name, code: error.code, message: error.message }),
    );
  dx.expose({
    async ping(_args, ctx) {
      return attempt(ctx, "incident", "status", { from: "ping" });
    },
  });
  dx.registerTool({
    name: "deploy",
    description: "Deploys, asking other plugins first.",
    async execute(_input, ctx) {
      return {
        allowed: await attempt(ctx, "incident", "status", { service: "api" }),
        notExported: await attempt(ctx, "incident", "secret", {}),
        notPermitted: await attempt(ctx, "secrets", "get", {}),
        notInstalled: await attempt(ctx, "ghost", "run", {}),
        lowerTier: await attempt(ctx, "cloud", "provision", {}),
        hasFetch: typeof ctx.fetch,
      };
    },
  });
}
`;

const cloudCode = `
export default function (dx) {
  dx.expose({ provision: () => ({ provisioned: true }) });
}
`;

const manifest = (
  name: string,
  dxcode: Record<string, unknown>,
): ReadonlyArray<FixtureEntry> => [
  {
    name: "plugin.json",
    content: JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
      name,
      displayName: `${name[0]?.toUpperCase()}${name.slice(1)}`,
      version: "1.0.0",
      description: "Test plugin.",
      extensions: {
        "dev.dxcode": {
          apiVersion: 1,
          entry: "dev.dxcode/index.js",
          ...dxcode,
        },
      },
    }),
  },
];

const incidentFiles = (extra: Record<string, unknown> = {}) => [
  ...manifest("incident", {
    permissions: {
      events: [],
      network: ["status.example.com"],
      plugins: ["deploy"],
    },
    settings: [{ key: "region", label: "Region", default: "eu" }],
    views: {
      tabs: [{ id: "room", title: "Incident room", icon: "lucide:siren" }],
      pages: [{ id: "board", title: "Incidents", path: "/open" }],
      threadTypes: [
        {
          id: "room",
          title: "Incident room",
          icon: "lucide:siren",
          view: "room",
          chat: "side",
        },
      ],
    },
    exports: [{ name: "status", description: "The incident's status." }],
    ...extra,
  }),
  { name: "dev.dxcode/index.js", content: incidentCode },
];

const deployFiles = (extra: Record<string, unknown> = {}) => [
  ...manifest("deploy", {
    permissions: {
      events: [],
      plugins: ["incident", "cloud", "ghost"],
    },
    exports: [{ name: "ping", description: "Pings incident." }],
    ...extra,
  }),
  { name: "dev.dxcode/index.js", content: deployCode },
];

const cloudFiles = () => [
  ...manifest("cloud", {
    permissions: { events: [] },
    exports: [{ name: "provision", description: "Provisions." }],
  }),
  { name: "dev.dxcode/index.js", content: cloudCode },
];

let installs = 0;
const install = async (
  target: PluginTarget,
  userId: UserId,
  entries: ReadonlyArray<FixtureEntry>,
) => {
  installs += 1;
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
  expect(bundle.manifest.skipped).toEqual([]);
  const id =
    `plg_00000000-0000-4000-8000-${String(1_500 + installs).padStart(12, "0")}` as PluginId;
  const now = "2026-11-12T12:00:00.000Z";
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
/** A signed-in person with a Project, a Thread, and a workspace. */
const person = async (ownWorkspace = true) => {
  signups += 1;
  const email = `plugin-views-${signups}@example.test`;
  const signedUp = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `198.51.100.${signups + 40}`,
      },
      body: JSON.stringify({
        name: "Views Owner",
        email,
        password: "plugin-views-password-123",
      }),
    },
    bindings,
  );
  expect(signedUp.status).toBe(200);
  const cookie = signedUp.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const userId = (await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id")) as UserId;
  const suffix = String(1_500 + signups).padStart(12, "0");
  const ownProject = project(
    `prj_00000000-0000-4000-8000-${suffix}`,
    userId,
    "Views",
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
  const workspaceId = `org_plugin_views_${signups}`;
  if (ownWorkspace)
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Acme', ?, 1)",
      ).bind(workspaceId, `acme-views-${signups}`),
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', 1)",
      ).bind(`${workspaceId}-1`, workspaceId, userId),
    ]);
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
          ...(init.headers as Record<string, string> | undefined),
        },
      },
      bindings,
    );
  return {
    userId,
    projectId: ownProject.id,
    threadId: ownThread.id as string,
    workspaceId,
    call,
    personal: { scope: "personal", id: userId } as PluginTarget,
    workspace: { scope: "workspace", id: workspaceId } as PluginTarget,
  };
};

const json = async <T>(response: Response) => {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
};

const dependenciesOf = async (
  threadId: string,
  userId: UserId,
  name: string,
) => {
  const plugins = await resolveThreadCodePlugins(bindings, env.DB, threadId);
  const install = plugins.find((plugin) => plugin.name === name);
  if (install === undefined) throw new Error(`${name} did not resolve.`);
  return { db: env.DB, bindings, install, threadId, ownerUserId: userId };
};

const callAudit = (pluginName: string) =>
  env.DB.prepare(
    `SELECT target, outcome, detail_json FROM plugin_audit
      WHERE plugin_name = ? AND action = 'plugin.call' ORDER BY created_at, id`,
  )
    .bind(pluginName)
    .all<{ target: string; outcome: string; detail_json: string }>();

describe("plugin-to-plugin calls", () => {
  it("calls an exported function through dx, and refuses each blocked case with an audit row", async () => {
    const owner = await person();
    await install(owner.personal, owner.userId, incidentFiles());
    await install(owner.personal, owner.userId, deployFiles());
    // A workspace install runs at a higher tier than a personal one.
    await install(owner.workspace, owner.userId, cloudFiles());

    const result = (await callPluginTool(
      await dependenciesOf(owner.threadId, owner.userId, "deploy"),
      "deploy",
      {},
    )) as Record<
      string,
      { ok?: unknown; name?: string; code?: string; message?: string }
    >;

    // Allowed: incident runs with its own grants and settings, and learns
    // who called it.
    expect(result.allowed?.ok).toEqual({
      severity: "sev2",
      args: { service: "api" },
      calledBy: "deploy",
      fetch: "function",
      setting: "eu",
    });
    // deploy itself has no network grant.
    expect(result.hasFetch).toBe("undefined");
    expect(result.notExported).toMatchObject({
      name: "PluginCallRefused",
      code: "not-exported",
    });
    expect(result.notPermitted).toMatchObject({
      name: "PluginCallRefused",
      code: "not-permitted",
    });
    expect(result.notInstalled).toMatchObject({
      name: "PluginCallRefused",
      code: "not-installed",
    });
    expect(result.lowerTier).toMatchObject({
      name: "PluginCallRefused",
      code: "lower-tier",
    });
    expect(result.lowerTier?.message).toContain("workspace-trusted");

    const rows = (await callAudit("deploy")).results.map((row) => [
      row.target,
      row.outcome,
      (JSON.parse(row.detail_json) as { code?: string }).code ?? null,
    ]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ["incident.status", "success", null],
        ["incident.secret", "rejected", "not-exported"],
        ["secrets.get", "rejected", "not-permitted"],
        ["ghost.run", "rejected", "not-installed"],
        ["cloud.provision", "rejected", "lower-tier"],
      ]),
    );
  });

  it("refuses a call that loops back into its own chain", async () => {
    const owner = await person();
    await install(owner.personal, owner.userId, incidentFiles());
    await install(owner.personal, owner.userId, deployFiles());
    // incident → deploy.ping → incident.status: incident is already in the chain.
    const looped = (await callPluginTool(
      await dependenciesOf(owner.threadId, owner.userId, "incident"),
      "loop_back",
      {},
    )) as { code?: string; name?: string };
    // deploy.ping catches the refusal and hands it back as its answer.
    expect(looped).toMatchObject({
      name: "PluginCallRefused",
      code: "cycle",
    });
    const rows = (await callAudit("deploy")).results;
    expect(
      rows.some(
        (row) =>
          row.target === "incident.status" &&
          row.outcome === "rejected" &&
          row.detail_json.includes('"cycle"'),
      ),
    ).toBe(true);
  });

  it("refuses a caller whose requested tier is lower than the callee's", async () => {
    const owner = await person();
    await install(owner.personal, owner.userId, incidentFiles());
    await install(
      owner.personal,
      owner.userId,
      deployFiles({ tier: "sandboxed" }),
    );
    const result = (await callPluginTool(
      await dependenciesOf(owner.threadId, owner.userId, "deploy"),
      "deploy",
      {},
    )) as Record<string, { code?: string }>;
    expect(result.allowed).toMatchObject({ code: "lower-tier" });
  });
});

describe("plugin tabs and Thread types", () => {
  it("lists a trusted plugin's tab, serves its view, and answers and posts to it", async () => {
    const owner = await person();
    await install(owner.personal, owner.userId, incidentFiles());
    const ui = await json<{
      tabs: ReadonlyArray<Record<string, unknown>>;
      panes: ReadonlyArray<unknown>;
    }>(await owner.call(`/v1/threads/${owner.threadId}/plugin-ui`));
    expect(ui.tabs).toEqual([
      {
        plugin: "incident",
        tab: "room",
        title: "Incident room",
        pluginTitle: "Incident",
        version: expect.any(String),
        icon: "lucide:siren",
      },
    ]);
    expect(ui.panes).toEqual([]);
    const base = `/v1/threads/${owner.threadId}/plugin-ui/panes/incident`;
    expect(
      (await json<{ html: string }>(await owner.call(`${base}/room`))).html,
    ).toBe(ROOM_HTML);
    // A view no tab declares, and a page's view, are not tabs.
    expect((await owner.call(`${base}/hidden`)).status).toBe(404);
    expect((await owner.call(`${base}/board`)).status).toBe(404);
    const answered = await json<{ result: unknown }>(
      await owner.call(`${base}/room/messages`, {
        method: "POST",
        body: JSON.stringify({ message: { ack: 1 } }),
      }),
    );
    expect(answered.result).toEqual({ thread: owner.threadId });
    const { messages } = await json<{
      messages: ReadonlyArray<{ message: unknown }>;
    }>(await owner.call(`${base}/room/messages`));
    expect(messages.map(({ message }) => message)).toEqual([
      { ack: { ack: 1 } },
    ]);
  });

  it("lets a Thread tab save the snapshot an archived Thread shows, with no pane grant", async () => {
    const owner = await person();
    await install(
      owner.personal,
      owner.userId,
      incidentFiles({ archivedThreads: "show" }),
    );
    const base = `/v1/threads/${owner.threadId}/plugin-ui/panes/incident/room`;
    const saved = await owner.call(`${base}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: { snapshot: { open: 2 } } }),
    });
    expect(saved.status).toBe(200);
    expect((await json<{ result: unknown }>(saved)).result).toEqual({
      saved: true,
    });
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(owner.threadId)
      .run();
    const { messages } = await json<{
      messages: ReadonlyArray<{ message: unknown }>;
    }>(await owner.call(`${base}/messages`));
    expect(messages.map(({ message }) => message)).toEqual([{ open: 2 }]);
  });

  it("starts a Thread as a plugin type, keeps it, and falls back to a chat when the plugin is off", async () => {
    const owner = await person();
    const pluginId = await install(
      owner.personal,
      owner.userId,
      incidentFiles(),
    );
    const refused = await owner.call("/v1/threads", {
      method: "POST",
      body: JSON.stringify({
        projectId: owner.projectId,
        title: "Nope",
        pluginThreadType: "incident/war-room",
      }),
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      data: { code: "PLUGIN_THREAD_TYPE_UNAVAILABLE" },
    });
    const created = await owner.call("/v1/threads", {
      method: "POST",
      body: JSON.stringify({
        projectId: owner.projectId,
        title: "API outage",
        pluginThreadType: "incident/room",
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = ((await created.json()) as { data: { id: string } }).data;
    const detail = await json<{ pluginThreadType?: string }>(
      await owner.call(`/v1/threads/${id}`),
    );
    expect(detail.pluginThreadType).toBe("incident/room");
    const typed = await json<{ threadType?: Record<string, unknown> }>(
      await owner.call(`/v1/threads/${id}/plugin-ui`),
    );
    expect(typed.threadType).toEqual({
      ref: "incident/room",
      plugin: "incident",
      type: "room",
      title: "Incident room",
      pluginTitle: "Incident",
      icon: "lucide:siren",
      view: "room",
      chat: "side",
      available: true,
    });
    // Archived and hidden: the tab and the type's view go away.
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(id)
      .run();
    const archived = await json<{
      tabs: ReadonlyArray<unknown>;
      threadType?: { available: boolean };
    }>(await owner.call(`/v1/threads/${id}/plugin-ui`));
    expect(archived.tabs).toEqual([]);
    expect(archived.threadType?.available).toBe(false);
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'active' WHERE id = ?",
    )
      .bind(id)
      .run();
    // Turned off: the Thread keeps its type and opens as a chat.
    await env.DB.prepare("UPDATE trusted_plugin SET enabled = 0 WHERE id = ?")
      .bind(pluginId)
      .run();
    const off = await json<{
      tabs: ReadonlyArray<unknown>;
      threadType?: Record<string, unknown>;
    }>(await owner.call(`/v1/threads/${id}/plugin-ui`));
    expect(off.tabs).toEqual([]);
    expect(off.threadType).toEqual({
      ref: "incident/room",
      plugin: "incident",
      type: "room",
      title: "Room",
      available: false,
    });
    expect(
      (
        await json<{ pluginThreadType?: string }>(
          await owner.call(`/v1/threads/${id}`),
        )
      ).pluginThreadType,
    ).toBe("incident/room");
  });

  it("shows a personal install's tab and Thread type only to its owner; a workspace member gets a chat", async () => {
    const owner = await person();
    const member = await person(false);
    await install(owner.personal, owner.userId, incidentFiles());
    const created = await owner.call("/v1/threads", {
      method: "POST",
      body: JSON.stringify({
        projectId: owner.projectId,
        title: "Shared room",
        pluginThreadType: "incident/room",
      }),
    });
    expect(created.status).toBe(201);
    const { id } = ((await created.json()) as { data: { id: string } }).data;
    // The member joins the owner's workspace, and the owner shares the
    // Project and the Thread with it.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', 1)",
      ).bind(`${owner.workspaceId}-2`, owner.workspaceId, member.userId),
      env.DB.prepare("UPDATE projects SET workspace_id = ? WHERE id = ?").bind(
        owner.workspaceId,
        owner.projectId,
      ),
      env.DB.prepare(
        "UPDATE threads SET workspace_access = 'view', shared_workspace_id = ? WHERE id = ?",
      ).bind(owner.workspaceId, id),
    ]);
    const mine = await json<{
      tabs: ReadonlyArray<unknown>;
      threadType?: { available: boolean };
    }>(await owner.call(`/v1/threads/${id}/plugin-ui`));
    expect(mine.tabs).toHaveLength(1);
    expect(mine.threadType?.available).toBe(true);
    const theirs = await json<{
      tabs: ReadonlyArray<unknown>;
      threadType?: { available: boolean };
    }>(await member.call(`/v1/threads/${id}/plugin-ui`));
    expect(theirs.tabs).toEqual([]);
    expect(theirs.threadType?.available).toBe(false);
    expect(
      (await member.call(`/v1/threads/${id}/plugin-ui/panes/incident/room`))
        .status,
    ).toBe(404);
  });

  it("drops tabs, pages, and Thread types below the trusted tier", async () => {
    const owner = await person();
    await install(
      owner.personal,
      owner.userId,
      incidentFiles({ tier: "sandboxed" }),
    );
    const ui = await json<{ tabs: ReadonlyArray<unknown> }>(
      await owner.call(`/v1/threads/${owner.threadId}/plugin-ui`),
    );
    expect(ui.tabs).toEqual([]);
    expect(
      (
        await owner.call(
          `/v1/threads/${owner.threadId}/plugin-ui/panes/incident/room`,
        )
      ).status,
    ).toBe(404);
    const catalog = await json<{
      pages: ReadonlyArray<unknown>;
      threadTypes: ReadonlyArray<unknown>;
    }>(await owner.call("/v1/plugins/views"));
    expect(catalog).toEqual({ pages: [], threadTypes: [] });
    expect(
      (await owner.call("/v1/plugins/views/incident/pages/board")).status,
    ).toBe(404);
    const refused = await owner.call("/v1/threads", {
      method: "POST",
      body: JSON.stringify({
        projectId: owner.projectId,
        title: "Room",
        pluginThreadType: "incident/room",
      }),
    });
    expect(refused.status).toBe(422);
  });
});

describe("plugin pages", () => {
  it("lists the person's pages and Thread types, serves a page, and answers it with no Thread", async () => {
    const owner = await person();
    const other = await person();
    await install(owner.personal, owner.userId, incidentFiles());
    const catalogResponse = await owner.call("/v1/plugins/views");
    expect(catalogResponse.headers.get("cache-control")).toBe(
      "private, max-age=60",
    );
    const etag = catalogResponse.headers.get("etag");
    expect(await json(catalogResponse)).toEqual({
      pages: [
        {
          plugin: "incident",
          page: "board",
          title: "Incidents",
          pluginTitle: "Incident",
          path: "/open",
        },
      ],
      threadTypes: [
        {
          ref: "incident/room",
          plugin: "incident",
          type: "room",
          title: "Incident room",
          pluginTitle: "Incident",
          chat: "side",
          icon: "lucide:siren",
        },
      ],
    });
    // Unchanged: 304, with no body.
    expect(etag).not.toBeNull();
    const again = await owner.call("/v1/plugins/views", {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(again.status).toBe(304);
    // Another person sees none of it.
    expect(await json(await other.call("/v1/plugins/views"))).toEqual({
      pages: [],
      threadTypes: [],
    });
    expect(
      (await other.call("/v1/plugins/views/incident/pages/board")).status,
    ).toBe(404);

    const view = await json<{
      html: string;
      title: string;
      handlesMessages: boolean;
    }>(await owner.call("/v1/plugins/views/incident/pages/board"));
    expect(view).toMatchObject({
      html: BOARD_HTML,
      title: "Incidents",
      handlesMessages: true,
    });
    // A tab's view is not a page.
    expect(
      (await owner.call("/v1/plugins/views/incident/pages/room")).status,
    ).toBe(404);
    const answered = await json<{ result: unknown }>(
      await owner.call("/v1/plugins/views/incident/pages/board/messages", {
        method: "POST",
        body: JSON.stringify({ message: { refresh: true } }),
      }),
    );
    expect(answered.result).toEqual({
      page: true,
      thread: null,
      message: { refresh: true },
    });
    const audit = await env.DB.prepare(
      "SELECT count(*) AS n FROM plugin_audit WHERE plugin_name = 'incident' AND action = 'page.message' AND owner_user_id = ?",
    )
      .bind(owner.userId)
      .first<number>("n");
    expect(audit).toBe(1);
  });
});

/**
 * A Thread title is at most 80 characters. Ways a long one could still fail
 * creation, each checked: a plugin's `ctx.threads.create({ title })` passes
 * it through as given; the agent's `create_thread` tool does the same.
 */
describe("long Thread titles", () => {
  const LONG_TITLE =
    `Incident ${"checkout latency spike in eu-west ".repeat(6)}`.slice(0, 200);
  const titleOf = (threadId: string) =>
    env.DB.prepare("SELECT title FROM threads WHERE id = ?")
      .bind(threadId)
      .first<string>("title");

  it("shortens a plugin page's ctx.threads.create title instead of failing", async () => {
    const owner = await person();
    await install(owner.personal, owner.userId, [
      ...manifest("titles", {
        permissions: { events: [], threads: ["create"] },
        views: { pages: [{ id: "start", title: "Start", path: "/" }] },
      }),
      {
        name: "dev.dxcode/index.js",
        content: `export default function (dx) {
  dx.registerView({
    id: "start",
    html: "<p>start</p>",
    onMessage: (message, ctx) => ctx.threads.create({ prompt: "Long title check.", title: message.title }),
  });
}`,
      },
    ]);
    expect(LONG_TITLE.length).toBe(200);
    const answered = await json<{ result: { threadId: string } }>(
      await owner.call("/v1/plugins/views/titles/pages/start/messages", {
        method: "POST",
        body: JSON.stringify({ message: { title: LONG_TITLE } }),
      }),
    );
    const title = await titleOf(answered.result.threadId);
    expect(title?.length).toBeLessThanOrEqual(80);
    expect(title?.endsWith("…")).toBe(true);
    expect(LONG_TITLE.startsWith(title?.slice(0, -1).trimEnd() ?? "x")).toBe(
      true,
    );
  });

  it("shortens the agent's create_thread title instead of failing", async () => {
    const owner = await person();
    // The calling Thread, made as a person makes one.
    const parent = await owner.call("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Parent" }),
    });
    expect(parent.status, await parent.clone().text()).toBe(201);
    const parentId = ((await parent.json()) as { data: { id: string } }).data
      .id;
    const kept: Array<Promise<unknown>> = [];
    const tools = Object.fromEntries(
      createThreadTools(
        parentId as never,
        () => ({
          db: env.DB,
          bindings,
          waitUntil: (promise: Promise<unknown>) => {
            kept.push(promise.catch(() => undefined));
          },
        }),
        "sub_long_title",
      ).map((tool) => [
        tool.name,
        tool as unknown as {
          run: (input: {
            data: Record<string, unknown>;
            toolCallId: string;
          }) => Promise<{ output: Record<string, unknown> }>;
        },
      ]),
    );
    const created = await tools.create_thread?.run({
      data: { prompt: "Long title check.", title: LONG_TITLE },
      toolCallId: "long-title",
    });
    const childId = created?.output.threadId as string;
    expect(childId).toMatch(/^thr_/);
    const title = await titleOf(childId);
    expect(title?.length).toBeLessThanOrEqual(80);
    expect(title?.endsWith("…")).toBe(true);
    await Promise.all(kept);
  });
});

describe("host review items", () => {
  it("starts one Thread for a webhook delivery that is retried after it started it", async () => {
    const owner = await person();
    await install(owner.personal, owner.userId, [
      ...manifest("pager", {
        permissions: { events: ["trigger.received"], threads: ["create"] },
      }),
      {
        name: "dev.dxcode/index.js",
        // Starts two Threads, then fails, as a handler whose later step
        // throws: the trigger service retries the whole delivery.
        content: `export default function (dx) {
  dx.on("trigger.received", async (event, ctx) => {
    await ctx.threads.create({ prompt: "Page " + event.deliveryId, title: "Page one " + event.deliveryId });
    await ctx.threads.create({ prompt: "Page " + event.deliveryId, title: "Page two " + event.deliveryId });
    if (event.data.fail) throw new Error("the pager's API timed out");
  });
}`,
      },
    ]);
    const pager = (
      await listOwnerCodePluginInstalls(env.DB, owner.userId)
    ).find(({ name }) => name === "pager");
    if (pager === undefined) throw new Error("pager did not resolve.");
    const deliver = (deliveryId: string, attempt: number, fail: boolean) =>
      deliverCodePluginTrigger(bindings, env.DB, {
        install: pager,
        ownerUserId: owner.userId,
        triggerId: "trg_pager",
        deliveryId,
        eventId: `evt_${deliveryId}`,
        idempotencyKey: `key_${deliveryId}`,
        attempt,
        payload: { fail },
      });
    const started = (deliveryId: string) =>
      env.DB.prepare(
        "SELECT id, title FROM threads WHERE owner_user_id = ? AND title LIKE ? ORDER BY title",
      )
        .bind(owner.userId, `% ${deliveryId}`)
        .all<{ id: string; title: string }>();

    // Two failed attempts and the one that succeeds start each Thread once.
    await expect(deliver("dlv_retried", 1, true)).rejects.toThrow("timed out");
    await expect(deliver("dlv_retried", 2, true)).rejects.toThrow("timed out");
    await deliver("dlv_retried", 3, false);
    const once = (await started("dlv_retried")).results;
    expect(once.map(({ title }) => title)).toEqual([
      "Page one dlv_retried",
      "Page two dlv_retried",
    ]);
    // Another delivery starts its own.
    await deliver("dlv_other", 1, false);
    const other = (await started("dlv_other")).results;
    expect(other).toHaveLength(2);
    expect(other.map(({ id }) => id)).not.toContain(once[0]?.id);
  });

  it("refunds a wake whose message is not posted, so it spends none of the hour's wakes", async () => {
    const owner = await person();
    await install(owner.personal, owner.userId, [
      ...manifest("waker", {
        permissions: { events: [], wake: true },
      }),
      {
        name: "dev.dxcode/index.js",
        content: `export default function (dx) {
  dx.registerTool({
    name: "wake",
    description: "Wakes the Thread.",
    execute: async (input, ctx) => ctx.wake(input.threadId, "Wake up.").then(
      () => "woke",
      (error) => error.message,
    ),
  });
}`,
      },
    ]);
    const dependencies = await dependenciesOf(
      owner.threadId,
      owner.userId,
      "waker",
    );
    // Seven tries, more than the hour's six: none reaches the Thread.
    const answers: unknown[] = [];
    for (let tries = 0; tries < 7; tries += 1)
      answers.push(
        await callPluginTool(dependencies, "wake", {
          threadId: owner.threadId,
        }),
      );
    expect(answers.filter((answer) => answer === "woke")).toEqual([]);
    expect(
      answers.filter((answer) => String(answer).includes("times an hour")),
    ).toEqual([]);
    const rows = (
      await env.DB.prepare(
        `SELECT id, outcome, detail_json FROM plugin_audit
          WHERE plugin_name = 'waker' AND action = 'thread.wake'`,
      ).all<{ id: string; outcome: string; detail_json: string }>()
    ).results;
    // Each try: the wake's row, and a failed row that refunds it.
    const woke = rows.filter(({ outcome }) => outcome === "success");
    const refunded = rows
      .filter(({ outcome }) => outcome === "failed")
      .map(
        ({ detail_json }) =>
          (JSON.parse(detail_json) as { refunds?: string }).refunds,
      );
    expect(woke).toHaveLength(7);
    expect(refunded.sort()).toEqual(woke.map(({ id }) => id).sort());
    expect(rows).toHaveLength(14);
  });
});
