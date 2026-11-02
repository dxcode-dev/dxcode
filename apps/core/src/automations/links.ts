import type { FilterKind, PullSubject, SubscriptionFilter } from "./github.js";

/**
 * The GitHub issues and pull requests a Thread works on (D1
 * `thread_github_link`). A comment subscription links its issue or PR, and
 * so does the agent's `link_github_issue`; the link outlives the
 * subscription. Webhooks keep each link's title and state, so the header
 * never reads GitHub.
 */
export type LinkKind = "issue" | "pull";

export interface LinkRow {
  readonly repository: string;
  readonly number: number;
  readonly kind: LinkKind;
  readonly subject_json: string | null;
  readonly created_at: string;
}

/** The issue or PR a comment subscription follows, if it follows one. */
export const linkOfSubscription = (
  kind: FilterKind,
  filter: SubscriptionFilter,
): { readonly number: number; readonly kind: LinkKind } | undefined =>
  kind === "pr-comments" && filter.prNumber !== undefined
    ? { number: filter.prNumber, kind: "pull" }
    : kind === "issue-comments" && filter.issueNumber !== undefined
      ? { number: filter.issueNumber, kind: "issue" }
      : undefined;

/**
 * Links the Thread to an issue or PR. Linking it again keeps the saved
 * title; a known kind or subject replaces the saved one.
 */
export const linkThreadStatement = (
  db: D1Database,
  link: {
    readonly threadId: string;
    readonly repository: string;
    readonly number: number;
    readonly kind: LinkKind;
    readonly subject?: PullSubject | undefined;
  },
  now = new Date(),
) =>
  db
    .prepare(
      `INSERT INTO thread_github_link (
         thread_id, repository, repository_key, number, kind, subject_json,
         created_at
       ) VALUES (?1, ?2, lower(?2), ?3, ?4, ?5, ?6)
       ON CONFLICT (thread_id, repository_key, number) DO UPDATE SET
         kind = excluded.kind,
         subject_json = COALESCE(excluded.subject_json,
                                 thread_github_link.subject_json)`,
    )
    .bind(
      link.threadId,
      link.repository,
      link.number,
      link.kind,
      link.subject === undefined ? null : JSON.stringify(link.subject),
      now.toISOString(),
    );

/** Links the Thread to an issue or PR; see `linkThreadStatement`. */
export const linkThread = (
  db: D1Database,
  link: Parameters<typeof linkThreadStatement>[1],
  now = new Date(),
) => linkThreadStatement(db, link, now).run();

/** Links the Thread and returns its links, in one round trip. */
export const linkThreadAndList = async (
  db: D1Database,
  link: Parameters<typeof linkThreadStatement>[1],
  now = new Date(),
) => {
  const [, links] = await db.batch([
    linkThreadStatement(db, link, now),
    threadLinksStatement(db, link.threadId),
  ]);
  return (links?.results ?? []) as LinkRow[];
};

/** A webhook's title and state for every Thread linked to the item. */
export const saveLinkSubjectStatement = (
  db: D1Database,
  repository: string,
  number: number,
  kind: LinkKind,
  subject: PullSubject,
) =>
  db
    .prepare(
      `UPDATE thread_github_link SET kind = ?3, subject_json = ?4
        WHERE repository_key = lower(?1) AND number = ?2`,
    )
    .bind(repository, number, kind, JSON.stringify(subject));

/** See `saveLinkSubjectStatement`. */
export const saveLinkSubject = (
  db: D1Database,
  repository: string,
  number: number,
  kind: LinkKind,
  subject: PullSubject,
) => saveLinkSubjectStatement(db, repository, number, kind, subject).run();

const threadLinksStatement = (db: D1Database, threadId: string) =>
  db
    .prepare(
      `SELECT repository, number, kind, subject_json, created_at
         FROM thread_github_link WHERE thread_id = ?1
        ORDER BY created_at DESC, repository_key, number
        LIMIT 50`,
    )
    .bind(threadId);

/** The Thread's links, newest first. */
export const threadLinks = async (db: D1Database, threadId: string) =>
  (await threadLinksStatement(db, threadId).all<LinkRow>()).results;
