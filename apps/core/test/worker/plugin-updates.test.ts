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
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import {
  type CodePluginRuntime,
  createPluginTools,
} from "../../src/plugins/worker-host/agent.js";
import { resolveThreadCodePlugins } from "../../src/plugins/worker-host/resolve.js";
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
 * Updating an installed plugin (plugin plan §7, M5). What can go wrong:
 *
 * - an update quietly widens what the code may reach: the preview must list
 *   every added and removed grant, and a widening update must be refused
 *   until the person accepts it, while a narrowing one goes through at once.
 * - the "update available" notice lies: it must name only plugins whose
 *   folder changed at their source, and say nothing when GitHub can't answer.
 * - an update leaks across installs or members: a workspace update must
 *   reach every member's next submission, and a call that already resolved
 *   its plugins must finish on the version it started with.
 */

const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  LOADER: (env as unknown as { LOADER: WorkerLoader }).LOADER,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "plugin-update-route-secret-0000000000",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
} as Bindings;
const endpoint = "/v1/settings/personal/plugin-bundles";

let signups = 120;
const signup = async (email: string) => {
  signups += 1;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `203.0.113.${signups}`,
      },
      body: JSON.stringify({
        name: "Update Owner",
        email,
        password: "plugin-update-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Expected session cookie.");
  const { user } = await response.json<{ user: { id: string } }>();
  return { cookie, userId: user.id as UserId };
};

const call = (
  path: string,
  cookie: string,
  init: { method?: string; json?: unknown; zip?: Uint8Array } = {},
) =>
  app.request(
    path,
    {
      method: init.method ?? ((init.json ?? init.zip) ? "POST" : "GET"),
      headers: {
        cookie,
        origin,
        ...(init.json === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(init.zip === undefined
          ? {}
          : { "content-type": "application/zip" }),
      },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      ...(init.zip === undefined ? {} : { body: init.zip.slice() }),
    },
    bindings,
  );

const codePlugin = (
  permissions: Record<string, unknown>,
  options: {
    readonly prefix?: string;
    readonly version?: string;
    readonly settings?: ReadonlyArray<unknown>;
    readonly tool?: string;
  } = {},
): ReadonlyArray<FixtureEntry> => [
  {
    name: `${options.prefix ?? ""}plugin.json`,
    content: JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
      name: "com.acme.updater",
      displayName: "Updater",
      version: options.version ?? "1.0.0",
      description: "A plugin that changes between versions.",
      extensions: {
        "dev.dxcode": {
          apiVersion: 1,
          entry: "dev.dxcode/index.js",
          permissions,
          ...(options.settings === undefined
            ? {}
            : { settings: options.settings }),
        },
      },
    }),
  },
  {
    name: `${options.prefix ?? ""}dev.dxcode/index.js`,
    content: `export default (dx) => dx.registerTool({ name: "which_version", description: "Says its version.", execute: () => ${JSON.stringify(options.tool ?? options.version ?? "1.0.0")} });`,
  },
];

interface UpdatePreviewBody {
  readonly data: {
    readonly integrity: string;
    readonly upToDate: boolean;
    readonly permissions: {
      readonly widens: boolean;
      readonly changes: ReadonlyArray<{
        readonly permission: string;
        readonly added: ReadonlyArray<string>;
        readonly removed: ReadonlyArray<string>;
      }>;
    };
  };
}

const installZip = async (cookie: string, archive: Uint8Array) => {
  const preview = await call(`${endpoint}/preview?name=u.zip`, cookie, {
    zip: archive,
  });
  expect(preview.status).toBe(200);
  const reviewed = await preview.json<{ data: { integrity: string } }>();
  const installed = await call(
    `${endpoint}?name=u.zip&integrity=${reviewed.data.integrity}`,
    cookie,
    { zip: archive },
  );
  expect(installed.status).toBe(201);
  return (await installed.json<{ data: { id: string } }>()).data.id;
};

describe("plugin updates", () => {
  it("lists what an update changes in the code's permissions, and needs acceptance only when they widen", async () => {
    const { cookie } = await signup("plugin-update-permissions@example.com");
    const id = await installZip(
      cookie,
      await buildZip(
        codePlugin(
          {
            events: ["tool.call"],
            network: ["api.example.com"],
            secrets: ["OLD_TOKEN"],
          },
          {
            settings: [{ key: "team", label: "Team", type: "string" }],
          },
        ),
      ),
    );
    const updates = `${endpoint}/${id}/update`;

    // 1.1.0 adds a host, model calls, and a required setting, and drops a
    // secret.
    const wider = await buildZip(
      codePlugin(
        {
          events: ["tool.call"],
          network: ["api.example.com", "api.other.com"],
          ai: true,
        },
        {
          version: "1.1.0",
          settings: [
            { key: "team", label: "Team", type: "string" },
            { key: "region", label: "Region", type: "string", required: true },
          ],
        },
      ),
    );
    const preview = await call(`${updates}/preview?name=u2.zip`, cookie, {
      zip: wider,
    });
    expect(preview.status).toBe(200);
    const reviewed = await preview.json<UpdatePreviewBody>();
    expect(reviewed.data.permissions.widens).toBe(true);
    expect(reviewed.data.permissions.changes).toEqual([
      { permission: "network", added: ["api.other.com"], removed: [] },
      { permission: "secrets", added: [], removed: ["OLD_TOKEN"] },
      { permission: "ai", added: ["model calls"], removed: [] },
      { permission: "settings", added: ["Region"], removed: [] },
    ]);

    // Without accepting the wider grants, nothing changes.
    const refused = await call(
      `${updates}?name=u2.zip&integrity=${reviewed.data.integrity}`,
      cookie,
      { zip: wider },
    );
    expect(refused.status).toBe(400);
    expect(
      (await refused.json<{ data: { message: string } }>()).data.message,
    ).toMatch(/more permissions/);
    const unchanged = await call(endpoint, cookie);
    expect(
      (await unchanged.json<{ data: { items: Array<{ version?: string }> } }>())
        .data.items[0]?.version,
    ).toBe("1.0.0");

    const accepted = await call(
      `${updates}?name=u2.zip&integrity=${reviewed.data.integrity}&acceptPermissions=1`,
      cookie,
      { zip: wider },
    );
    expect(accepted.status).toBe(200);

    // 1.2.0 asks for less: it updates without acceptance.
    const narrower = await buildZip(
      codePlugin(
        { events: ["tool.call"], network: ["api.example.com"] },
        {
          version: "1.2.0",
          settings: [
            { key: "team", label: "Team", type: "string" },
            { key: "region", label: "Region", type: "string", required: true },
          ],
        },
      ),
    );
    const narrowPreview = await call(`${updates}/preview?name=u3.zip`, cookie, {
      zip: narrower,
    });
    const narrowed = await narrowPreview.json<UpdatePreviewBody>();
    expect(narrowed.data.permissions).toEqual({
      widens: false,
      changes: [
        { permission: "network", added: [], removed: ["api.other.com"] },
        { permission: "ai", added: [], removed: ["model calls"] },
      ],
    });
    const applied = await call(
      `${updates}?name=u3.zip&integrity=${narrowed.data.integrity}`,
      cookie,
      { zip: narrower },
    );
    expect(applied.status).toBe(200);
    expect(
      (await applied.json<{ data: { version?: string } }>()).data.version,
    ).toBe("1.2.0");
  });

  it("names the GitHub plugins whose folder changed since install, and stays quiet when GitHub can't say", async () => {
    const { cookie } = await signup("plugin-update-check@example.com");
    const installedCommit = "5555555555555555555555555555555555555555";
    const install = async (repository: string, path: string) => {
      const archive = await buildZip(
        codePlugin(
          { events: ["tool.call"] },
          { prefix: `repo-main/${path === "" ? "" : `${path}/`}` },
        ).map((entry) => ({
          ...entry,
          content: entry.content.replace(
            "com.acme.updater",
            `com.acme.${repository.split("/")[1]}`,
          ),
        })),
        installedCommit,
      );
      network.use(
        http.get(
          `https://codeload.github.com/${repository}/zip/:ref`,
          () =>
            new HttpResponse(archive.slice(), {
              headers: { "content-type": "application/zip" },
            }),
        ),
      );
      const url = `https://github.com/${repository}${path === "" ? "" : `/tree/main/${path}`}`;
      const preview = await call(`${endpoint}/preview`, cookie, {
        json: { url },
      });
      expect(preview.status).toBe(200);
      const reviewed = await preview.json<{
        data: { source: unknown; integrity: string };
      }>();
      const installed = await call(endpoint, cookie, {
        json: {
          source: reviewed.data.source,
          reviewedIntegrity: reviewed.data.integrity,
        },
      });
      expect(installed.status).toBe(201);
      return (await installed.json<{ data: { id: string } }>()).data.id;
    };
    const changed = await install("acme/changed", "plugins/kit");
    const elsewhere = await install("acme/elsewhere", "plugins/kit");
    const unknown = await install("acme/unknown", "");
    await installZip(cookie, await buildZip(codePlugin({})));

    const compared: Array<string> = [];
    network.use(
      http.get(
        "https://api.github.com/repos/:owner/:repo/compare/:range",
        ({ params }) => {
          compared.push(`${params.owner}/${params.repo}/${params.range}`);
          if (params.repo === "unknown")
            return new HttpResponse(null, { status: 403 });
          const files =
            params.repo === "changed"
              ? [{ filename: "plugins/kit/dev.dxcode/index.js" }]
              : [{ filename: "plugins/other/plugin.json" }];
          return HttpResponse.json({
            status: "ahead",
            ahead_by: 1,
            files,
            commits: [{ sha: "6666666666666666666666666666666666666666" }],
          });
        },
      ),
    );
    const response = await call(`${endpoint}/updates`, cookie);
    expect(response.status).toBe(200);
    const { data } = await response.json<{
      data: { items: ReadonlyArray<{ pluginId: string; available: boolean }> };
    }>();
    expect(
      Object.fromEntries(
        data.items.map(({ pluginId, available }) => [pluginId, available]),
      ),
    ).toEqual({ [changed]: true, [elsewhere]: false });
    expect(data.items.map(({ pluginId }) => pluginId)).not.toContain(unknown);
    expect(compared.sort()).toEqual([
      `acme/changed/${installedCommit}...main`,
      `acme/elsewhere/${installedCommit}...main`,
      `acme/unknown/${installedCommit}...HEAD`,
    ]);
  });
});

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

const record = (
  id: PluginId,
  target: PluginTarget,
  userId: UserId,
  bundle: Awaited<ReturnType<typeof read>>,
) =>
  Schema.decodeUnknownSync(StoredPluginBundle)({
    id,
    target,
    name: bundle.manifest.name,
    enabled: true,
    version: bundle.version,
    manifest: bundle.manifest,
    source: { type: "zip", label: "fixture.zip" },
    integrity: bundle.integrity,
    installedAt: "2026-11-10T12:00:00.000Z",
    installedByUserId: userId,
    updatedAt: "2026-11-10T12:00:00.000Z",
  });

const runtimeFor = async (threadId: string, ownerUserId: string) =>
  ({
    threadId,
    ownerUserId,
    plugins: await resolveThreadCodePlugins(bindings, env.DB, threadId),
    host: () => ({ db: env.DB, bindings }),
  }) satisfies CodePluginRuntime;

const toolOf = (runtime: CodePluginRuntime) => {
  const tool = createPluginTools(runtime, new Set(), () => []).find(
    ({ name }) => name === "which_version",
  );
  if (tool === undefined) throw new Error("Expected which_version.");
  return tool;
};

const run = async (tool: ToolDefinition) =>
  String(
    await tool.run({
      toolCallId: "call-1",
      data: {},
      log: console,
    } as never),
  );

describe("a workspace plugin update", () => {
  it("reaches every member's next submission, while a submission already running keeps its version", async () => {
    const stamp = "2026-11-10T12:00:00.000Z";
    const admin = "usr_plugin_update_admin" as UserId;
    const member = "usr_plugin_update_member" as UserId;
    const workspaceId = "org_plugin_update";
    const thread = (_userId: string, n: number) =>
      `thr_00000000-0000-4000-9100-${String(n).padStart(12, "0")}`;
    await env.DB.batch([
      ...[admin, member].flatMap((userId, index) => [
        env.DB.prepare(
          'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
        ).bind(userId, userId, `${userId}@example.com`),
        env.DB.prepare(
          "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, 'Plugins', ?, ?)",
        ).bind(`prj_update_${index}`, userId, stamp, stamp),
        env.DB.prepare(
          "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(
          thread(userId, index),
          `prj_update_${index}`,
          userId,
          stamp,
          stamp,
        ),
      ]),
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Acme', 'acme-update', 1)",
      ).bind(workspaceId),
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('mem_u1', ?, ?, 'owner', 1)",
      ).bind(workspaceId, admin),
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('mem_u2', ?, ?, 'member', 1)",
      ).bind(workspaceId, member),
    ]);
    const target = { scope: "workspace", id: workspaceId } as PluginTarget;
    const id = "plg_00000000-0000-4000-8000-0000000f0001" as PluginId;
    const first = await read(codePlugin({}, { tool: "one" }));
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* PluginBundleRepository).insert(
          record(id, target, admin, first),
          first.codeModules,
        );
      }).pipe(Effect.provide(PluginBundleRepositoryD1(env.DB))),
    );

    const running = await runtimeFor(thread(member, 1), member);
    expect(await run(toolOf(running))).toBe("one");

    // The admin updates the workspace install once.
    const second = await read(
      codePlugin({}, { version: "2.0.0", tool: "two" }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* PluginBundleRepository).insertVersion(
          record(id, target, admin, second),
          second.codeModules,
        );
      }).pipe(Effect.provide(PluginBundleRepositoryD1(env.DB))),
    );

    // The member's running submission still calls the version it resolved.
    expect(await run(toolOf(running))).toBe("one");
    // Every member's next submission runs the new version.
    for (const [userId, n] of [
      [member, 1],
      [admin, 0],
    ] as const) {
      const next = await runtimeFor(thread(userId, n), userId);
      expect(next.plugins.map(({ version }) => version)).toEqual([
        second.version,
      ]);
      expect(await run(toolOf(next))).toBe("two");
    }
  });
});
