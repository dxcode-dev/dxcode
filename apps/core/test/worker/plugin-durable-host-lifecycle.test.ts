import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import type { DurableMeta } from "../../src/plugins/hosts/durable/client.js";
import { PluginDurableHost } from "../../src/plugins/hosts/durable/object-host.js";

/*
 * The plugin Durable Object host's bookkeeping, in workerd with real D1, R2,
 * and Durable Object storage. Ways it could go wrong, each covered below:
 *
 * Usage (billing):
 * 1. The pending counts are deleted before the D1 write and lost when the
 *    write fails.
 * 2. A failed write throws out of stop() or alarm(), so jobs stop pausing
 *    or the alarm stops re-arming.
 * 3. `usage_at` advances on a failed write, so the retried row's period
 *    skips the time it covers.
 * 4. A later successful flush counts the same requests twice.
 *
 * Purge (data outliving deletion):
 * 5. The object's SQLite (the plugin's tables and dx's own) survives.
 * 6. Its R2 blobs survive, or a purge deletes another install's or another
 *    Thread's blobs.
 * 7. A purge of an object that was never used, or was purged already,
 *    throws instead of doing nothing.
 * 8. After a purge the object still answers with its old state, or its
 *    alarm fires again.
 *
 * Re-enable:
 * 9. Jobs paused while the install was off stay paused after it is back,
 *    because the object keeps believing a cached "disabled".
 */

const stubFor = (name: string) =>
  env.PLUGIN_DURABLE_HOST.get(env.PLUGIN_DURABLE_HOST.idFromName(name));

const metaFor = (installId: string, threadId?: string): DurableMeta => ({
  installId,
  pluginName: "com.example.lifecycle",
  displayName: "Lifecycle",
  scope: "personal",
  targetId: "usr_lifecycle",
  version: "1.0.0",
  integrity: "sha256-lifecycle",
  ownerUserId: "usr_lifecycle",
  ...(threadId === undefined ? {} : { threadId }),
  tier: "personal-dev",
  workspaceId: "",
  jobs: [{ id: "tick", title: "Tick", schedule: { every: "1m" } }],
  durableScope: threadId === undefined ? "install" : "thread",
});

/** D1 whose usage inserts fail, as during a D1 outage. */
const failingUsageDb = (db: D1Database): D1Database =>
  new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "prepare")
        return Reflect.get(target, property, receiver);
      return (sql: string) =>
        sql.includes("INSERT INTO plugin_host_usage")
          ? {
              bind: () => ({
                run: () => Promise.reject(new Error("D1 is unavailable.")),
              }),
            }
          : target.prepare(sql);
    },
  });

const usageRows = async (pluginId: string) =>
  (
    await env.DB.prepare(
      "SELECT requests, period_start FROM plugin_host_usage WHERE plugin_id = ? ORDER BY period_end",
    )
      .bind(pluginId)
      .all<{ requests: number; period_start: string }>()
  ).results;

afterEach(async () => {
  await env.DB.prepare(
    "DELETE FROM plugin_host_usage WHERE plugin_id LIKE 'plg_lifecycle_%'",
  ).run();
});

describe("durable host usage", () => {
  it("keeps the counts and period when the D1 write fails, then writes them once", async () => {
    const installId = "plg_lifecycle_usage";
    const meta = metaFor(installId);
    const startedBefore = new Date().toISOString();
    await runInDurableObject(stubFor(installId), async (_object, state) => {
      const failing = new PluginDurableHost(state, {
        ...env,
        DB: failingUsageDb(env.DB),
      } as unknown as Bindings);
      for (let call = 0; call < 3; call += 1)
        await failing.sqlExec(meta, "SELECT 1", []);
      // 2: the failed write does not escape stop().
      await expect(failing.stop("idle")).resolves.toBeUndefined();
      expect(await usageRows(installId)).toEqual([]);

      const working = new PluginDurableHost(state, env as unknown as Bindings);
      await working.stop("idle");
      // 4: a flush with nothing new pending writes nothing.
      await working.stop("idle");
    });
    const rows = await usageRows(installId);
    // 1 and 4: the three requests, once.
    expect(rows.map(({ requests }) => requests)).toEqual([3]);
    // 3: the period starts where the object started counting.
    expect(rows[0]?.period_start <= new Date().toISOString()).toBe(true);
    expect(
      Date.parse(rows[0]?.period_start ?? "") <=
        Date.parse(startedBefore) + 1_000,
    ).toBe(true);
  });
});

describe("durable host purge", () => {
  const blobKeys = async (prefix: string) =>
    (await env.DX_STORAGE.list({ prefix })).objects.map(({ key }) => key);

  it("empties the object and deletes only its own blobs, and does it again harmlessly", async () => {
    const installId = "plg_lifecycle_purge";
    const thread = "thr_lifecycle_a";
    const other = "thr_lifecycle_b";
    for (const threadId of [thread, other]) {
      const stub = stubFor(`${installId}/${threadId}`);
      const meta = metaFor(installId, threadId);
      await stub.sqlExec(meta, "CREATE TABLE notes (body TEXT)", []);
      await stub.sqlExec(meta, "INSERT INTO notes VALUES (?)", ["kept"]);
      await stub.blobPut(meta, "frame.txt", "frame", "text/plain");
    }
    expect(await blobKeys(`plugins/${installId}/`)).toHaveLength(2);

    const stub = stubFor(`${installId}/${thread}`);
    const purged = await stub.purge(installId, thread);
    expect(purged.blobs).toBe(1);
    // 6: only that Thread's blobs.
    expect(await blobKeys(`plugins/${installId}/${thread}/`)).toEqual([]);
    expect(await blobKeys(`plugins/${installId}/${other}/`)).toHaveLength(1);
    // 5 and 8: no table, no meta, and no alarm left.
    await runInDurableObject(stub, async (_object, state) => {
      const tables = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'",
        )
        .toArray()
        .map(({ name }) => name);
      expect(tables).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
    // 7: a second purge, and one of an object never used, do nothing.
    expect(await stub.purge(installId, thread)).toMatchObject({
      wasEmpty: true,
      blobs: 0,
    });
    expect(
      await stubFor(`${installId}/thr_never`).purge(installId, "thr_never"),
    ).toMatchObject({ wasEmpty: true, blobs: 0 });
    // 8: the object starts over clean when used again: the plugin's table
    // can be created anew.
    const meta = metaFor(installId, thread);
    await expect(
      stub.sqlExec(meta, "CREATE TABLE notes (body TEXT)", []),
    ).resolves.toMatchObject({ rows: [] });
    await stub.purge(installId, thread);
    await stubFor(`${installId}/${other}`).purge(installId, other);
  });
});

describe("durable host re-enable", () => {
  it("resumes jobs held while the install was off and forgets the cached state", async () => {
    const installId = "plg_lifecycle_enable";
    const meta = metaFor(installId);
    const stub = stubFor(installId);
    await stub.ensure(meta);
    // As the alarm does when the install is off: the due job is held.
    await runInDurableObject(stub, async (_object, state) => {
      state.storage.sql.exec(
        "UPDATE _dx_jobs SET status = 'paused', next_at = NULL, last_outcome = 'uninstalled' WHERE id = 'tick'",
      );
    });
    // 9: re-enabling resumes it with a next run.
    expect(await stub.resumeInstall()).toBe(1);
    const view = await stub.jobsView(meta);
    const tick = view.jobs.find((job) => job.id === "tick");
    expect(tick?.status).toBe("scheduled");
    expect(tick?.nextRunAt).toBeGreaterThan(Date.now());
    await stub.purge(installId, undefined);
  });
});

/*
 * The SQL quota (security). Ways it could fail:
 * 10. One statement that starts under the quota (a recursive insert of
 *     random blobs) grows storage past it, because the check runs only
 *     before the statement.
 * 11. The refused statement leaves part of its rows behind.
 * 12. Reads and small writes under the quota are refused too.
 */
describe("durable host SQL quota", () => {
  it("rolls back a write that would cross the quota and leaves the size unchanged", async () => {
    const installId = "plg_lifecycle_quota";
    const meta = metaFor(installId);
    await runInDurableObject(stubFor(installId), async (_object, state) => {
      const host = new PluginDurableHost(state, {
        ...env,
        // A 256 KiB SQL quota for personal-dev on this test host.
        DX_PLUGIN_TIER_LIMITS: JSON.stringify({
          "personal-dev": { storageSqlBytes: 262_144 },
        }),
      } as unknown as Bindings);
      await host.sqlExec(meta, "CREATE TABLE blobs (body BLOB)", []);
      // 12: a small write under the quota goes through.
      await host.sqlExec(
        meta,
        "INSERT INTO blobs VALUES (randomblob(1000))",
        [],
      );
      const before = state.storage.sql.databaseSize;
      // 10: about 2 MB in one statement, from well under the quota.
      await expect(
        host.sqlExec(
          meta,
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
           INSERT INTO blobs SELECT randomblob(1000) FROM n`,
          [],
        ),
      ).rejects.toThrow(/quota/);
      // 11: nothing of it stays.
      const rows = await host.sqlExec(
        meta,
        "SELECT count(*) AS n FROM blobs",
        [],
      );
      expect(rows.rows).toEqual([{ n: 1 }]);
      expect(state.storage.sql.databaseSize).toBeLessThanOrEqual(before);
      await host.purge(installId, undefined);
    });
  });
});

/*
 * The Plugins page's jobs for a workspace install, seen by two members.
 * Ways it could leak or mislead:
 * 13. A member who may only read the plugin sees another member's Thread
 *     ids, their jobs, or their errors.
 * 14. That member sees the targets of the plugin's open watches (which
 *     can carry tokens in their URLs).
 * 15. The member loses their own Threads' jobs, or an admin (who may
 *     change the plugin) loses anyone's.
 * 16. Stopping or starting a job leaves no audit row naming who and which.
 */
describe("workspace jobs view and actions", () => {
  it("shows a reading member only their own Threads' jobs, without errors or watch targets, and audits Stop", async () => {
    const { pluginJobAction, pluginJobsView } = await import(
      "../../src/plugins/hosts/durable/jobs-route.js"
    );
    const installId = "plg_lifecycle_view";
    const workspaceId = "org_lifecycle_view";
    const [admin, member] = ["usr_lifecycle_admin", "usr_lifecycle_member"];
    const [adminThread, memberThread] = [
      "thr_lifecycle_admin",
      "thr_lifecycle_member",
    ];
    const at = "2026-11-13T00:00:00.000Z";
    await env.DB.batch([
      ...[admin, member].map((user) =>
        env.DB.prepare(
          'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
        ).bind(user, user, `${user}@example.com`),
      ),
      env.DB.prepare(
        `INSERT INTO projects (id, owner_user_id, workspace_id, name, runner_profile_id, created_at, updated_at)
         VALUES ('prj_lifecycle_view', ?, NULL, 'View', 'a1.medium', ?, ?)`,
      ).bind(admin, at, at),
      ...[
        [adminThread, admin],
        [memberThread, member],
      ].map(([id, owner]) =>
        env.DB.prepare(
          "INSERT INTO threads (id, project_id, owner_user_id, title, created_at, updated_at) VALUES (?, 'prj_lifecycle_view', ?, ?, ?, ?)",
        ).bind(id, owner, `${owner}'s Thread`, at, at),
      ),
    ]);
    const bundle = {
      id: installId,
      target: { scope: "workspace", id: workspaceId },
      name: "com.example.lifecycle",
      enabled: true,
      version: "1.0.0",
      integrity: "sha256-lifecycle",
      installedByUserId: admin,
      manifest: {
        displayName: "Lifecycle",
        code: {
          apiVersion: 1,
          host: "worker",
          entry: "dev.dxcode/index.js",
          modules: [],
          permissions: {
            events: [],
            network: ["stream.example.com"],
            secrets: [],
            tools: [],
            ai: false,
          },
          settings: [],
          durableScope: "thread",
          jobs: [{ id: "tick", title: "Tick", schedule: { every: "1m" } }],
        },
      },
    } as never;
    // Each Thread's object reported a failing job to the install's object.
    const install = stubFor(installId);
    const installMeta = {
      ...metaFor(installId),
      scope: "workspace",
      targetId: workspaceId,
      ownerUserId: admin,
      tier: "workspace-trusted",
      workspaceId,
    } as DurableMeta;
    for (const [threadId, error] of [
      [adminThread, "token sk-admin-secret refused"],
      [memberThread, "member's own error"],
    ] as const)
      await install.reportThreadJobs(installMeta, threadId, [
        {
          id: "tick",
          title: "Tick",
          schedule: { every: "1m" },
          status: "scheduled",
          runs: 1,
          lastOutcome: "failed",
          lastError: error,
          threadId,
        },
      ]);
    const view = (viewerUserId: string, canMutate: boolean) =>
      pluginJobsView({
        bindings: env as unknown as Bindings,
        bundle,
        viewerUserId,
        canMutate,
        requestId: "req_lifecycle",
      });

    const reader = await view(member, false);
    const readerThreadJobs = reader.jobs.filter(
      (job) => job.threadId !== undefined,
    );
    // 13 and 15: only the member's own Thread, and no error text.
    expect(readerThreadJobs.map((job) => job.threadId)).toEqual([memberThread]);
    expect(reader.jobs.some((job) => "lastError" in job)).toBe(false);
    // 14: no watch targets.
    expect(reader.watches.every((watch) => watch.target === "")).toBe(true);

    // 15: an admin who may change the plugin still sees every Thread's jobs.
    const owner = await view(admin, true);
    expect(
      owner.jobs
        .flatMap((job) => (job.threadId === undefined ? [] : [job.threadId]))
        .sort(),
    ).toEqual([adminThread, memberThread].sort());
    expect(
      owner.jobs.some(
        (job) => job.lastError === "token sk-admin-secret refused",
      ),
    ).toBe(true);

    // 16: Stop writes an audit row with the actor and job@thread.
    await pluginJobAction({
      bindings: env as unknown as Bindings,
      bundle,
      viewerUserId: admin,
      requestId: "req_lifecycle_stop",
      action: "stop",
      jobId: "tick",
      threadId: memberThread,
    });
    const audit = await env.DB.prepare(
      "SELECT action, target, outcome, owner_user_id FROM plugin_audit WHERE plugin_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(installId)
      .first();
    expect(audit).toEqual({
      action: "job.stop",
      target: `tick@${memberThread}`,
      outcome: "success",
      owner_user_id: admin,
    });

    for (const name of [installId, `${installId}/${memberThread}`])
      await stubFor(name).purge(
        installId,
        name.includes("/") ? memberThread : undefined,
      );
  });
});
