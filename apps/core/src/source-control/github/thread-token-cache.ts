/**
 * A Thread's GitHub token, kept in this isolate's memory for a few minutes
 * so the GitHub tools and native Git stop resolving it from D1 on every
 * call (#1495).
 *
 * Each use first reads, in one D1 batch, everything the token depends on:
 * the Thread (still active, still its owner's, its Project not deleted, the
 * owner still a member of its workspace), the owner's environment-variable
 * revisions (GITHUB_TOKEN may come from any of them), the owner's active
 * GitHub authorization (its row, token reference, expiry, and epoch), and
 * the owner's personal GitHub grants. A cached token is served only when all
 * of that is unchanged, so revoking or disconnecting GitHub, rotating the
 * token, changing an environment variable, or leaving the workspace stops
 * the very next call from using it. An entry also lapses after
 * `MAX_AGE_MS`, and before the token enters the window in which the control
 * plane refreshes it.
 *
 * Entries are keyed by Thread and by the kind of token, and hold the owner
 * they were resolved for: one Thread never receives another Thread's token,
 * even for the same owner, because a Project's GITHUB_TOKEN differs between
 * Projects. The token is held only in memory: never logged, never stored.
 */

export type ThreadTokenKind =
  /** What the Thread's `gh` uses: GITHUB_TOKEN, else the GitHub connection. */
  | "gh"
  /** The owner's GitHub connection only, for native Git to github.com. */
  | "connection";

/** How long a verified entry may be served at most. */
export const MAX_AGE_MS = 5 * 60_000;
/**
 * The control plane refreshes a GitHub user token within its last hour
 * (`USER_TOKEN_REFRESH_MARGIN_MS`); an entry is never served inside it, so a
 * refresh always goes through the control plane.
 */
const REFRESH_MARGIN_MS = 60 * 60_000;
const MAX_ENTRIES = 500;

interface Entry {
  readonly fingerprint: string;
  readonly ownerUserId: string;
  readonly token: string;
  readonly until: number;
}

const entries = new Map<string, Entry>();

const keyOf = (kind: ThreadTokenKind, threadId: string) =>
  `${kind}\u0000${threadId}`;

/** What a token depends on, as one D1 round trip reads it. */
interface Standing {
  readonly ownerUserId: string;
  readonly active: boolean;
  /** Whether an entry may be kept: active, member, Project present. */
  readonly cacheable: boolean;
  /** When the connection's token enters its refresh window. */
  readonly refreshAt: number;
  readonly fingerprint: string;
}

const OWNER = "(SELECT owner_user_id FROM threads WHERE id = ?1)";

const readStanding = async (
  db: D1Database,
  threadId: string,
): Promise<Standing | undefined> => {
  const [thread, memberships, revisions, authorization, grants] =
    await db.batch([
      db
        .prepare(
          `SELECT t.owner_user_id, t.project_id, t.lifecycle_state,
                  p.workspace_id, p.deleted_at,
                  CASE WHEN p.id IS NULL THEN 0
                       WHEN p.workspace_id IS NULL THEN 1
                       WHEN EXISTS (SELECT 1 FROM member AS m
                                     WHERE m.organizationId = p.workspace_id
                                       AND m.userId = t.owner_user_id) THEN 1
                       ELSE 0 END AS member
             FROM threads AS t
             LEFT JOIN projects AS p ON p.id = t.project_id
            WHERE t.id = ?1 LIMIT 1`,
        )
        .bind(threadId),
      db
        .prepare(
          `SELECT organizationId, role FROM member
            WHERE userId = ${OWNER} ORDER BY organizationId`,
        )
        .bind(threadId),
      // Every scope the owner's environment can draw on, whichever one
      // execution picks: a change in any of them drops the entry.
      db
        .prepare(
          `SELECT scope, target_id, revision
             FROM environment_variable_scope_revision
            WHERE (scope = 'personal' AND target_id = ${OWNER})
               OR (scope = 'project'
                   AND target_id = (SELECT project_id FROM threads WHERE id = ?1))
               OR (scope = 'workspace' AND target_id IN (
                     SELECT organizationId FROM member WHERE userId = ${OWNER}))
            ORDER BY scope, target_id`,
        )
        .bind(threadId),
      db
        .prepare(
          `SELECT a.id, a.access_token_reference_id, a.expires_at, a.updated_at,
                  COALESCE(e.epoch, 0) AS epoch
             FROM github_user_authorization AS a
             LEFT JOIN github_authorization_epoch AS e
               ON e.subject_kind = 'user-authorization' AND e.subject_id = a.id
            WHERE a.user_id = ${OWNER} AND a.status = 'active'
              AND a.access_token_reference_id IS NOT NULL
            ORDER BY a.updated_at DESC, a.id DESC LIMIT 1`,
        )
        .bind(threadId),
      db
        .prepare(
          `SELECT id, status, updated_at FROM github_owner_grant
            WHERE owner_scope = 'personal' AND owner_id = ${OWNER}
            ORDER BY id`,
        )
        .bind(threadId),
    ]);
  const row = thread?.results[0] as
    | {
        owner_user_id: string;
        project_id: string;
        lifecycle_state: string;
        workspace_id: string | null;
        deleted_at: string | null;
        member: number;
      }
    | undefined;
  if (row === undefined) return undefined;
  const current = authorization?.results[0] as
    | { expires_at: string | null }
    | undefined;
  const expiresAt =
    current?.expires_at == null ? Number.NaN : Date.parse(current.expires_at);
  const active = row.lifecycle_state === "active";
  return {
    ownerUserId: row.owner_user_id,
    active,
    cacheable: active && row.member === 1 && row.deleted_at === null,
    refreshAt: Number.isNaN(expiresAt)
      ? Number.POSITIVE_INFINITY
      : expiresAt - REFRESH_MARGIN_MS,
    fingerprint: JSON.stringify([
      row,
      memberships?.results ?? [],
      revisions?.results ?? [],
      authorization?.results ?? [],
      grants?.results ?? [],
    ]),
  };
};

export interface ThreadToken {
  readonly ownerUserId: string;
  /** Whether the Thread is active. */
  readonly active: boolean;
  readonly token: string | undefined;
  /** Whether it came from memory rather than a full resolution. */
  readonly cached: boolean;
}

/**
 * The Thread's token of this kind. Reads the Thread's standing (one D1
 * round trip), serves a matching entry, and otherwise calls `resolve` for the
 * Thread's owner and keeps what it returns. Returns undefined when the Thread
 * does not exist. With `activeOnly`, an inactive Thread resolves nothing.
 * Errors from D1 or `resolve` propagate; a failed resolution keeps nothing.
 */
export const threadToken = async (
  db: D1Database,
  threadId: string,
  kind: ThreadTokenKind,
  resolve: (ownerUserId: string) => Promise<string | undefined>,
  options: { readonly activeOnly?: boolean } = {},
): Promise<ThreadToken | undefined> => {
  const key = keyOf(kind, threadId);
  let standing: Standing | undefined;
  try {
    standing = await readStanding(db, threadId);
  } catch (cause) {
    entries.delete(key);
    throw cause;
  }
  if (standing === undefined) {
    forgetThreadTokens(threadId);
    return undefined;
  }
  const { ownerUserId, active } = standing;
  const now = Date.now();
  const entry = entries.get(key);
  if (
    entry !== undefined &&
    standing.cacheable &&
    entry.ownerUserId === ownerUserId &&
    entry.fingerprint === standing.fingerprint &&
    now < entry.until &&
    now < standing.refreshAt
  )
    return { ownerUserId, active, token: entry.token, cached: true };
  entries.delete(key);
  if (options.activeOnly === true && !active)
    return { ownerUserId, active, token: undefined, cached: false };
  const token = await resolve(ownerUserId);
  // The standing was read before resolving: anything that changed since
  // makes the next call's standing differ, so it resolves again.
  if (token !== undefined && standing.cacheable) {
    const until = Math.min(Date.now() + MAX_AGE_MS, standing.refreshAt);
    if (until > Date.now()) {
      if (entries.size >= MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, {
        fingerprint: standing.fingerprint,
        ownerUserId,
        token,
        until,
      });
    }
  }
  return { ownerUserId, active, token, cached: false };
};

/** Drops every kind of entry this isolate holds for the Thread. */
export const forgetThreadTokens = (threadId: string) => {
  entries.delete(keyOf("gh", threadId));
  entries.delete(keyOf("connection", threadId));
};
