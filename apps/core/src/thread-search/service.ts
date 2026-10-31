import {
  parseThreadSearchQuery,
  type ThreadSearchFilters,
  ThreadSearchQueryError,
} from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { threadProjectReachableSql } from "../settings/members/membership-sql.js";
import { sharedThreadVisibleSql } from "../thread-sharing/access.js";
import { ownerSearchIndex } from "./index-client.js";
import { queryTerms, snippetTerm } from "./terms.js";

/**
 * Thread search: D1 decides which Threads a searcher may see and applies the
 * metadata filters; each owner's search index (a Durable Object, never D1)
 * matches keywords. Results are ordered by last activity, newest first, as
 * with a keyset cursor.
 */

export const THREAD_SEARCH_DEFAULT_LIMIT = 20;
export const THREAD_SEARCH_MAX_LIMIT = 100;
/** With `id:` or `parent:`, keywords are checked only on these candidates. */
const CANDIDATE_MAX = 500;

export interface ThreadSearchScope {
  /** The searcher: their own reachable Threads and Threads shared with them. */
  readonly userId: string;
  /**
   * From a shared Thread, of the searcher's own Threads only this family
   * (the root and its children) is visible; shared Threads stay visible.
   */
  readonly familyRoot?: string;
}

export interface ThreadSearchRow {
  readonly id: string;
  readonly title: string;
  readonly project_id: string;
  readonly project_name: string;
  readonly owner_user_id: string;
  readonly owner_name: string;
  readonly parent_thread_id: string | null;
  readonly color: string | null;
  readonly lifecycle_state: "active" | "archived";
  readonly activity_status: "idle" | "working";
  readonly pinned_at: string | null;
  readonly snoozed_until: string | null;
  readonly workspace_access: string | null;
  /** 1 when the Project was deleted and the Thread kept, else 0. */
  readonly project_deleted: number;
  /** 1 when the Project's workspace was deleted, else 0. */
  readonly workspace_deleted: number;
  readonly created_at: string;
  readonly activity_at: string;
}

export interface ThreadSearchHit extends ThreadSearchRow {
  readonly matchedSearchText?: string;
}

export interface ThreadSearchResult {
  readonly items: ReadonlyArray<ThreadSearchHit>;
  readonly nextCursor?: string;
  /** Billable work this search did, for tests and logs. */
  readonly cost: {
    readonly d1RowsRead: number;
    /** Rows the indexes read to match keywords. */
    readonly indexRowsRead: number;
    /** Rows the indexes read to excerpt the returned page. */
    readonly snippetRowsRead: number;
    readonly indexesQueried: number;
  };
}

export class ThreadSearchUnavailable extends Error {
  override readonly name = "ThreadSearchUnavailable";
}

type SqlValue = string | number | null;

class Parameters {
  readonly values: SqlValue[] = [];
  add(value: SqlValue) {
    this.values.push(value);
    return `?${this.values.length}`;
  }
}

interface Cursor {
  readonly activityAt: string;
  readonly id: string;
}

const encodeCursor = (cursor: Cursor) =>
  btoa(JSON.stringify([cursor.activityAt, cursor.id]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const decodeCursor = (value: string): Cursor => {
  try {
    const decoded = JSON.parse(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    ) as unknown;
    if (
      Array.isArray(decoded) &&
      decoded.length === 2 &&
      typeof decoded[0] === "string" &&
      typeof decoded[1] === "string"
    )
      return { activityAt: decoded[0], id: decoded[1] };
  } catch {
    // Reported below.
  }
  throw new ThreadSearchQueryError("The cursor is invalid; search again.");
};

const ACTIVITY = "COALESCE(thread.last_activity_at, thread.created_at)";

const accessClause = (scope: ThreadSearchScope, parameters: Parameters) => {
  const user = parameters.add(scope.userId);
  const family =
    scope.familyRoot === undefined
      ? ""
      : (() => {
          const root = parameters.add(scope.familyRoot);
          return ` AND (thread.id = ${root} OR thread.parent_thread_id = ${root})`;
        })();
  // A Thread kept from a deleted Project (or workspace) stays with its owner
  // alone, whatever their membership, as `GET /threads/:id` reads it.
  return `((thread.owner_user_id = ${user}
      AND (project.deleted_at IS NOT NULL
        OR ${threadProjectReachableSql("project", user)})${family})
    OR ${sharedThreadVisibleSql("thread", "project", user)})`;
};

const filterClauses = (
  filters: ThreadSearchFilters,
  scope: ThreadSearchScope,
  parameters: Parameters,
) => {
  const clauses: string[] = [];
  if (filters.id !== undefined)
    clauses.push(`thread.id = ${parameters.add(filters.id)}`);
  if (filters.parent !== undefined)
    clauses.push(`thread.parent_thread_id = ${parameters.add(filters.parent)}`);
  if (filters.project !== undefined) {
    const project = parameters.add(filters.project);
    clauses.push(
      `(project.id = ${project} OR lower(project.name) = lower(${project}))`,
    );
  }
  if (filters.author !== undefined) {
    if (filters.author === "me")
      clauses.push(`thread.owner_user_id = ${parameters.add(scope.userId)}`);
    else {
      const author = parameters.add(filters.author);
      clauses.push(`thread.owner_user_id IN (
        SELECT id FROM "user" WHERE lower(email) = ${author} OR lower(name) = ${author}
        UNION SELECT user_id FROM personal_account WHERE username = ${author})`);
    }
  }
  if (filters.visibility === "private")
    clauses.push("COALESCE(thread.workspace_access, 'none') = 'none'");
  else if (filters.visibility === "workspace")
    clauses.push("thread.workspace_access IN ('view', 'contribute')");
  else if (filters.visibility === "none") clauses.push("0");
  if (filters.repo !== undefined)
    clauses.push(`EXISTS (SELECT 1 FROM thread_source_snapshot AS source
      WHERE source.thread_id = thread.id
        AND lower(source.repository_full_name) = ${parameters.add(filters.repo)})`);
  if (filters.issue !== undefined)
    clauses.push(`EXISTS (SELECT 1 FROM thread_github_link AS link
      WHERE link.thread_id = thread.id
        AND link.repository_key = ${parameters.add(filters.issue.repository)}
        AND link.number = ${parameters.add(filters.issue.number)})`);
  if (filters.pinned !== undefined)
    clauses.push(
      filters.pinned
        ? "thread.pinned_at IS NOT NULL"
        : "thread.pinned_at IS NULL",
    );
  if (filters.snoozed !== undefined) {
    // Only the owner sees a snooze; another member's Thread is never snoozed.
    // IS NOT NULL keeps the clause false, not NULL, so NOT matches the rest.
    const snoozed = `(thread.owner_user_id = ${parameters.add(scope.userId)}
      AND thread.lifecycle_state = 'active'
      AND thread.snoozed_until IS NOT NULL
      AND thread.snoozed_until > ${parameters.add(new Date().toISOString())})`;
    clauses.push(filters.snoozed ? snoozed : `NOT ${snoozed}`);
  }
  if (filters.archived !== undefined)
    clauses.push(
      `thread.lifecycle_state = '${filters.archived ? "archived" : "active"}'`,
    );
  if (filters.color !== undefined)
    clauses.push(
      filters.color === "auto"
        ? "thread.color IS NULL"
        : `thread.color = ${parameters.add(filters.color)}`,
    );
  if (filters.after !== undefined)
    clauses.push(`${ACTIVITY} >= ${parameters.add(filters.after)}`);
  if (filters.before !== undefined)
    clauses.push(`${ACTIVITY} < ${parameters.add(filters.before)}`);
  return clauses;
};

const SELECTED = `thread.id, thread.title, thread.project_id, project.name AS project_name,
  thread.owner_user_id,
  COALESCE(account.display_name, owner.name, 'Member') AS owner_name,
  thread.parent_thread_id, thread.color, thread.lifecycle_state,
  thread.activity_status, thread.pinned_at, thread.workspace_access, thread.created_at,
  thread.snoozed_until,
  project.deleted_at IS NOT NULL AS project_deleted,
  EXISTS (SELECT 1 FROM organization
           WHERE organization.id = project.workspace_id
             AND organization.deletedAt IS NOT NULL) AS workspace_deleted,
  ${ACTIVITY} AS activity_at`;

export interface SearchThreadsInput {
  readonly db: D1Database;
  readonly bindings: Bindings;
  readonly scope: ThreadSearchScope;
  readonly query: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly now?: Date;
}

/**
 * Searches the Threads `scope` may see. Throws `ThreadSearchQueryError` for
 * an invalid query or cursor, `ThreadSearchUnavailable` when keywords need a
 * search index this deployment lacks.
 */
export const searchThreads = async (
  input: SearchThreadsInput,
): Promise<ThreadSearchResult> => {
  const { db, bindings, scope } = input;
  const parsed = parseThreadSearchQuery(input.query, input.now);
  const limit = Math.min(
    Math.max(1, Math.trunc(input.limit ?? THREAD_SEARCH_DEFAULT_LIMIT)),
    THREAD_SEARCH_MAX_LIMIT,
  );
  const cursor =
    input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  const terms = queryTerms(parsed.keywords);
  let d1RowsRead = 0;
  let indexRowsRead = 0;
  let snippetRowsRead = 0;
  let indexesQueried = 0;
  const cost = () => ({
    d1RowsRead,
    indexRowsRead,
    snippetRowsRead,
    indexesQueried,
  });
  // Keywords of only stopwords match nothing.
  if (parsed.keywords.length > 0 && terms.length === 0)
    return { items: [], cost: cost() };

  const scoped = (extra: (parameters: Parameters) => string[] = () => []) => {
    const parameters = new Parameters();
    const clauses = [
      "thread.lifecycle_state != 'deleted'",
      accessClause(scope, parameters),
      ...filterClauses(parsed.filters, scope, parameters),
      ...extra(parameters),
    ];
    return { parameters, where: clauses.join("\n AND ") };
  };
  const all = async <T>(query: string, parameters: Parameters) => {
    const result = await db
      .prepare(query)
      .bind(...parameters.values)
      .all<T>();
    d1RowsRead += result.meta.rows_read ?? 0;
    return result.results;
  };

  let matchedIds: ReadonlyArray<string> | undefined;
  /** Per matched Thread, the index chunk its snippet comes from. */
  const snippetChunkByThread = new Map<string, number>();
  if (terms.length > 0) {
    const byOwner = new Map<string, string[] | undefined>([
      [scope.userId, undefined],
    ]);
    if (
      parsed.filters.id !== undefined ||
      parsed.filters.parent !== undefined
    ) {
      byOwner.clear();
      const { parameters, where } = scoped();
      const candidates = await all<{ id: string; owner_user_id: string }>(
        `SELECT thread.id, thread.owner_user_id FROM threads AS thread
           JOIN projects AS project ON project.id = thread.project_id
          WHERE ${where} LIMIT ${CANDIDATE_MAX}`,
        parameters,
      );
      for (const { id, owner_user_id } of candidates)
        byOwner.set(owner_user_id, [...(byOwner.get(owner_user_id) ?? []), id]);
    } else if (
      parsed.filters.author !== "me" &&
      parsed.filters.visibility !== "private"
    ) {
      const parameters = new Parameters();
      const user = parameters.add(scope.userId);
      const sharers = await all<{ owner_user_id: string }>(
        `SELECT DISTINCT thread.owner_user_id FROM threads AS thread
           JOIN projects AS project ON project.id = thread.project_id
          WHERE thread.lifecycle_state != 'deleted'
            AND ${sharedThreadVisibleSql("thread", "project", user)}`,
        parameters,
      );
      for (const { owner_user_id } of sharers)
        byOwner.set(owner_user_id, undefined);
    }
    const matches = await Promise.all(
      [...byOwner].map(async ([ownerUserId, candidates]) => {
        const index = ownerSearchIndex(bindings, ownerUserId);
        if (index === undefined)
          throw new ThreadSearchUnavailable(
            "Thread search is not deployed: THREAD_SEARCH_INDEX is missing.",
          );
        indexesQueried += 1;
        return index.matchThreads(terms, candidates);
      }),
    );
    indexRowsRead += matches.reduce((sum, { rowsRead }) => sum + rowsRead, 0);
    matchedIds = matches.flatMap(({ threadIds }) => [...threadIds]);
    for (const { snippetChunks } of matches)
      for (const [threadId, chunk] of Object.entries(snippetChunks))
        snippetChunkByThread.set(threadId, chunk);
    if (matchedIds.length === 0) return { items: [], cost: cost() };
  }

  const { parameters, where } = scoped((parameters) => [
    ...(matchedIds === undefined
      ? []
      : [
          `thread.id IN (SELECT value FROM json_each(${parameters.add(JSON.stringify(matchedIds))}))`,
        ]),
    ...(cursor === undefined
      ? []
      : [
          `(${ACTIVITY}, thread.id) < (${parameters.add(cursor.activityAt)}, ${parameters.add(cursor.id)})`,
        ]),
  ]);
  const rows = await all<ThreadSearchRow>(
    `SELECT ${SELECTED} FROM threads AS thread
       JOIN projects AS project ON project.id = thread.project_id
       LEFT JOIN personal_account AS account ON account.user_id = thread.owner_user_id
       LEFT JOIN "user" AS owner ON owner.id = thread.owner_user_id
      WHERE ${where}
      ORDER BY activity_at DESC, thread.id DESC
      LIMIT ${limit + 1}`,
    parameters,
  );
  // A snooze is the owner's; members never see it.
  const page = rows
    .slice(0, limit)
    .map((row) =>
      row.owner_user_id === scope.userId
        ? row
        : { ...row, snoozed_until: null },
    );
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last !== undefined
      ? encodeCursor({ activityAt: last.activity_at, id: last.id })
      : undefined;

  const snippets = new Map<string, string>();
  const term = snippetTerm(terms);
  if (term !== undefined) {
    const pageByOwner = new Map<string, Record<string, number>>();
    for (const row of page) {
      const chunk = snippetChunkByThread.get(row.id);
      if (chunk === undefined) continue;
      pageByOwner.set(row.owner_user_id, {
        ...pageByOwner.get(row.owner_user_id),
        [row.id]: chunk,
      });
    }
    const excerpts = await Promise.all(
      [...pageByOwner].map(([ownerUserId, chunks]) => {
        const index = ownerSearchIndex(bindings, ownerUserId);
        return index === undefined
          ? { snippets: {}, rowsRead: 0 }
          : index.snippets(chunks, term);
      }),
    );
    for (const excerpt of excerpts) {
      snippetRowsRead += excerpt.rowsRead;
      for (const [threadId, snippet] of Object.entries(excerpt.snippets))
        snippets.set(threadId, snippet);
    }
  }
  return {
    items: page.map((row) => {
      const snippet = snippets.get(row.id);
      return snippet === undefined
        ? row
        : { ...row, matchedSearchText: snippet };
    }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
    cost: cost(),
  };
};
