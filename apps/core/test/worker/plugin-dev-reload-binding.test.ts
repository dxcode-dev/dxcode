/**
 * Hot reload is bound to one Thread (security review). How it could go
 * wrong, each checked below:
 * - another of the owner's Threads (a prompt-injected agent, a postinstall
 *   script, a shared Thread a collaborator drives) replaces the code;
 * - a refused reload leaves no trace for the owner to see;
 * - hot reload left on stays on forever;
 * - turning it on for a Thread binds nothing, or binds a Thread that isn't
 *   the person's own.
 */
import { env } from "cloudflare:test";
import {
  PluginBundleRepository,
  type PluginTarget,
  StoredPluginBundle,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import { reloadDevPlugin } from "../../src/plugins/trust/dev-reload.js";
import {
  PluginTrustPolicies,
  PluginTrustPoliciesD1,
} from "../../src/plugins/trust/policy.js";
import { readPluginBundle } from "../../src/settings/plugins/bundles/read-bundle.js";
import { PluginBundleRepositoryD1 } from "../../src/settings/plugins/bundles/repository-d1.js";
import { readZipArchive } from "../../src/settings/plugins/bundles/zip.js";
import { buildZip } from "../../src/settings/plugins/bundles/zip-fixture.js";

const bindings = {
  DB: env.DB,
  DX_STORAGE: env.DX_STORAGE,
  DX_AUTH_URL: "http://dx.test",
} as unknown as Bindings;

const entry = (version: string) =>
  `export default (dx) => { dx.registerTool({ name: "v", description: "Version.", execute: () => "${version}" }); };\n`;
const manifest = JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
  name: "com.acme.devloop",
  displayName: "Dev loop",
  description: "Hot reloaded.",
  version: "1.0.0",
  extensions: {
    "dev.dxcode": {
      apiVersion: 1,
      entry: "dev.dxcode/index.js",
      permissions: { events: [] },
    },
  },
});
const files = (version: string) => [
  { name: "devloop/plugin.json", content: manifest },
  { name: "devloop/dev.dxcode/index.js", content: entry(version) },
];
const folderBody = (version: string) =>
  JSON.stringify({
    folder: "/tmp/devloop",
    files: files(version).map(({ name, content }) => ({
      path: name,
      content: btoa(content),
    })),
  });

let people = 0;
const owner = async () => {
  people += 1;
  const userId =
    `usr_dev_binding_${people}_${crypto.randomUUID().slice(0, 6)}` as UserId;
  const projectId = `prj_${userId}`;
  const thread = (n: number) =>
    `thr_00000000-0000-4000-a${String(people).padStart(3, "0")}-${String(n).padStart(12, "0")}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
    ).bind(userId, userId, `${userId}@example.com`),
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, 'Dev', ?, ?)",
    ).bind(projectId, userId, now, now),
    ...[1, 2].map((n) =>
      env.DB.prepare(
        "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(thread(n), projectId, userId, now, now),
    ),
  ]);
  return { userId, bound: thread(1), other: thread(2) };
};

const install = async (userId: UserId) => {
  // The install's files sit at the root, as a ZIP of the folder would.
  const bundle = await Effect.runPromise(
    readZipArchive(
      await buildZip(
        files("v1").map(({ name, content }) => ({
          name: name.replace(/^devloop\//, ""),
          content,
        })),
      ),
      { maxArchiveBytes: 16 * 1024 * 1024, maxEntries: 1_000 },
    ).pipe(
      Effect.flatMap((archive) =>
        readPluginBundle(archive, { root: "", fallbackName: "devloop" }),
      ),
    ),
  );
  const id = `plg_${crypto.randomUUID()}` as never;
  const now = new Date().toISOString();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* PluginBundleRepository).insert(
        Schema.decodeUnknownSync(StoredPluginBundle)({
          id,
          target: { scope: "personal", id: userId } as PluginTarget,
          name: bundle.manifest.name,
          enabled: true,
          version: bundle.version,
          manifest: bundle.manifest,
          source: { type: "zip", label: "devloop.zip" },
          integrity: bundle.integrity,
          installedAt: now,
          installedByUserId: userId,
          updatedAt: now,
        }),
        bundle.codeModules,
      );
    }).pipe(Effect.provide(PluginBundleRepositoryD1(env.DB))),
  );
  return id as string;
};

const turnOn = (pluginId: string, threadId: string | undefined) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* PluginTrustPolicies).setDev(pluginId, threadId);
    }).pipe(Effect.provide(PluginTrustPoliciesD1(env.DB))),
  );

const reload = async (threadId: string, version: string) => {
  const response = await reloadDevPlugin(bindings, {
    threadId: threadId as never,
    body: folderBody(version),
  });
  return {
    status: response.status,
    body: await response.json<{
      outcome: string;
      error?: string;
      enableUrl?: string;
    }>(),
  };
};

const audits = (pluginId: string) =>
  env.DB.prepare(
    `SELECT thread_id, outcome, detail_json FROM plugin_audit
      WHERE plugin_id = ? AND action = 'dev.reload' ORDER BY created_at`,
  )
    .bind(pluginId)
    .all<{ thread_id: string; outcome: string; detail_json: string }>()
    .then(({ results }) => results);

const activeIntegrity = (pluginId: string) =>
  env.DB.prepare(
    `SELECT version.integrity FROM trusted_plugin plugin
       JOIN trusted_plugin_version version
         ON version.plugin_id = plugin.id AND version.version = plugin.active_version
      WHERE plugin.id = ?`,
  )
    .bind(pluginId)
    .first<string>("integrity");

describe("hot reload bound to one Thread", () => {
  it("reloads only from the Thread it is on for; another Thread is refused and audited", async () => {
    const { userId, bound, other } = await owner();
    const pluginId = await install(userId);

    // Off: refused, with a link that turns it on for this Thread.
    const off = await reload(bound, "v2");
    expect(off.status).toBe(403);
    expect(off.body.outcome).toBe("not-enabled");
    expect(off.body.enableUrl).toBe(
      `http://dx.test/settings/plugins?hotReload=${pluginId}&thread=${bound}`,
    );

    await turnOn(pluginId, bound);
    const before = await activeIntegrity(pluginId);
    const blocked = await reload(other, "v-other");
    expect(blocked.status).toBe(403);
    expect(blocked.body.outcome).toBe("other-thread");
    expect(await activeIntegrity(pluginId)).toBe(before);

    const reloaded = await reload(bound, "v2");
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.outcome).toBe("reloaded");
    expect(await activeIntegrity(pluginId)).not.toBe(before);

    const rows = await audits(pluginId);
    expect(rows.map(({ thread_id, outcome }) => [thread_id, outcome])).toEqual([
      [bound, "rejected"],
      [other, "rejected"],
      [bound, "success"],
    ]);
    expect(JSON.parse(rows[1]?.detail_json ?? "{}")).toMatchObject({
      reason: "other-thread",
      boundThreadId: bound,
    });
  });

  it("turns itself off after 24 hours unused", async () => {
    const { userId, bound } = await owner();
    const pluginId = await install(userId);
    await turnOn(pluginId, bound);
    const dayAgo = new Date(
      Date.now() - 24 * 60 * 60 * 1000 - 60_000,
    ).toISOString();
    await env.DB.prepare(
      "UPDATE plugin_dev_link SET enabled_at = ? WHERE plugin_id = ?",
    )
      .bind(dayAgo, pluginId)
      .run();
    const listed = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* PluginTrustPolicies).devLinks([pluginId]);
      }).pipe(Effect.provide(PluginTrustPoliciesD1(env.DB))),
    );
    expect(listed.size).toBe(0);
    const idle = await reload(bound, "v2");
    expect(idle.status).toBe(403);
    expect(idle.body.outcome).toBe("not-enabled");
    expect(idle.body.error).toContain("turned off after 24 hours unused");
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM plugin_dev_link WHERE plugin_id = ?",
      )
        .bind(pluginId)
        .first<number>("n"),
    ).toBe(0);
    const [row] = await audits(pluginId);
    expect(JSON.parse(row?.detail_json ?? "{}")).toMatchObject({
      reason: "idle",
    });
  });
});
