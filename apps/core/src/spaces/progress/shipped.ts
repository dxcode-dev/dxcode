import type { ThreadChangesCaptureId, ThreadShipReason } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { spaceLogger } from "../../logging.js";
import {
  loadThreadChangesIndex,
  type ThreadChangesManifest,
} from "../../thread-changes/capture.js";

/**
 * When a thread's work shipped (`threads.shipped_at`, epoch ms) and how
 * (`threads.ship_reason`). The first signal wins and nothing later replaces
 * or clears it: restoring an archived thread keeps it shipped, because the
 * work it landed stays landed. Three signals write it:
 *
 * - `pull_request_merged`: GitHub's `pull_request` webhook says a pull
 *   request merged, and the thread is linked to it (`thread_github_link`).
 *   A thread is linked when it subscribes to the PR's comments, as its agent
 *   does after opening one, when dx follows a PR its owner's login opened
 *   from the thread, or when the agent calls `link_github_issue`.
 * - `ship_archived`: the owner archived the thread from its Ship outcome,
 *   which sends `reason: "ship"` with the archive.
 * - `default_branch`: a Changes capture from the thread's Orb shows its own
 *   commits on `origin/<default branch>` (see `landedOnDefaultBranch`).
 */
export const markThreadsShipped = async (
  db: D1Database,
  threadIds: ReadonlyArray<ThreadId>,
  reason: ThreadShipReason,
  at: number,
): Promise<ReadonlyArray<ThreadId>> => {
  if (threadIds.length === 0) return [];
  const ids = threadIds.slice(0, 90);
  const placeholders = ids.map((_, index) => `?${index + 3}`).join(", ");
  return (
    await db
      .prepare(
        `UPDATE threads SET shipped_at = ?1, ship_reason = ?2
          WHERE id IN (${placeholders}) AND shipped_at IS NULL
            AND lifecycle_state != 'deleted'
          RETURNING id`,
      )
      .bind(at, reason, ...ids)
      .all<{ id: ThreadId }>()
  ).results.map(({ id }) => id);
};

/**
 * A pull request merged: every thread linked to it shipped, at its merge
 * time. GitHub numbers issues and pull requests in one sequence, so the
 * number names the PR whatever kind the link last saw.
 */
export const markMergedPullRequestShipped = async (
  db: D1Database,
  repository: string,
  number: number,
  mergedAt: number,
): Promise<ReadonlyArray<ThreadId>> =>
  (
    await db
      .prepare(
        `UPDATE threads SET shipped_at = ?3, ship_reason = 'pull_request_merged'
          WHERE shipped_at IS NULL AND lifecycle_state != 'deleted'
            AND id IN (SELECT thread_id FROM thread_github_link
                        WHERE repository_key = lower(?1) AND number = ?2)
          RETURNING id`,
      )
      .bind(repository, number, mergedAt)
      .all<{ id: ThreadId }>()
  ).results.map(({ id }) => id);

/** The threads a merged `pull_request` webhook ships, if it is one. */
export const shipFromPullRequestWebhook = async (
  db: D1Database,
  action: string,
  payload: Record<string, unknown>,
  now: Date,
): Promise<ReadonlyArray<ThreadId>> => {
  const pull = payload.pull_request as
    | { number?: unknown; merged?: unknown; merged_at?: unknown }
    | undefined;
  const repository = (payload.repository as { full_name?: unknown } | undefined)
    ?.full_name;
  if (
    action !== "closed" ||
    pull?.merged !== true ||
    typeof pull.number !== "number" ||
    typeof repository !== "string"
  )
    return [];
  const mergedAt =
    typeof pull.merged_at === "string" ? Date.parse(pull.merged_at) : NaN;
  return markMergedPullRequestShipped(
    db,
    repository,
    pull.number,
    Number.isFinite(mergedAt) ? mergedAt : now.getTime(),
  );
};

/** What a Changes capture says about where the thread's commits are. */
export interface CaptureFacts {
  readonly defaultBranch: string;
  readonly upstreamLabel?: string | undefined;
  /** Commits on HEAD that its upstream does not have. */
  readonly ahead: number;
  /** HEAD's commits since the thread's starting commit, newest first. */
  readonly commits: ReadonlyArray<{
    readonly sha: string;
    readonly subject: string;
  }>;
  readonly ranges: ReadonlyArray<{
    readonly range: { readonly kind: string };
    readonly files: ReadonlyArray<{
      readonly path: string;
      readonly status: string;
    }>;
  }>;
}

/**
 * Whether a capture alone allows that the thread's commits just landed on
 * the default branch: HEAD is past the thread's starting commit and
 * `origin/<default branch>` holds all of it. The Orb's `origin/<default>`
 * moves only when it fetches or pushes, so it is GitHub's branch as of then.
 */
const mayHaveLanded = (next: CaptureFacts) =>
  next.upstreamLabel === `origin/${next.defaultBranch}` &&
  next.ahead === 0 &&
  next.commits.length > 0;

/**
 * Whether the thread's own work, as the previous capture saw it, is now on
 * the default branch, as the next capture sees it.
 *
 * A HEAD the default branch holds is not enough: pulling the default branch
 * brings other people's commits too, and resetting to it drops the
 * thread's work. So the previous capture must show the thread's own work,
 * and the next must still have it: each commit its upstream lacked, by SHA
 * or, rebased, by subject; or, with none, its uncommitted tracked files,
 * each now in one of HEAD's commits.
 */
export const landedOnDefaultBranch = (
  previous: CaptureFacts | undefined,
  next: CaptureFacts,
) => {
  if (previous === undefined || !mayHaveLanded(next)) return false;
  const unpushed = previous.commits.slice(0, previous.ahead);
  if (unpushed.length > 0) {
    const shas = new Set(next.commits.map(({ sha }) => sha));
    const subjects = new Set(next.commits.map(({ subject }) => subject));
    return unpushed.every(
      ({ sha, subject }) => shas.has(sha) || subjects.has(subject),
    );
  }
  const uncommitted =
    previous.ranges.find(({ range }) => range.kind === "uncommitted")?.files ??
    [];
  const committed = new Set(
    next.ranges
      .filter(({ range }) => range.kind === "commit")
      .flatMap(({ files }) => files.map(({ path }) => path)),
  );
  return (
    uncommitted.some(({ path }) => committed.has(path)) &&
    uncommitted.every(
      ({ path, status }) => status === "untracked" || committed.has(path),
    )
  );
};

/**
 * After a capture publishes and before the previous one is deleted: records
 * `default_branch` when the new capture shows the thread's work landed.
 * Reads the previous capture only when the new one allows it and the thread
 * has not shipped. Never throws; true when it marked the thread shipped.
 */
export const recordDefaultBranchLanding = async (input: {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly threadId: ThreadId;
  readonly previousCaptureId: ThreadChangesCaptureId | undefined;
  readonly manifest: ThreadChangesManifest;
}): Promise<boolean> => {
  if (
    input.previousCaptureId === undefined ||
    input.previousCaptureId === input.manifest.captureId ||
    !mayHaveLanded(input.manifest)
  )
    return false;
  try {
    const pending = await input.db
      .prepare(
        `SELECT 1 AS pending FROM threads
          WHERE id = ?1 AND shipped_at IS NULL AND lifecycle_state != 'deleted'`,
      )
      .bind(input.threadId)
      .first<{ pending: number }>();
    if (pending === null) return false;
    const previous = await loadThreadChangesIndex(
      input.bucket,
      input.threadId,
      input.previousCaptureId,
    );
    if (!landedOnDefaultBranch(previous, input.manifest)) return false;
    const at = Date.parse(input.manifest.capturedAt);
    const marked = await markThreadsShipped(
      input.db,
      [input.threadId],
      "default_branch",
      Number.isFinite(at) ? at : Date.now(),
    );
    if (marked.length > 0)
      spaceLogger.info("A thread's commits reached its default branch.", {
        event: "thread_shipped",
        threadId: input.threadId,
        reason: "default_branch",
      });
    return marked.length > 0;
  } catch (cause) {
    spaceLogger.warn("Checking whether a thread shipped failed.", {
      event: "thread_ship_check_failed",
      threadId: input.threadId,
      cause,
    });
    return false;
  }
};
