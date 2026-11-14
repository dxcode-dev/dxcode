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
import { insertQuickAction } from "../../src/plugins/thread-ui/store.js";
import { readPluginBundle } from "../../src/settings/plugins/bundles/read-bundle.js";
import { PluginBundleRepositoryD1 } from "../../src/settings/plugins/bundles/repository-d1.js";
import { readZipArchive } from "../../src/settings/plugins/bundles/zip.js";
import { buildZip } from "../../src/settings/plugins/bundles/zip-fixture.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * A Contribute member and the owner's plugins in a shared Thread. A personal
 * install runs with its owner's secrets, network, and shell, so its
 * interactive calls are the owner's only; a workspace install was approved
 * for every member. Ways this could go wrong, each checked:
 *
 * - a member runs a personal install's command, or sends its pane a message;
 * - a member sees the personal install's commands or run-command buttons,
 *   or clicks one of those quick actions;
 * - a member's pane of a personal install looks usable (no ownerOnly flag);
 * - the owner loses their own command or pane;
 * - a member's call to a workspace install is refused;
 * - a member's call reaches the plugin as the owner (`ctx.caller`);
 * - a member's call is audited as the owner's alone (no `actorUserId`);
 * - a member reaches the owner's personal plugin through a workspace
 *   plugin's `ctx.plugins.call`, so it runs on the member's input with the
 *   owner's secrets and hosts; or the owner's own such call is refused.
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
  BETTER_AUTH_SECRET: "plugin-owner-only-secret-0000000000000",
} as unknown as Bindings;

/** A command and a pane that read the Thread (audited); the pane says who called. */
const code = `export default function (dx) {
  dx.registerCommand({
    id: "restart",
    title: "Restart service",
    run: async (ctx) => { await ctx.thread.info(); },
  });
  dx.registerPane({
    id: "board",
    title: "Board",
    html: "<p>board</p>",
    onMessage: async (message, ctx) => {
      await ctx.thread.info();
      return { caller: ctx.caller.userId };
    },
  });
}`;

let installs = 0;
const install = async (
  target: PluginTarget,
  userId: UserId,
  name: string,
  /** Manifest fields and code beyond the default command and pane. */
  extra: {
    readonly dxcode?: Record<string, unknown>;
    readonly code?: string;
  } = {},
) => {
  installs += 1;
  const bundle = await Effect.runPromise(
    readZipArchive(
      await buildZip([
        {
          name: "plugin.json",
          content: JSON.stringify({
            $schema:
              "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
            name,
            displayName: name,
            version: "1.0.0",
            description: "Test plugin.",
            extensions: {
              "dev.dxcode": {
                apiVersion: 1,
                entry: "dev.dxcode/index.js",
                permissions: {
                  events: [],
                  ui: ["pane", "quick-action"],
                  threads: ["read"],
                },
                ...extra.dxcode,
              },
            },
          }),
        },
        { name: "dev.dxcode/index.js", content: extra.code ?? code },
      ]),
      { maxArchiveBytes: 16 * 1024 * 1024, maxEntries: 1_000 },
    ).pipe(
      Effect.flatMap((archive) =>
        readPluginBundle(archive, { root: "", fallbackName: "fixture" }),
      ),
    ),
  );
  const id =
    `plg_00000000-0000-4000-8000-${String(2_400 + installs).padStart(12, "0")}` as PluginId;
  const now = "2026-11-13T12:00:00.000Z";
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
  const email = `plugin-owner-only-${signups}@example.test`;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `192.0.2.${signups + 120}`,
      },
      body: JSON.stringify({
        name: `Person ${signups}`,
        email,
        password: "plugin-owner-only-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const userId = (await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id")) as UserId;
  return { cookie, userId };
};

/** An owner's Thread shared with their workspace for Contribute. */
const sharedThread = async () => {
  const owner = await signUp();
  const member = await signUp();
  const n = String(2_400 + signups).padStart(12, "0");
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
  const workspaceId = `org_owner_only_${signups}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Acme', ?, 1)",
    ).bind(workspaceId, `acme-owner-only-${signups}`),
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
  const as =
    (cookie: string) =>
    (path: string, init: RequestInit = {}) =>
      app.request(
        `/v1/threads/${threadId}${path}`,
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
  return {
    threadId,
    workspaceId,
    owner: { ...owner, call: as(owner.cookie) },
    member: { ...member, call: as(member.cookie) },
  };
};

const ui = async (call: (path: string) => Promise<Response>) => {
  const response = await call("/plugin-ui");
  expect(response.status, await response.clone().text()).toBe(200);
  return (
    (await response.json()) as {
      data: {
        commands: { id: string }[];
        quickActions: { action: string; args: { command?: string } }[];
        panes: { plugin: string; pane: string; ownerOnly?: true }[];
      };
    }
  ).data;
};

const runCommand = (
  call: (path: string, init?: RequestInit) => Promise<Response>,
  command: string,
) =>
  call("/plugin-ui/commands", {
    method: "POST",
    body: JSON.stringify({ command }),
  });

const postPane = (
  call: (path: string, init?: RequestInit) => Promise<Response>,
  plugin: string,
) =>
  call(`/plugin-ui/panes/${plugin}/board/messages`, {
    method: "POST",
    body: JSON.stringify({ message: { click: true } }),
  });

/** The plugin's run-command quick action for its restart command. */
const addQuickAction = (threadId: string, pluginId: PluginId, name: string) =>
  insertQuickAction(env.DB, {
    threadId,
    pluginId,
    // As the host stores it: the display name, not the install's name.
    pluginName: `${name} (display)`,
    label: "Restart",
    action: "run-command",
    args: { command: "restart" },
  });

const quickCommands = (data: Awaited<ReturnType<typeof ui>>) =>
  data.quickActions
    .filter(({ action }) => action === "run-command")
    .map(({ args }) => args.command);

const notes = (threadId: string, pluginName: string) =>
  env.DB.prepare(
    `SELECT action, detail_json FROM plugin_audit
      WHERE thread_id = ? AND plugin_name = ? AND action = 'thread.read'
      ORDER BY created_at, id`,
  )
    .bind(threadId, pluginName)
    .all<{ action: string; detail_json: string }>();

describe("the owner's plugins in a shared Thread", () => {
  it("keeps a personal install's commands and pane messages for its owner", async () => {
    const shared = await sharedThread();
    const id = await install(
      { scope: "personal", id: shared.owner.userId } as PluginTarget,
      shared.owner.userId,
      "com.acme.mine",
    );
    const command = `${id}:restart`;
    await addQuickAction(shared.threadId, id, "com.acme.mine");

    // The owner sees and uses all three.
    const mine = await ui(shared.owner.call);
    expect(mine.commands.map(({ id: entry }) => entry)).toContain(command);
    expect(quickCommands(mine)).toEqual([command]);
    expect(
      mine.panes.find(({ plugin }) => plugin === "com.acme.mine"),
    ).not.toHaveProperty("ownerOnly");
    expect((await runCommand(shared.owner.call, command)).status).toBe(200);
    expect((await postPane(shared.owner.call, "com.acme.mine")).status).toBe(
      200,
    );
    // The quick action's click is the same command run.
    expect(
      (await runCommand(shared.owner.call, quickCommands(mine)[0] ?? ""))
        .status,
    ).toBe(200);

    // The member sees no command, a pane marked for the owner only, and is
    // refused both calls.
    const theirs = await ui(shared.member.call);
    expect(theirs.commands).toEqual([]);
    expect(quickCommands(theirs)).toEqual([]);
    expect(
      theirs.panes.find(({ plugin }) => plugin === "com.acme.mine")?.ownerOnly,
    ).toBe(true);
    const ran = await runCommand(shared.member.call, command);
    expect(ran.status).toBe(403);
    expect(await ran.json()).toMatchObject({
      data: { code: "PLUGIN_UI_OWNER_ONLY" },
    });
    const posted = await postPane(shared.member.call, "com.acme.mine");
    expect(posted.status).toBe(403);
    expect(await posted.json()).toMatchObject({
      data: { code: "PLUGIN_UI_OWNER_ONLY" },
    });

    // Only the owner's three calls reached the plugin.
    const rows = (await notes(shared.threadId, "com.acme.mine")).results;
    expect(rows).toHaveLength(3);
    for (const row of rows)
      expect(JSON.parse(row.detail_json ?? "{}")).not.toHaveProperty(
        "actorUserId",
      );
  });

  it("runs a workspace install for a member, as the member, and audits them as the actor", async () => {
    const shared = await sharedThread();
    const id = await install(
      { scope: "workspace", id: shared.workspaceId } as PluginTarget,
      shared.owner.userId,
      "com.acme.team",
    );
    const command = `${id}:restart`;
    await addQuickAction(shared.threadId, id, "com.acme.team");
    const theirs = await ui(shared.member.call);
    expect(theirs.commands.map(({ id: entry }) => entry)).toContain(command);
    expect(quickCommands(theirs)).toEqual([command]);
    expect(
      theirs.panes.find(({ plugin }) => plugin === "com.acme.team"),
    ).not.toHaveProperty("ownerOnly");

    expect((await runCommand(shared.member.call, command)).status).toBe(200);
    expect(
      (await runCommand(shared.member.call, quickCommands(theirs)[0] ?? ""))
        .status,
    ).toBe(200);
    const answered = await postPane(shared.member.call, "com.acme.team");
    expect(answered.status).toBe(200);
    // ctx.caller is the member who clicked, not the owner.
    expect(
      ((await answered.json()) as { data: { result: { caller: string } } }).data
        .result.caller,
    ).toBe(shared.member.userId);

    const rows = (await notes(shared.threadId, "com.acme.team")).results;
    expect(rows).toHaveLength(3);
    for (const row of rows)
      expect(JSON.parse(row.detail_json)).toMatchObject({
        actorUserId: shared.member.userId,
      });
  });

  it("refuses a member's call through a workspace plugin to the owner's personal plugin", async () => {
    const shared = await sharedThread();
    // The owner's personal plugin, exporting what runs with their secrets.
    await install(
      { scope: "personal", id: shared.owner.userId } as PluginTarget,
      shared.owner.userId,
      "com.acme.vault",
      {
        dxcode: {
          exports: [{ name: "read", description: "Reads the owner's vault." }],
        },
        code: `export default function (dx) {
  dx.expose({ read: async (_args, ctx) => ({ vault: "opened", caller: ctx.caller.userId }) });
}`,
      },
    );
    // A workspace plugin whose pane asks the owner's plugin.
    await install(
      { scope: "workspace", id: shared.workspaceId } as PluginTarget,
      shared.owner.userId,
      "com.acme.relay",
      {
        dxcode: {
          permissions: {
            events: [],
            ui: ["pane"],
            plugins: ["com.acme.vault"],
          },
        },
        code: `export default function (dx) {
  dx.registerPane({
    id: "board",
    title: "Board",
    html: "<p>relay</p>",
    onMessage: (_message, ctx) =>
      ctx.plugins.call("com.acme.vault", "read", {}).then(
        (value) => ({ ok: value }),
        (error) => ({ name: error.name, code: error.code }),
      ),
  });
}`,
      },
    );
    const result = async (response: Response) => {
      expect(response.status, await response.clone().text()).toBe(200);
      return (
        (await response.json()) as {
          data: { result: { ok?: unknown; name?: string; code?: string } };
        }
      ).data.result;
    };

    // The owner's own click reaches their plugin.
    expect(
      await result(await postPane(shared.owner.call, "com.acme.relay")),
    ).toEqual({ ok: { vault: "opened", caller: shared.owner.userId } });
    // The member's click is refused before the owner's plugin runs.
    expect(
      await result(await postPane(shared.member.call, "com.acme.relay")),
    ).toEqual({ name: "PluginCallRefused", code: "owner-only" });

    const rows = (
      await env.DB.prepare(
        `SELECT outcome, detail_json FROM plugin_audit
          WHERE thread_id = ? AND plugin_name = 'com.acme.relay'
            AND action = 'plugin.call' ORDER BY created_at, id`,
      )
        .bind(shared.threadId)
        .all<{ outcome: string; detail_json: string }>()
    ).results.map((row) => {
      const detail = JSON.parse(row.detail_json) as {
        code?: string;
        actorUserId?: string;
      };
      return [row.outcome, detail.code ?? null, detail.actorUserId ?? null];
    });
    expect(rows).toEqual([
      ["success", null, null],
      ["rejected", "owner-only", shared.member.userId],
    ]);
  });
});
