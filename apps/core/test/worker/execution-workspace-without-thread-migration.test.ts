import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";

/**
 * `*_execution_workspace_without_thread.sql` drops execution_workspace's
 * foreign key to threads so a plugin Orb
 * can have a row without a Thread. It could fail by losing or changing a
 * Thread's row, leaving the foreign key (a row without a Thread refused),
 * losing the cascade (a deleted Thread's row left behind), or dropping a
 * trigger (a new Thread gets no row, or a pinned Orb's pin can change).
 */

/** Found by name: its number moves when main gains migrations first. */
const MIGRATION = "_execution_workspace_without_thread.sql";
const owner = "usr-ew-0236";
const project = "prj_00000000-0000-4000-8000-000000000236";
const thread = (n: number) =>
  `thr_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-11-25T10:00:00.000Z";

const rows = async (db: D1Database) =>
  (
    await db
      .prepare(
        `SELECT thread_id, provider, state, provider_sandbox_id,
                runner_profile_id, account_scope, account_owner_id,
                provider_account, provider_template, ready_at
           FROM execution_workspace ORDER BY thread_id`,
      )
      .all()
  ).results;

it("keeps every row, allows a row without a Thread, and still cascades and guards", async () => {
  const db = env.MIGRATED_CHECK_DB;
  const index = env.TEST_MIGRATIONS.findIndex((migration) =>
    migration.name.endsWith(MIGRATION),
  );
  expect(index).toBeGreaterThan(0);
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, index));

  await db.batch([
    db
      .prepare(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
      )
      .bind(owner, owner, `${owner}@example.com`, 1, 1),
    db
      .prepare(
        `INSERT INTO projects (id, owner_user_id, workspace_id, name, runner_profile_id, created_at, updated_at)
         VALUES (?, ?, NULL, 'Migration', 'e2b.small', ?, ?)`,
      )
      .bind(project, owner, now, now),
    ...[1, 2, 3].map((n) =>
      db
        .prepare(
          "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(thread(n), project, owner, now, now),
    ),
    // Thread 2 is pinned to a person's own E2B account and running.
    db
      .prepare(
        `UPDATE execution_workspace
            SET runner_profile_id = 'e2b.small', account_scope = 'personal',
                account_owner_id = ?, provider_account = 'team-1',
                provider_template = 'tpl-1'
          WHERE thread_id = ?`,
      )
      .bind(owner, thread(2)),
    db
      .prepare(
        `UPDATE execution_workspace
            SET state = 'provisioning', initialization_attempt_id = 'att-1'
          WHERE thread_id = ?`,
      )
      .bind(thread(2)),
    db
      .prepare(
        `UPDATE execution_workspace
            SET state = 'initialized', provider_sandbox_id = 'sbx-1',
                initialization_attempt_id = NULL, ready_at = ?
          WHERE thread_id = ?`,
      )
      .bind(now, thread(2)),
  ]);
  const orphan = db
    .prepare(
      `INSERT INTO execution_workspace (thread_id, provider, state, created_at, updated_at)
       VALUES (?, 'e2b', 'uninitialized', ?, ?)`,
    )
    .bind(thread(9), now, now);
  await expect(orphan.run()).rejects.toThrow(/FOREIGN KEY/);
  const before = await rows(db);
  expect(before).toHaveLength(3);

  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(index));

  expect(await rows(db)).toEqual(before);

  // A plugin Orb's row: no Thread has its ID.
  await orphan.run();
  expect(await rows(db)).toHaveLength(4);

  // A new Thread still gets its row.
  await db
    .prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(thread(4), project, owner, now, now)
    .run();
  expect((await rows(db)).map((row) => row.thread_id)).toContain(thread(4));

  // The pin and the sandbox stay immutable.
  await expect(
    db
      .prepare(
        "UPDATE execution_workspace SET runner_profile_id = 'e2b.large' WHERE thread_id = ?",
      )
      .bind(thread(2))
      .run(),
  ).rejects.toThrow(/pin is immutable/);
  await expect(
    db
      .prepare(
        "UPDATE execution_workspace SET provider_sandbox_id = 'sbx-2' WHERE thread_id = ?",
      )
      .bind(thread(2))
      .run(),
  ).rejects.toThrow(/sandbox is immutable/);

  // Deleting a Thread deletes its row; the plugin Orb's row stays.
  await db.prepare("DELETE FROM threads WHERE id = ?").bind(thread(2)).run();
  const after = (await rows(db)).map((row) => row.thread_id);
  expect(after).not.toContain(thread(2));
  expect(after).toContain(thread(9));
  expect(after).toHaveLength(4);
});
