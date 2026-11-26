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
import { describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { loadRunningInstall } from "../../src/plugins/services/installs.js";
import { sweepPluginServices } from "../../src/plugins/services/lifecycle.js";
import { ensureInstallPluginOrb } from "../../src/plugins/services/plugin-orbs.js";
import { handleServiceRequest } from "../../src/plugins/services/requests.js";
import { sweepServiceSchedules } from "../../src/plugins/services/schedules.js";
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
  createTestBindings,
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
  TEST_WORKLOAD_IDENTITY_SIGNING_KEYS,
} from "../../src/testing/bindings.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * One contract for function code and services (tasks/plugins-next.md
 * decision 13): schedules, state, opening and posting to Threads, and a
 * cloud token work the same from a plugin's function code as from its
 * service, over real D1 and real Dynamic Workers. Before each case, how it
 * could fail:
 *
 * Schedules without a service:
 * - the minute sweep writes no rows for a plugin with no service (only
 *   services' schedules were ever written), so nothing runs;
 * - a due row runs, but `job.run` never reaches the code: the event is not
 *   granted, the dispatch goes to a service that does not exist, or the
 *   payload lacks the schedule's name and due time;
 * - running it starts a plugin Orb, or an Orb row, for a plugin that has no
 *   service;
 * - a second tick at the same minute runs the same occurrence again;
 * - it runs as someone other than the install's person.
 *
 * `ctx.threads.open` with a key:
 * - the second open makes a second Thread instead of returning the first
 *   (`created: false`);
 * - the Thread belongs to someone other than the install's person;
 * - a plugin without the `create` grant opens one anyway.
 *
 * `ctx.identity.token`:
 * - absent in function code, so a token still needs a runner Thread;
 * - the subject names a Thread or a person, not the install:
 *   `dx:wid:v1:u:<h(owner)>:i:<h(install)>`.
 *
 * State shared with a service:
 * - function code writes one table and the service reads another, so
 *   moving code to a service loses its state.
 *
 * Removed features:
 * - a stored version that asks for `jobs` or `tier` still loads with those
 *   fields silently dropped, instead of not loading and saying it must be
 *   rebuilt.
 */

/** What the agent route received: dx's own Thread posts, without Flue. */
const flue = vi.hoisted(() => ({
  delivered: [] as Array<{ threadId: string; body: Record<string, unknown> }>,
}));

vi.mock("../../src/agents/routes.js", async () => {
  const { Hono } = await import("hono");
  const { useAgentAdmission } = await import("../../src/agents/admission.js");
  const routes = useAgentAdmission(new Hono());
  routes.get("/:threadId", () =>
    Response.json({ messages: [], settlements: [] }),
  );
  routes.post("/:threadId", async (context) => {
    flue.delivered.push({
      threadId: context.req.param("threadId"),
      body: await context.req.json(),
    });
    return Response.json(
      { submissionId: `sub-${flue.delivered.length}` },
      { status: 202 },
    );
  });
  return { dxAgentRoutes: routes };
});

const origin = "http://dx.test";
const bindings = {
  DB: env.DB,
  LOADER: env.LOADER,
  REALTIME_HUB: env.REALTIME_HUB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  BETTER_AUTH_SECRET: "plugin-durable-contract-secret-000000",
  // A blank Thread's model routing: Workers AI serves the default mode.
  AI: { run: async () => ({}) },
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
  DX_WORKLOAD_IDENTITY_ISSUER: "https://dx.test/api/workload-identity",
  DX_WORKLOAD_IDENTITY_AUDIENCE_POLICIES: JSON.stringify({
    version: 1,
    policies: [],
  }),
  DX_WORKLOAD_IDENTITY_SIGNING_KEYS: TEST_WORKLOAD_IDENTITY_SIGNING_KEYS,
} as unknown as Bindings;
/** A deployed runtime with its own E2B account, for a service's plugin Orb. */
const deployed: Bindings = { ...createTestBindings(), DB: env.DB };

const plugin = (
  name: string,
  dxcode: Record<string, unknown>,
  code: string,
): ReadonlyArray<FixtureEntry> => [
  {
    name: "plugin.json",
    content: JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
      name,
      displayName: name,
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
  { name: "dev.dxcode/index.js", content: code },
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
    `plg_00000000-0000-4000-8000-${String(3_000 + installs).padStart(12, "0")}` as PluginId;
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
/** A signed-in person with a Project and a Thread. */
const person = async () => {
  signups += 1;
  const email = `plugin-contract-${signups}@example.test`;
  const signedUp = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `198.51.100.${signups + 120}`,
      },
      body: JSON.stringify({
        name: "Contract Owner",
        email,
        password: "plugin-contract-password-123",
      }),
    },
    bindings,
  );
  expect(signedUp.status).toBe(200);
  const cookie = signedUp.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const userId = (await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id")) as UserId;
  const suffix = String(3_000 + signups).padStart(12, "0");
  const ownProject = project(
    `prj_00000000-0000-4000-8000-${suffix}`,
    userId,
    "Contract",
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
  return {
    userId,
    cookie,
    projectId: ownProject.id as string,
    threadId: ownThread.id as string,
    personal: { scope: "personal", id: userId } as PluginTarget,
  };
};

const dependenciesOf = async (
  threadId: string,
  userId: UserId,
  name: string,
) => {
  const plugins = await resolveThreadCodePlugins(bindings, env.DB, threadId);
  const found = plugins.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`${name} did not resolve.`);
  return {
    db: env.DB,
    bindings,
    install: found,
    threadId,
    ownerUserId: userId,
  };
};

/** Runs a sweep and waits for the work it hands to `waitUntil`. */
const sweep = async (
  run: (waitUntil: (promise: Promise<unknown>) => void) => Promise<void>,
) => {
  const pending: Array<Promise<unknown>> = [];
  await run((promise) => pending.push(promise));
  await Promise.all(pending);
};

const stored = async (pluginId: string, key: string) => {
  const row = await env.DB.prepare(
    "SELECT value_json FROM plugin_install_storage WHERE plugin_id = ? AND key = ?",
  )
    .bind(pluginId, key)
    .first<{ value_json: string }>();
  return row === null ? undefined : (JSON.parse(row.value_json) as unknown);
};

const digest = async (value: string) => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

describe("schedules for function code", () => {
  it("runs job.run in the function code, once per occurrence, with no Orb", async () => {
    const owner = await person();
    const pluginId = await install(
      owner.personal,
      owner.userId,
      plugin(
        "ticker",
        {
          schedules: [{ name: "tick", every: "5m" }],
          permissions: { events: [] },
        },
        `export default (dx) => {
  dx.on("job.run", async (event, ctx) => {
    const runs = (await ctx.storage.get("runs")) ?? [];
    await ctx.storage.set("runs", [...runs, { ...event, caller: ctx.caller.userId, thread: ctx.thread === undefined }]);
  });
};`,
      ),
    );
    // Declaring a schedule grants its event.
    const loaded = await loadRunningInstall(env.DB, pluginId);
    expect(loaded?.code.permissions.events).toContain("job.run");
    expect(loaded?.code.service).toBeUndefined();

    const start = new Date("2026-11-25T12:00:00.000Z");
    await sweep((waitUntil) => sweepPluginServices(bindings, start, waitUntil));
    const rows = await env.DB.prepare(
      "SELECT name, spec, next_run_at FROM plugin_service_schedule WHERE plugin_id = ?",
    )
      .bind(pluginId)
      .all<{ name: string; spec: string; next_run_at: string }>();
    expect(rows.results).toEqual([
      {
        name: "tick",
        spec: "every:5m",
        next_run_at: "2026-11-25T12:05:00.000Z",
      },
    ]);
    // A second reconcile leaves a written row's next run alone.
    await sweep((waitUntil) =>
      sweepPluginServices(
        bindings,
        new Date(start.getTime() + 60_000),
        waitUntil,
      ),
    );
    expect(
      (
        await env.DB.prepare(
          "SELECT next_run_at FROM plugin_service_schedule WHERE plugin_id = ?",
        )
          .bind(pluginId)
          .first<{ next_run_at: string }>()
      )?.next_run_at,
    ).toBe("2026-11-25T12:05:00.000Z");

    // Due: two ticks in the same minute run it once.
    const due = new Date("2026-11-25T12:05:30.000Z");
    await sweep((waitUntil) => sweepServiceSchedules(bindings, due, waitUntil));
    await sweep((waitUntil) => sweepServiceSchedules(bindings, due, waitUntil));
    expect(await stored(pluginId, "runs")).toEqual([
      {
        name: "tick",
        scheduledAt: "2026-11-25T12:05:00.000Z",
        caller: owner.userId,
        thread: true,
      },
    ]);
    const after = await env.DB.prepare(
      "SELECT next_run_at, last_status, last_message FROM plugin_service_schedule WHERE plugin_id = ?",
    )
      .bind(pluginId)
      .first();
    expect(after).toEqual({
      next_run_at: "2026-11-25T12:10:30.000Z",
      last_status: "ok",
      last_message: null,
    });
    // No Orb, no service, and no workspace for it.
    const orbs = await env.DB.batch([
      env.DB.prepare(
        "SELECT count(*) AS n FROM plugin_orb WHERE payer_user_id = ?",
      ).bind(owner.userId),
      env.DB.prepare(
        "SELECT count(*) AS n FROM plugin_service WHERE plugin_id = ?",
      ).bind(pluginId),
    ]);
    expect(orbs.map((result) => result.results[0])).toEqual([
      { n: 0 },
      { n: 0 },
    ]);

    // Turned off: the due row goes instead of running.
    await env.DB.prepare("UPDATE trusted_plugin SET enabled = 0 WHERE id = ?")
      .bind(pluginId)
      .run();
    await sweep((waitUntil) =>
      sweepServiceSchedules(
        bindings,
        new Date("2026-11-25T12:11:00.000Z"),
        waitUntil,
      ),
    );
    expect(await stored(pluginId, "runs")).toHaveLength(1);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM plugin_service_schedule WHERE plugin_id = ?",
      )
        .bind(pluginId)
        .first("n"),
    ).toBe(0);
  });
});

/** A plugin whose tools open, post to, and identify as its install. */
const actionsCode = `export default (dx) => {
  const attempt = (run) => run().then((value) => ({ ok: value }), (error) => ({ error: error.message, code: error.code ?? null }));
  dx.registerTool({
    name: "open",
    description: "Opens the incident Thread.",
    execute: (input, ctx) => attempt(() => ctx.threads.open({ key: "incident-db", title: "Database down", prompt: "The database is down: " + input.n })),
  });
  dx.registerTool({
    name: "post",
    description: "Posts into a Thread.",
    execute: (input, ctx) => attempt(() => ctx.threads.post(input.threadId, "Still down.")),
  });
  dx.registerTool({
    name: "identity",
    description: "Mints a token.",
    execute: (_input, ctx) => attempt(() => ctx.identity.token("https://cloud.example/workloads", 600)),
  });
  dx.registerTool({
    name: "grants",
    description: "What the context has.",
    execute: (_input, ctx) => ({ open: typeof ctx.threads?.open, post: typeof ctx.threads?.post, identity: typeof ctx.identity }),
  });
};`;

describe("install actions in function code", () => {
  it("opens one Thread per key, as the install's person, and posts into it", async () => {
    const owner = await person();
    await install(
      owner.personal,
      owner.userId,
      plugin(
        "pager",
        { permissions: { events: [], threads: ["create"] } },
        actionsCode,
      ),
    );
    const dependencies = await dependenciesOf(
      owner.threadId,
      owner.userId,
      "pager",
    );
    const first = (await callPluginTool(dependencies, "open", {
      n: 1,
    })) as { ok?: { threadId: string; url: string; created: boolean } };
    expect(first).toMatchObject({ ok: { created: true } });
    const second = (await callPluginTool(dependencies, "open", {
      n: 2,
    })) as { ok?: { threadId: string; created: boolean } };
    expect(second.ok).toEqual({
      threadId: first.ok?.threadId,
      url: first.ok?.url,
      created: false,
    });
    const opened = await env.DB.prepare(
      "SELECT owner_user_id, lifecycle_state FROM threads WHERE id = ?",
    )
      .bind(first.ok?.threadId)
      .first();
    expect(opened).toEqual({
      owner_user_id: owner.userId,
      lifecycle_state: "active",
    });
    // One Thread for the key, however many opens.
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM plugin_thread_key WHERE key = 'incident-db' AND thread_id = ?",
      )
        .bind(first.ok?.threadId)
        .first("n"),
    ).toBe(1);
    // A note into the Thread it opened, with no model call; none into a
    // Thread it did not open.
    const delivered = flue.delivered.length;
    expect(
      await callPluginTool(dependencies, "post", {
        threadId: first.ok?.threadId,
      }),
    ).toEqual({});
    expect(flue.delivered.slice(delivered)).toEqual([
      {
        threadId: first.ok?.threadId,
        body: expect.objectContaining({ kind: "chat" }),
      },
    ]);
    expect(
      await callPluginTool(dependencies, "post", { threadId: owner.threadId }),
    ).toMatchObject({ code: "not-opened" });
  });

  it("gives no open without the create grant", async () => {
    const owner = await person();
    await install(
      owner.personal,
      owner.userId,
      plugin(
        "quiet",
        { permissions: { events: [], threads: ["read"] } },
        actionsCode,
      ),
    );
    const dependencies = await dependenciesOf(
      owner.threadId,
      owner.userId,
      "quiet",
    );
    expect(await callPluginTool(dependencies, "grants", {})).toEqual({
      open: "undefined",
      post: "undefined",
      identity: "object",
    });
  });

  it("mints a cloud token whose subject names the install", async () => {
    const owner = await person();
    const pluginId = await install(
      owner.personal,
      owner.userId,
      plugin("cloudy", { permissions: { events: [] } }, actionsCode),
    );
    const minted = (await callPluginTool(
      await dependenciesOf(owner.threadId, owner.userId, "cloudy"),
      "identity",
      {},
    )) as { ok?: { token: string; expiresAt: number } };
    expect(minted).toMatchObject({ ok: { token: expect.any(String) } });
    expect(minted.ok?.token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    const claims = JSON.parse(
      atob(
        (minted.ok?.token.split(".")[1] ?? "")
          .replaceAll("-", "+")
          .replaceAll("_", "/"),
      ),
    ) as Record<string, unknown>;
    expect(claims.sub).toBe(
      `dx:wid:v1:u:${await digest(owner.userId)}:i:${await digest(pluginId)}`,
    );
    expect(claims).toMatchObject({
      aud: "https://cloud.example/workloads",
      plugin_install_id: pluginId,
      plugin_name: "cloudy",
      plugin_runtime: "function",
      runtime_assurance: "dx_core_function_v1",
    });
    expect(claims.thread_id).toBeUndefined();
    expect(minted.ok?.expiresAt).toBe(claims.exp);
    const audit = await env.DB.prepare(
      "SELECT outcome, target FROM plugin_audit WHERE plugin_id = ? AND action = 'identity.token'",
    )
      .bind(pluginId)
      .all();
    expect(audit.results).toEqual([
      { outcome: "success", target: "https://cloud.example/workloads" },
    ]);
  });
});

describe("state shared with a service", () => {
  it("reads through the service's DX_API what the function code wrote", async () => {
    const owner = await person();
    await env.DB.prepare(
      `INSERT INTO plugin_orb_choice (scope, target_id, runner_profile_id, updated_by, updated_at)
       VALUES ('personal', ?, 'a1.medium', ?, ?)`,
    )
      .bind(owner.userId, owner.userId, "2026-11-25T12:00:00.000Z")
      .run();
    const pluginId = await install(
      owner.personal,
      owner.userId,
      plugin(
        "both",
        {
          permissions: { events: [] },
          service: { run: "node service.js" },
        },
        `export default (dx) => dx.registerTool({
  name: "remember",
  description: "Stores counts.",
  execute: async (_input, ctx) => { await ctx.storage.set("counts", { hour: 7 }); return "stored"; },
});`,
      ).concat([{ name: "service.js", content: "// the service" }]),
    );
    expect(
      await callPluginTool(
        await dependenciesOf(owner.threadId, owner.userId, "both"),
        "remember",
        {},
      ),
    ).toBe("stored");
    const service = await loadRunningInstall(env.DB, pluginId);
    if (service === undefined) throw new Error("Expected the install.");
    const orb = await ensureInstallPluginOrb(deployed, service);
    if (!orb.ok) throw new Error("Expected a plugin Orb.");
    await env.DB.prepare(
      `INSERT INTO plugin_service (plugin_id, orb_id, status, updated_at)
       VALUES (?, ?, 'running', ?)`,
    )
      .bind(pluginId, orb.orb.id, "2026-11-25T12:00:00.000Z")
      .run();
    expect(
      await handleServiceRequest(bindings, {
        orbId: orb.orb.id,
        installId: pluginId,
        method: "GET",
        path: "/state/counts",
        body: undefined,
      }),
    ).toEqual({ status: 200, body: { value: { hour: 7 } } });
  });
});

/** The Log Watch example, as a ZIP of its folder would hold it. */
const logWatchFiles = (): ReadonlyArray<FixtureEntry> =>
  Object.entries(
    import.meta.glob("../../../../examples/plugins/log-watch/**/*", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>,
  ).map(([path, content]) => ({
    name: path.slice("../../../../examples/plugins/log-watch/".length),
    content,
  }));

describe("the Log Watch example as function code", () => {
  it("checks on its schedule with no Orb, moves the dashboard, and opens one Thread for an error jump", async () => {
    const owner = await person();
    const pluginId = await install(
      owner.personal,
      owner.userId,
      logWatchFiles(),
    );
    // Twelve fresh errors of one kind in the dashboard's own lines: over the
    // default threshold of ten.
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO plugin_install_storage (plugin_id, key, value_json, updated_at)
       VALUES (?, 'lines', ?, ?)`,
    )
      .bind(
        pluginId,
        JSON.stringify(
          Array.from({ length: 12 }, (_, index) => ({
            id: `l${index}`,
            time: new Date(now - 60_000 + index).toISOString(),
            service: "api",
            level: "error",
            message: `Timeout calling payment provider after ${index + 10} s`,
          })),
        ),
        new Date(now).toISOString(),
      )
      .run();
    const start = new Date(now);
    await sweep((waitUntil) => sweepPluginServices(bindings, start, waitUntil));
    await sweep((waitUntil) =>
      sweepServiceSchedules(bindings, new Date(now + 16 * 60_000), waitUntil),
    );
    const schedule = await env.DB.prepare(
      "SELECT last_status, last_message FROM plugin_service_schedule WHERE plugin_id = ? AND name = 'check'",
    )
      .bind(pluginId)
      .first();
    expect(schedule).toEqual({ last_status: "ok", last_message: null });
    const history = (await stored(pluginId, "history")) as ReadonlyArray<{
      count: number;
    }>;
    expect(history.map(({ count }) => count)).toEqual([12]);
    const view = await env.DB.prepare(
      "SELECT state_json FROM plugin_view_state WHERE plugin_id = ? AND view_id = 'dashboard'",
    )
      .bind(pluginId)
      .first<{ state_json: string }>();
    expect(
      (JSON.parse(view?.state_json ?? "{}") as { check?: unknown }).check,
    ).toMatchObject({ errors: 12, usual: 0, runtime: "function" });
    // The digits dropped, the twelve are one kind: one Thread, keyed by it.
    const incident = (await stored(pluginId, "incident")) as {
      key: string;
      threadId: string;
    };
    expect(incident.key).toMatch(/^errors-[0-9a-f]{12}$/);
    expect(
      await env.DB.prepare("SELECT owner_user_id FROM threads WHERE id = ?")
        .bind(incident.threadId)
        .first("owner_user_id"),
    ).toBe(owner.userId);
    // No Orb for a plugin with no service.
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM plugin_service WHERE plugin_id = ?",
      )
        .bind(pluginId)
        .first("n"),
    ).toBe(0);
  });
});

describe("a plugin that uses a removed feature", () => {
  it("does not load, and its row says it must be rebuilt", async () => {
    const owner = await person();
    const pluginId = `plg_00000000-0000-4000-8000-${String(3_900).padStart(12, "0")}`;
    const now = "2026-11-25T12:00:00.000Z";
    const manifest = {
      format: "agent-plugins",
      name: "old-watcher",
      displayName: "Old watcher",
      description: "Installed before schedules.",
      skills: [],
      mcpServers: [],
      code: {
        apiVersion: 1,
        host: "worker",
        entry: "dev.dxcode/index.js",
        modules: [],
        permissions: {
          events: [],
          network: [],
          secrets: [],
          tools: [],
          ai: false,
        },
        settings: [],
        tier: "personal-dev",
        jobs: [{ id: "sync", title: "Sync", schedule: { every: "5m" } }],
      },
      skipped: [],
    };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO trusted_plugin (
           id, scope, target_id, name, enabled, active_version, health_status,
           created_at, updated_at, kind
         ) VALUES (?, 'personal', ?, 'old-watcher', 1, '1.0.0', 'unchecked', ?, ?, 'bundle')`,
      ).bind(pluginId, owner.userId, now, now),
      env.DB.prepare(
        `INSERT INTO trusted_plugin_version (
           plugin_id, version, manifest_json, grants_json, source_json,
           integrity, trusted, trusted_at, trusted_by_user_id
         ) VALUES (?, '1.0.0', ?, '{}', '{"type":"zip","label":"old.zip"}', ?, 1, ?, ?)`,
      ).bind(
        pluginId,
        JSON.stringify(manifest),
        "c".repeat(64),
        now,
        owner.userId,
      ),
    ]);
    // Nothing runs it: no Thread resolves it, no schedule or listener loads it.
    const resolved = await resolveThreadCodePlugins(
      bindings,
      env.DB,
      owner.threadId,
    );
    expect(resolved.map(({ name }) => name)).not.toContain("old-watcher");
    expect(await loadRunningInstall(env.DB, pluginId)).toBeUndefined();
    // The Plugins page says why.
    const listed = await app.request(
      "/v1/settings/personal/plugin-bundles",
      { headers: { cookie: owner.cookie, origin } },
      bindings,
    );
    expect(listed.status, await listed.clone().text()).toBe(200);
    const { data } = (await listed.json()) as {
      data: {
        items: ReadonlyArray<{
          id: string;
          skipped: ReadonlyArray<{ path: string; reason: string }>;
        }>;
      };
    };
    expect(data.items.find(({ id }) => id === pluginId)?.skipped).toEqual([
      {
        path: "plugin.json#extensions.dev.dxcode",
        reason:
          "This plugin uses jobs and tier, which dx no longer runs. Rebuild it with schedules, listeners, and ctx.threads, then update it.",
      },
    ]);
  });
});
