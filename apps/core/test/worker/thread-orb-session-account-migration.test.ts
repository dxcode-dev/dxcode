import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";

/**
 * The migration that records each Orb run's deployment account, over a
 * database that already holds runs. It could fail by leaving earlier runs
 * of a deployment account with no account, giving a run on a person's or
 * a workspace's own key a deployment account, or losing a run.
 */

const MIGRATION = "0225_thread_orb_session_account.sql";
const now = "2026-11-19T12:00:00.000Z";
const user = "usr-orb-session-account";
const project = "prj_00000000-0000-4000-8000-00000000ac01";
const thread = (n: number) => `thr_00000000-0000-4000-8000-00000000ac0${n}`;
const account = "oac_0000000000000000000000000000000000a1";

it("gives runs recorded before it their Thread's deployment account, and no other run one", async () => {
  const db = env.MIGRATED_CHECK_DB;
  const index = env.TEST_MIGRATIONS.findIndex(
    (migration) => migration.name === MIGRATION,
  );
  expect(index).toBeGreaterThan(0);
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, index));

  await db.batch([
    db
      .prepare(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
      )
      .bind(user, user, "orbs@example.test", now, now),
    db
      .prepare(
        "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, 'dx', ?, ?)",
      )
      .bind(project, user, now, now),
    ...[1, 2, 3].map((n) =>
      db
        .prepare(
          "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(thread(n), project, user, now, now),
    ),
  ]);
  // Thread 1 runs on a deployment account, 2 on the person's own key, 3 on
  // the deployment's default provider settings (no account).
  const pin = (n: number, scope: string, owner: string | null) =>
    db
      .prepare(
        `UPDATE execution_workspace
            SET provider = 'agent37', runner_profile_id = 'a37.small',
                account_scope = ?, account_owner_id = ?,
                provider_account = ?, provider_template = 'dx-orb-test',
                updated_at = ?
          WHERE thread_id = ?`,
      )
      .bind(scope, owner, owner === null ? null : "acct", now, thread(n));
  const run = (n: number, startedAt: number) =>
    db
      .prepare(
        `INSERT INTO thread_orb_session
           (thread_id, started_at, ended_at, provider, runner_profile_id,
            billing, cost_micros)
         VALUES (?, ?, ?, 'agent37', 'a37.small', ?, 1000)`,
      )
      .bind(
        thread(n),
        startedAt,
        startedAt + 3_600_000,
        n === 2 ? "personal" : "deployment",
      );
  await db.batch([
    pin(1, "deployment", account),
    pin(2, "personal", user),
    pin(3, "deployment", null),
    run(1, 1_000),
    run(1, 10_000_000),
    run(2, 1_000),
    run(3, 1_000),
  ]);

  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(index));

  expect(
    (
      await db
        .prepare(
          `SELECT thread_id, started_at, deployment_account_id
             FROM thread_orb_session ORDER BY thread_id, started_at`,
        )
        .all()
    ).results,
  ).toEqual([
    { thread_id: thread(1), started_at: 1_000, deployment_account_id: account },
    {
      thread_id: thread(1),
      started_at: 10_000_000,
      deployment_account_id: account,
    },
    { thread_id: thread(2), started_at: 1_000, deployment_account_id: null },
    { thread_id: thread(3), started_at: 1_000, deployment_account_id: null },
  ]);
});
