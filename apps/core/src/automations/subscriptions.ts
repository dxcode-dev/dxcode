import { sha256Hex } from "../threads/agent-tools.js";
import {
  describeTarget,
  type FilterKind,
  type GitHubEvent,
  type PullSubject,
  type SubscriptionFilter,
} from "./github.js";
import { linkOfSubscription, linkThread, saveLinkSubject } from "./links.js";

/** A GitHub event subscription (D1 `github_subscription`). */
export interface SubscriptionRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly thread_id: string;
  readonly title: string;
  readonly repository: string;
  readonly filter_kind: FilterKind;
  readonly filter_json: string;
  readonly destination: "this-thread" | "new-thread";
  readonly project_id: string | null;
  readonly agent_mode: string | null;
  readonly instructions: string | null;
  readonly automatic: number;
  readonly enabled: number;
  readonly state: "active" | "finished" | "expired" | "failed";
  readonly state_detail: string | null;
  readonly expires_at: string | null;
  readonly equivalence_key: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const COLUMNS = `id, owner_user_id, thread_id, title, repository, filter_kind,
  filter_json, destination, project_id, agent_mode, instructions, automatic,
  enabled, state, state_detail, expires_at, equivalence_key, created_at,
  updated_at`;

/** CI and comment subscriptions end after this unless given an expiry. */
export const DEFAULT_LIFETIME_MS = 30 * 24 * 60 * 60_000;

export const filterOf = (row: SubscriptionRow) =>
  JSON.parse(row.filter_json) as SubscriptionFilter;

export interface SubscriptionInput {
  readonly title: string;
  readonly repository: string;
  readonly kind: FilterKind;
  readonly filter: SubscriptionFilter;
  readonly destination: "this-thread" | "new-thread";
  readonly threadId: string;
  readonly projectId: string | null;
  readonly agentMode: string | null;
  readonly instructions: string | null;
  readonly automatic: boolean;
  readonly expiresAt: string | null;
}

/**
 * Names a subscription by what it watches and where it delivers, so
 * creating it again finds the saved one. An automatic CI follow-up is
 * named by its branch instead of its commit: each push moves it on.
 */
export const equivalenceKey = (
  ownerUserId: string,
  input: SubscriptionInput,
) => {
  const { commitSha, ...filter } = input.filter;
  return sha256Hex(
    JSON.stringify([
      ownerUserId,
      input.threadId,
      input.repository.toLowerCase(),
      input.kind,
      input.automatic && input.kind === "ci" ? filter : input.filter,
      input.destination,
      input.automatic,
      input.automatic && input.kind === "ci" ? "" : (commitSha ?? ""),
    ]),
  );
};

export const readSubscription = (db: D1Database, id: string) =>
  db
    .prepare(`SELECT ${COLUMNS} FROM github_subscription WHERE id = ?`)
    .bind(id)
    .first<SubscriptionRow>();

export const listOwnerSubscriptions = async (
  db: D1Database,
  ownerUserId: string,
  threadId?: string,
) =>
  (
    await db
      .prepare(
        `SELECT ${COLUMNS.replaceAll(/\b(\w+)\b/g, "s.$1")}, t.title AS thread_title,
           (SELECT MAX(created_at) FROM github_subscription_event AS e
             WHERE e.subscription_id = s.id) AS last_event_at,
           (SELECT summary FROM github_subscription_event AS e
             WHERE e.subscription_id = s.id
             ORDER BY created_at DESC LIMIT 1) AS last_event_summary,
           (SELECT event_key FROM github_subscription_event AS e
             WHERE e.subscription_id = s.id
               AND (event_key GLOB 'merged:*' OR event_key GLOB 'closed:*'
                    OR event_key GLOB 'reopened:*')
             ORDER BY created_at DESC LIMIT 1) AS last_lifecycle_key,
           s.subject_json
           FROM github_subscription AS s
           JOIN threads AS t ON t.id = s.thread_id
          WHERE s.owner_user_id = ?1 AND t.lifecycle_state != 'deleted'
            ${threadId === undefined ? "" : "AND s.thread_id = ?2"}
          ORDER BY s.created_at DESC
          LIMIT 200`,
      )
      .bind(ownerUserId, ...(threadId === undefined ? [] : [threadId]))
      .all<
        SubscriptionRow & {
          thread_title: string;
          last_event_at: string | null;
          last_event_summary: string | null;
          last_lifecycle_key: string | null;
          subject_json: string | null;
        }
      >()
  ).results;

export const recentEvents = async (db: D1Database, id: string) =>
  (
    await db
      .prepare(
        `SELECT event_key, summary, url, status, delivered_thread_id, created_at
           FROM github_subscription_event WHERE subscription_id = ?
          ORDER BY created_at DESC LIMIT 20`,
      )
      .bind(id)
      .all<{
        event_key: string;
        summary: string;
        url: string | null;
        status: string;
        delivered_thread_id: string | null;
        created_at: string;
      }>()
  ).results;

export const subscriptionView = (row: SubscriptionRow) => ({
  subscriptionId: row.id,
  title: row.title,
  repository: row.repository,
  filterKind: row.filter_kind,
  watching: describeTarget(row.filter_kind, filterOf(row)),
  filter: filterOf(row),
  destination: row.destination,
  threadId: row.thread_id,
  ...(row.agent_mode === null ? {} : { agentMode: row.agent_mode }),
  ...(row.instructions === null ? {} : { instructions: row.instructions }),
  automatic: row.automatic === 1,
  enabled: row.enabled === 1,
  state: row.enabled === 1 || row.state !== "active" ? row.state : "paused",
  ...(row.state_detail === null ? {} : { stateDetail: row.state_detail }),
  ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  createdAt: row.created_at,
});

/** A this-thread comment subscription links its Thread to its issue or PR. */
const linkFollowed = async (
  db: D1Database,
  input: SubscriptionInput,
  now: Date,
) => {
  const link = linkOfSubscription(input.kind, input.filter);
  if (link === undefined || input.destination !== "this-thread") return;
  await linkThread(
    db,
    { threadId: input.threadId, repository: input.repository, ...link },
    now,
  );
};

/**
 * Saves a subscription, or returns the equivalent one already saved with
 * its paused state and instructions kept. An automatic CI follow-up on the
 * same branch moves to the new commit and starts watching again.
 */
export const createSubscription = async (
  db: D1Database,
  ownerUserId: string,
  input: SubscriptionInput,
  now = new Date(),
) => {
  const key = await equivalenceKey(ownerUserId, input);
  const at = now.toISOString();
  const existing = await db
    .prepare(
      `SELECT ${COLUMNS} FROM github_subscription
        WHERE owner_user_id = ? AND equivalence_key = ?`,
    )
    .bind(ownerUserId, key)
    .first<SubscriptionRow>();
  if (existing !== null) {
    const moved =
      input.automatic &&
      input.kind === "ci" &&
      filterOf(existing).commitSha !== input.filter.commitSha;
    if (moved || existing.state !== "active")
      await db
        .prepare(
          `UPDATE github_subscription
              SET filter_json = ?2, state = 'active', state_detail = NULL,
                  created_at = ?3, updated_at = ?3, expires_at = ?4
            WHERE id = ?1`,
        )
        .bind(existing.id, JSON.stringify(input.filter), at, input.expiresAt)
        .run();
    await linkFollowed(db, input, now);
    return {
      row: (await readSubscription(db, existing.id)) as SubscriptionRow,
      existed: true,
    };
  }
  const id = `ghs_${crypto.randomUUID().replaceAll("-", "")}`;
  await db
    .prepare(
      `INSERT INTO github_subscription (${COLUMNS})
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, 'active',
               NULL, ?13, ?14, ?15, ?15)`,
    )
    .bind(
      id,
      ownerUserId,
      input.threadId,
      input.title,
      input.repository,
      input.kind,
      JSON.stringify(input.filter),
      input.destination,
      input.projectId,
      input.agentMode,
      input.instructions,
      input.automatic ? 1 : 0,
      input.expiresAt,
      key,
      at,
    )
    .run();
  await linkFollowed(db, input, now);
  return {
    row: (await readSubscription(db, id)) as SubscriptionRow,
    existed: false,
  };
};

/** Replaces a subscription's configuration and watches from now. */
export const replaceSubscription = async (
  db: D1Database,
  current: SubscriptionRow,
  input: SubscriptionInput,
  enabled: boolean,
  now = new Date(),
) => {
  const at = now.toISOString();
  await db
    .prepare(
      `UPDATE github_subscription
          SET thread_id = ?2, title = ?3, repository = ?4, filter_kind = ?5,
              filter_json = ?6, destination = ?7, project_id = ?8,
              agent_mode = ?9, instructions = ?10, automatic = ?11,
              enabled = ?12, state = 'active', state_detail = NULL,
              expires_at = ?13, equivalence_key = ?14, created_at = ?15,
              updated_at = ?15
        WHERE id = ?1`,
    )
    .bind(
      current.id,
      input.threadId,
      input.title,
      input.repository,
      input.kind,
      JSON.stringify(input.filter),
      input.destination,
      input.projectId,
      input.agentMode,
      input.instructions,
      input.automatic ? 1 : 0,
      enabled ? 1 : 0,
      input.expiresAt,
      await equivalenceKey(current.owner_user_id, input),
      at,
    )
    .run();
  await linkFollowed(db, input, now);
  return readSubscription(db, current.id);
};

/**
 * Pauses or resumes. Webhooks that arrive while it is paused match nothing,
 * so resuming watches from now.
 */
export const setSubscriptionEnabled = async (
  db: D1Database,
  id: string,
  enabled: boolean,
  now = new Date(),
) => {
  const at = now.toISOString();
  await db
    .prepare(
      `UPDATE github_subscription
          SET enabled = ?2, updated_at = ?3
        WHERE id = ?1`,
    )
    .bind(id, enabled ? 1 : 0, at)
    .run();
  return readSubscription(db, id);
};

export const deleteSubscription = async (db: D1Database, id: string) =>
  (
    await db
      .prepare("DELETE FROM github_subscription WHERE id = ?")
      .bind(id)
      .run()
  ).meta.changes > 0;

/**
 * The repository's active subscriptions of these kinds, for a webhook to
 * match. Expired ones are ended here, when an event would have reached
 * them; the cron ends the rest.
 */
export const listeningSubscriptions = async (
  db: D1Database,
  repository: string,
  kinds: ReadonlyArray<FilterKind>,
  now: Date,
) => {
  const at = now.toISOString();
  const rows = (
    await db
      .prepare(
        `SELECT ${COLUMNS} FROM github_subscription
          WHERE repository = ?1 COLLATE NOCASE AND enabled = 1
            AND state = 'active'
            AND filter_kind IN (SELECT value FROM json_each(?2))
          LIMIT 200`,
      )
      .bind(repository, JSON.stringify(kinds))
      .all<SubscriptionRow>()
  ).results;
  return rows.filter((row) => row.expires_at === null || row.expires_at > at);
};

/**
 * Automatic CI follow-ups on a branch, finished ones too: a new push to it
 * starts them watching its new head.
 */
export const automaticCiOn = async (
  db: D1Database,
  repository: string,
  branch: string,
) =>
  (
    await db
      .prepare(
        `SELECT ${COLUMNS} FROM github_subscription
          WHERE repository = ?1 COLLATE NOCASE AND filter_kind = 'ci'
            AND automatic = 1 AND state IN ('active', 'finished')
            AND json_extract(filter_json, '$.branch') = ?2
          LIMIT 20`,
      )
      .bind(repository, branch)
      .all<SubscriptionRow>()
  ).results;

/**
 * Saves what the header shows of a pull request on every subscription and
 * Thread link that follows it: one write each per pull_request webhook, so
 * no view reads GitHub.
 */
export const savePullSubject = async (
  db: D1Database,
  repository: string,
  number: number,
  subject: PullSubject,
) => {
  await db
    .prepare(
      `UPDATE github_subscription SET subject_json = ?3
        WHERE repository = ?1 COLLATE NOCASE AND filter_kind = 'pr-comments'
          AND json_extract(filter_json, '$.prNumber') = ?2`,
    )
    .bind(repository, number, JSON.stringify(subject))
    .run();
  await saveLinkSubject(db, repository, number, "pull", subject);
};

/** The Thread's delivered CI results with their checks, newest first. */
export const threadCiResults = async (
  db: D1Database,
  ownerUserId: string,
  threadId: string,
) =>
  (
    await db
      .prepare(
        `SELECT s.repository, e.url, e.detail_json, e.created_at
           FROM github_subscription_event AS e
           JOIN github_subscription AS s ON s.id = e.subscription_id
          WHERE s.thread_id = ?1 AND s.owner_user_id = ?2
            AND s.filter_kind = 'ci' AND e.detail_json IS NOT NULL
          ORDER BY e.created_at DESC
          LIMIT 30`,
      )
      .bind(threadId, ownerUserId)
      .all<{
        repository: string;
        url: string | null;
        detail_json: string;
        created_at: string;
      }>()
  ).results;

/** Ends what passed its expiry. Returns how many. */
export const expireSubscriptions = async (db: D1Database, now: Date) =>
  (
    await db
      .prepare(
        `UPDATE github_subscription SET state = 'expired', updated_at = ?1
          WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at <= ?1`,
      )
      .bind(now.toISOString())
      .run()
  ).meta.changes;

/** Records events not seen before; returns the new ones. */
export const recordNewEvents = async (
  db: D1Database,
  id: string,
  events: ReadonlyArray<GitHubEvent>,
  now: Date,
) => {
  if (events.length === 0) return [];
  const results = await db.batch<{ event_key: string }>(
    events.map((event) =>
      db
        .prepare(
          `INSERT INTO github_subscription_event
             (subscription_id, event_key, summary, url, status, created_at,
              detail_json)
           VALUES (?1, ?2, ?3, ?4, 'delivered', ?5, ?6)
           ON CONFLICT DO NOTHING RETURNING event_key`,
        )
        .bind(
          id,
          event.key.slice(0, 200),
          event.label.slice(0, 500),
          event.url?.slice(0, 2000) ?? null,
          now.toISOString(),
          event.detail === undefined ? null : JSON.stringify(event.detail),
        ),
    ),
  );
  const fresh = new Set(
    results.flatMap((result) => result.results.map((row) => row.event_key)),
  );
  return events.filter((event) => fresh.has(event.key.slice(0, 200)));
};

export const markEvent = (
  db: D1Database,
  id: string,
  key: string,
  status: "delivered" | "started" | "failed",
  threadId?: string,
) =>
  db
    .prepare(
      `UPDATE github_subscription_event SET status = ?3, delivered_thread_id = ?4
        WHERE subscription_id = ?1 AND event_key = ?2`,
    )
    .bind(id, key.slice(0, 200), status, threadId ?? null)
    .run();

/** Ends a subscription with why: its PR merged, its CI finished. */
export const finishSubscription = (
  db: D1Database,
  id: string,
  state: "finished" | "failed",
  detail: string,
  now: Date,
) =>
  db
    .prepare(
      `UPDATE github_subscription
          SET state = ?2, state_detail = ?3, updated_at = ?4
        WHERE id = ?1 AND state = 'active'`,
    )
    .bind(id, state, detail.slice(0, 500), now.toISOString())
    .run();

/** Records why the last delivery failed, keeping the subscription active. */
export const noteDeliveryFailure = (
  db: D1Database,
  id: string,
  detail: string,
  now: Date,
) =>
  db
    .prepare(
      "UPDATE github_subscription SET state_detail = ?2, updated_at = ?3 WHERE id = ?1",
    )
    .bind(id, detail.slice(0, 500), now.toISOString())
    .run();
