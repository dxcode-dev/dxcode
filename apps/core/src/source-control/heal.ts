import { SourceControlAccessDenied } from "@dx/domain";
import { readLiveGrantAuthority } from "./authority.js";

/**
 * The member's own connection that can reach a workspace Project's repository:
 * a live GitHub grant whose installation is entitled to it, or the member's
 * live Bitbucket connection (Bitbucket decides repository access).
 */
export const memberSourceGrant = async (
  db: D1Database,
  input: {
    readonly provider: "github" | "bitbucket";
    readonly userId: string;
    readonly repositoryId: string;
    readonly preferredGrantId?: string;
  },
) =>
  input.provider === "github"
    ? db
        .prepare(`
          SELECT grant_row.id
            FROM github_owner_grant AS grant_row
            JOIN github_installation AS installation
              ON installation.installation_id = grant_row.installation_id
            JOIN github_installation_repository AS entitlement
              ON entitlement.installation_id = grant_row.installation_id
             AND entitlement.provider_repository_id = ?
           WHERE grant_row.owner_scope = 'personal' AND grant_row.owner_id = ?
             AND grant_row.status = 'active' AND installation.status = 'active'
             AND entitlement.entitled = 1
           ORDER BY grant_row.id = ? DESC, grant_row.created_at, grant_row.id
           LIMIT 1
        `)
        .bind(input.repositoryId, input.userId, input.preferredGrantId ?? "")
        .first<{ id: string }>()
    : db
        .prepare(
          "SELECT id FROM bitbucket_connection WHERE user_id = ? AND status = 'active' LIMIT 1",
        )
        .bind(input.userId)
        .first<{ id: string }>();

interface LiveSourceGrant {
  readonly grantId: string;
  readonly installationId: string | null;
  readonly authorizationEpoch: number;
  readonly installationEpoch: number;
}

/**
 * The user's own live connection that reaches a repository, at its current
 * epochs: the preferred one while it is still live, otherwise another active
 * GitHub grant entitled to the repository or the user's active Bitbucket
 * connection, which may be a different account. Bitbucket then decides
 * repository access on every request.
 */
const liveSourceGrant = async (
  db: D1Database,
  input: {
    readonly provider: "github" | "bitbucket";
    readonly userId: string;
    readonly repositoryId: string;
    readonly preferredGrantId: string;
  },
): Promise<LiveSourceGrant | undefined> => {
  if (input.provider === "bitbucket") {
    const row = await db
      .prepare(`
        SELECT id, authorization_epoch FROM bitbucket_connection
         WHERE user_id = ? AND status = 'active'
         ORDER BY id = ? DESC, updated_at DESC LIMIT 1
      `)
      .bind(input.userId, input.preferredGrantId)
      .first<{ id: string; authorization_epoch: number }>();
    return row === null
      ? undefined
      : {
          grantId: row.id,
          installationId: null,
          authorizationEpoch: Number(row.authorization_epoch),
          installationEpoch: 0,
        };
  }
  const grant = await memberSourceGrant(db, input);
  if (grant === null) return undefined;
  const live = await readLiveGrantAuthority(
    db,
    { scope: "personal", id: input.userId },
    grant.id,
    input.repositoryId,
  );
  if (
    live === null ||
    live.grant_status !== "active" ||
    live.installation_status !== "active" ||
    live.entitled !== 1
  )
    return undefined;
  return {
    grantId: grant.id,
    installationId: live.installation_id,
    authorizationEpoch: Number(live.grant_epoch),
    installationEpoch: Number(live.installation_epoch),
  };
};

const sameGrant = (
  live: LiveSourceGrant,
  row: Record<string, string | number | null>,
) =>
  live.grantId === row.owner_grant_id &&
  live.installationId === row.installation_id &&
  live.authorizationEpoch === Number(row.authorization_epoch) &&
  live.installationEpoch === Number(row.installation_epoch);

const moveProjectBinding = (
  db: D1Database,
  projectId: string,
  from: string,
  to: LiveSourceGrant,
) =>
  db
    .prepare(`
      UPDATE project_source_authority
         SET owner_grant_id = ?, installation_id = ?, authorization_epoch = ?,
             installation_epoch = ?, updated_at = ?
       WHERE project_id = ? AND owner_grant_id = ?
    `)
    .bind(
      to.grantId,
      to.installationId,
      to.authorizationEpoch,
      to.installationEpoch,
      new Date().toISOString(),
      projectId,
      from,
    );

/**
 * Keeps a personal Project binding usable while its owner can still reach the
 * repository: after a disconnect and reconnect, a reconnect with another
 * account, a reinstalled GitHub App, or epochs that moved without revoking
 * anything, the binding moves to the owner's live connection. The repository
 * never changes; a user with no live connection to it is still refused.
 */
export const healProjectSourceAuthority = async (
  db: D1Database,
  projectId: string,
  userId: string,
) => {
  const row = await db
    .prepare(`
      SELECT provider, owner_grant_id, installation_id, provider_repository_id,
             authorization_epoch, installation_epoch
        FROM project_source_authority
       WHERE project_id = ? AND owner_scope = 'personal' AND owner_id = ?
         AND provenance = 'live-grant' AND source_health = 'available'
         AND provider IN ('github', 'bitbucket') AND owner_grant_id IS NOT NULL
    `)
    .bind(projectId, userId)
    .first<Record<string, string | number | null>>();
  if (row === null) return false;
  const live = await liveSourceGrant(db, {
    provider: row.provider as "github" | "bitbucket",
    userId,
    repositoryId: String(row.provider_repository_id),
    preferredGrantId: String(row.owner_grant_id),
  });
  if (live === undefined || sameGrant(live, row)) return false;
  return moveProjectBinding(db, projectId, String(row.owner_grant_id), live)
    .run()
    .then(
      (result) => result.meta.changes === 1,
      () => false,
    );
};

/**
 * The Thread form of `healProjectSourceAuthority`: the Thread's captured
 * authority, and its Project's binding when the Thread's owner owns it and it
 * used the same connection, move together to the owner's live connection to
 * the same repository.
 */
export const healThreadSourceAuthority = async (
  db: D1Database,
  threadId: string,
) => {
  const row = await db
    .prepare(`
      SELECT thread.owner_user_id, thread.project_id, snapshot.provider,
             authority.owner_grant_id, authority.installation_id,
             authority.provider_repository_id, authority.authorization_epoch,
             authority.installation_epoch
        FROM threads AS thread
        JOIN thread_source_snapshot AS snapshot ON snapshot.thread_id = thread.id
        JOIN thread_source_authority AS authority ON authority.thread_id = thread.id
       WHERE thread.id = ? AND thread.lifecycle_state = 'active'
         AND snapshot.provider IN ('github', 'bitbucket')
         -- A workspace grant follows its workspace binding, never a person.
         AND NOT EXISTS (SELECT 1 FROM github_owner_grant
           WHERE id = authority.owner_grant_id AND owner_scope = 'workspace')
    `)
    .bind(threadId)
    .first<Record<string, string | number | null>>();
  if (row === null) return false;
  const userId = String(row.owner_user_id);
  const from = String(row.owner_grant_id);
  const live = await liveSourceGrant(db, {
    provider: row.provider as "github" | "bitbucket",
    userId,
    repositoryId: String(row.provider_repository_id),
    preferredGrantId: from,
  });
  if (live === undefined || sameGrant(live, row)) return false;
  // Best effort: a refused or failed move leaves the authority as it was, and
  // the caller's own check then reports why.
  return db
    .batch([
      db
        .prepare(`
        UPDATE thread_source_authority
           SET owner_grant_id = ?, installation_id = ?, authorization_epoch = ?,
               installation_epoch = ?
         WHERE thread_id = ? AND owner_grant_id = ?
      `)
        .bind(
          live.grantId,
          live.installationId,
          live.authorizationEpoch,
          live.installationEpoch,
          threadId,
          from,
        ),
      db
        .prepare(`
        UPDATE project_source_authority
           SET owner_grant_id = ?, installation_id = ?, authorization_epoch = ?,
               installation_epoch = ?, updated_at = ?
         WHERE project_id = ? AND owner_grant_id = ? AND owner_scope = 'personal'
           AND owner_id = ? AND provenance = 'live-grant'
           AND provider_repository_id = ?
      `)
        .bind(
          live.grantId,
          live.installationId,
          live.authorizationEpoch,
          live.installationEpoch,
          new Date().toISOString(),
          row.project_id,
          from,
          userId,
          row.provider_repository_id,
        ),
    ])
    .then(
      (results) => results[0]?.meta.changes === 1,
      () => false,
    );
};

/**
 * Runs a source check; when it is refused and healing moved the source to the
 * owner's live connection, runs it once more. A healthy source pays nothing.
 */
export const withHealedSource = async <A>(
  heal: () => Promise<boolean>,
  check: () => Promise<A>,
): Promise<A> => {
  try {
    return await check();
  } catch (cause) {
    if (!(cause instanceof SourceControlAccessDenied) || !(await heal()))
      throw cause;
    return check();
  }
};
