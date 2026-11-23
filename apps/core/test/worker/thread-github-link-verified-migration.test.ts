import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";

/**
 * The migration that marks which issue and PR links the owner's GitHub
 * credentials verified, over a database that already holds links. It could
 * fail by verifying a link only link_github_issue saved (it may have had no
 * credentials), by leaving a comment subscription's link unverified, by
 * matching a subscription of another Thread, number, or kind, or by
 * changing or losing a link.
 */

const MIGRATION = "0227_thread_github_link_verified.sql";
const now = "2026-11-23T12:00:00.000Z";
const user = "usr-github-link-verified";
const project = "prj_00000000-0000-4000-8000-00000000b701";
const thread = (n: number) => `thr_00000000-0000-4000-8000-00000000b70${n}`;

it("verifies the links comment subscriptions made, and no other", async () => {
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
      .bind(user, user, "links@example.test", now, now),
    db
      .prepare(
        "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, 'dx', ?, ?)",
      )
      .bind(project, user, now, now),
    ...[1, 2].map((n) =>
      db
        .prepare(
          "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(thread(n), project, user, now, now),
    ),
  ]);
  let subscriptions = 0;
  const subscription = (n: number, kind: string, filter: object) => {
    subscriptions += 1;
    return db
      .prepare(
        `INSERT INTO github_subscription (id, owner_user_id, thread_id, title,
           repository, filter_kind, filter_json, destination, automatic,
           enabled, state, equivalence_key, created_at, updated_at)
         VALUES (?, ?, ?, 'Comments', 'Acme/Widgets', ?, ?, 'this-thread', 0,
           1, 'active', ?, ?, ?)`,
      )
      .bind(
        `ghs_${String(subscriptions).padStart(32, "0")}`,
        user,
        thread(n),
        kind,
        JSON.stringify(filter),
        String(subscriptions).padStart(64, "0"),
        now,
        now,
      );
  };
  const link = (n: number, number: number, kind: string) =>
    db
      .prepare(
        `INSERT INTO thread_github_link (thread_id, repository, repository_key,
           number, kind, subject_json, created_at)
         VALUES (?, 'acme/widgets', 'acme/widgets', ?, ?, '{"title":"T"}', ?)`,
      )
      .bind(thread(n), number, kind, now);
  await db.batch([
    // Thread 1 follows PR 5's and issue 6's comments.
    subscription(1, "pr-comments", { prNumber: 5 }),
    subscription(1, "issue-comments", { issueNumber: 6 }),
    // Thread 2 follows CI only.
    subscription(2, "ci", { commitSha: "a".repeat(40) }),
    link(1, 5, "pull"),
    link(1, 6, "issue"),
    // Only link_github_issue saved these.
    link(1, 7, "issue"),
    link(2, 5, "pull"),
  ]);

  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(index));

  expect(
    (
      await db
        .prepare(
          `SELECT thread_id, number, kind, subject_json, verified
             FROM thread_github_link ORDER BY thread_id, number`,
        )
        .all()
    ).results,
  ).toEqual(
    [
      [1, 5, "pull", 1],
      [1, 6, "issue", 1],
      [1, 7, "issue", 0],
      [2, 5, "pull", 0],
    ].map(([n, number, kind, verified]) => ({
      thread_id: thread(n as number),
      number,
      kind,
      subject_json: '{"title":"T"}',
      verified,
    })),
  );
});
