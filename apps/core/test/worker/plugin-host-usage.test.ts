import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  purgeExpiredPluginHostUsage,
  recordPluginHostUsage,
} from "../../src/plugins/hosts/usage.js";

// Who pays for plugin host time, and how long the rows are kept.

const now = Date.UTC(2026, 10, 13, 12);

const seed = async (suffix: string) => {
  const user = `phu-user-${suffix}`;
  const workspace = `phu-ws-${suffix}`;
  const other = `phu-other-${suffix}`;
  const project = `prj_phu-${suffix}`;
  const thread = `thr_phu-${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
    ).bind(user, "Payer", `${user}@example.com`),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1), (?, ?, ?, 1)",
    ).bind(workspace, "Payer", workspace, other, "Other", other),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', 1)",
    ).bind(`mem-${suffix}`, workspace, user),
    env.DB.prepare(
      `INSERT INTO projects (id, owner_user_id, workspace_id, name, created_at, updated_at)
       VALUES (?, ?, ?, 'Other workspace', 1, 1)`,
    ).bind(project, user, other),
  ]);
  return { user, workspace, other, project, thread };
};

const usage = (
  ownerUserId: string,
  extra: { workspaceId?: string; threadId?: string; at?: number } = {},
) => ({
  pluginId: "plg_phu",
  pluginName: "com.example.phu",
  scope: "personal" as const,
  ownerUserId,
  ...(extra.workspaceId === undefined
    ? {}
    : { workspaceId: extra.workspaceId }),
  ...(extra.threadId === undefined ? {} : { threadId: extra.threadId }),
  host: "container" as const,
  unitsMs: 1_000,
  costMicroUsd: 8,
  outcome: "success" as const,
  periodStart: (extra.at ?? now) - 1_000,
  periodEnd: extra.at ?? now,
});

const payers = (ownerUserId: string) =>
  env.DB.prepare(
    "SELECT workspace_id FROM plugin_host_usage WHERE owner_user_id = ? ORDER BY period_end",
  )
    .bind(ownerUserId)
    .all<{ workspace_id: string | null }>()
    .then((rows) => rows.results.map((row) => row.workspace_id));

describe("plugin host usage", () => {
  it("bills a personal install to the given workspace, else the person's workspace", async () => {
    const { user, workspace, other } = await seed("payer");
    await recordPluginHostUsage(
      env.DB,
      usage(user, { workspaceId: other, at: now }),
    );
    await recordPluginHostUsage(env.DB, usage(user, { at: now + 1 }));
    await recordPluginHostUsage(env.DB, usage(user, { at: now + 2 }));
    expect(await payers(user)).toEqual([other, workspace, workspace]);
  });

  it("bills a Thread's usage to the workspace of the Thread's Project", async () => {
    const { user, other, project, thread } = await seed("thread");
    await env.DB.prepare(
      `INSERT INTO threads (id, project_id, owner_user_id, title, created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, 'Thread', 1, 1, 1)`,
    )
      .bind(thread, project, user)
      .run();
    await recordPluginHostUsage(env.DB, usage(user, { threadId: thread }));
    expect(await payers(user)).toEqual([other]);
  });

  it("purges only rows past the retention window", async () => {
    const { user } = await seed("purge");
    const old = Date.UTC(2026, 0, 1);
    await recordPluginHostUsage(env.DB, usage(user, { at: old }));
    await recordPluginHostUsage(env.DB, usage(user, { at: now }));
    // 180 days after the old row's end, before the new row's.
    const purged = await purgeExpiredPluginHostUsage(
      env.DB,
      new Date(old + 181 * 86_400_000).toISOString(),
    );
    expect(purged.meta.changes).toBe(1);
    const left = await env.DB.prepare(
      "SELECT period_end FROM plugin_host_usage WHERE owner_user_id = ?",
    )
      .bind(user)
      .all<{ period_end: string }>();
    expect(left.results).toEqual([{ period_end: new Date(now).toISOString() }]);
  });
});
