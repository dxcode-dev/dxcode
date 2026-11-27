import type { Bindings } from "../http/types.js";
import { checkRepository, GitHubUnavailable, githubToken } from "./github.js";

/**
 * Whether a Thread's owner still reads a repository, checked before
 * GitHub content reaches the Thread: a subscription or link is verified
 * once when made, and its owner may lose access later (#2666). Reads with
 * the token the Thread's `gh` would use. A repository it read is trusted
 * for `READABLE_FOR_MS`, so a busy repository costs one GitHub read per
 * Thread per window.
 *
 * Answers false only when GitHub says 404, which is what it answers for a
 * private repository the token cannot see, and undefined when the owner has
 * no GitHub credentials to check with. Any other failure throws.
 */
const READABLE_FOR_MS = 5 * 60_000;
const MAX_ENTRIES = 500;
const readable = new Map<string, number>();

export const ownerReadsRepository = async (
  bindings: Bindings,
  db: D1Database,
  threadId: string,
  ownerUserId: string,
  repository: string,
  now = Date.now(),
) => {
  const key = `${threadId}\u0000${ownerUserId}\u0000${repository.toLowerCase()}`;
  if ((readable.get(key) ?? 0) > now) return true;
  readable.delete(key);
  const token = await githubToken(bindings, db, threadId, ownerUserId);
  if (token === undefined) return undefined;
  try {
    await checkRepository(token, repository);
  } catch (error) {
    if (error instanceof GitHubUnavailable && error.status === 404)
      return false;
    throw error;
  }
  if (readable.size >= MAX_ENTRIES) {
    const oldest = readable.keys().next().value;
    if (oldest !== undefined) readable.delete(oldest);
  }
  readable.set(key, now + READABLE_FOR_MS);
  return true;
};

/**
 * The owner no longer reads the repository: the Thread's subscriptions on
 * it end, and its links to the repository's issues and PRs lose their
 * verification and saved content, so webhooks stop writing to them.
 */
export const loseRepositoryAccess = (
  db: D1Database,
  threadId: string,
  ownerUserId: string,
  repository: string,
  now: Date,
) =>
  db.batch([
    db
      .prepare(
        `UPDATE github_subscription
            SET state = 'failed', subject_json = NULL, updated_at = ?4,
                state_detail = ?5
          WHERE thread_id = ?1 AND owner_user_id = ?2
            AND repository = ?3 COLLATE NOCASE AND state != 'failed'`,
      )
      .bind(
        threadId,
        ownerUserId,
        repository,
        now.toISOString(),
        `The owner's GitHub credentials no longer read ${repository}.`.slice(
          0,
          500,
        ),
      ),
    db
      .prepare(
        `UPDATE thread_github_link SET verified = 0, subject_json = NULL
          WHERE thread_id = ?1 AND repository_key = lower(?2)`,
      )
      .bind(threadId, repository),
  ]);
