import type { ThreadId, UserId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { threadDeletionLogger } from "../logging.js";
import { ownerSearchIndex } from "../thread-search/index-client.js";
import { deleteThreadStorage } from "../thread-storage/store.js";
import { drainThreadDaemon } from "../threads/daemon-client.js";

/** Each piece of a deleted Thread that lives outside its D1 row. */
export type ThreadCleanupStep =
  | "agent-history"
  | "sandbox"
  | "execution-object"
  | "search-index"
  | "changes"
  | "attachments"
  | "storage";

/**
 * How each piece outside D1 is removed. Every step is idempotent: a retry
 * after a partial failure repeats it without harm.
 */
export interface ThreadCleanup {
  /** The Flue agent object: conversation history, runs, message files. */
  readonly eraseAgentHistory: (threadId: ThreadId) => Promise<void>;
  /** The sandbox at its provider (E2B, Cloudflare, or local). */
  readonly destroySandbox: (threadId: ThreadId) => Promise<void>;
}

export interface ThreadCleanupResult {
  readonly complete: boolean;
  readonly failedSteps: ReadonlyArray<ThreadCleanupStep>;
}

const CHANGES_PAGE = 1_000;

/** Captured Changes snapshots, stored per Thread in R2. */
const deleteChanges = async (bucket: R2Bucket, threadId: ThreadId) => {
  const prefix = `threads/${threadId}/`;
  for (;;) {
    const page = await bucket.list({ prefix, limit: CHANGES_PAGE });
    if (page.objects.length > 0)
      await bucket.delete(page.objects.map(({ key }) => key));
    if (!page.truncated) return;
  }
};

/**
 * Files sent in the Thread's messages. A file no other Thread was sent goes,
 * bytes first, so a retry after a failure still finds its row; then the
 * Thread's links go.
 */
const deleteAttachments = async (bindings: Bindings, threadId: ThreadId) => {
  const db = bindings.DB;
  const bucket = bindings.DX_STORAGE;
  if (db === undefined || bucket === undefined) return;
  const { results } = await db
    .prepare(
      `SELECT attachments.id, attachments.object_key FROM attachments
         JOIN attachment_threads ON attachment_threads.attachment_id = attachments.id
        WHERE attachment_threads.thread_id = ?1
          AND NOT EXISTS (
            SELECT 1 FROM attachment_threads AS other
             WHERE other.attachment_id = attachments.id
               AND other.thread_id != ?1
          )`,
    )
    .bind(threadId)
    .all<{ id: string; object_key: string }>();
  if (results.length > 0)
    await bucket.delete(results.map(({ object_key }) => object_key));
  await db.batch([
    ...results.map(({ id }) =>
      db.prepare("DELETE FROM attachments WHERE id = ?").bind(id),
    ),
    db
      .prepare("DELETE FROM attachment_threads WHERE thread_id = ?")
      .bind(threadId),
  ]);
};

/**
 * Removes everything a deleted Thread left outside its tombstone, then
 * records the attempt: complete, or the steps a later retry repeats. The
 * agent history goes first, which also stops a run in progress, and the
 * sandbox before the object that relays to it.
 */
export const purgeDeletedThread = async (
  bindings: Bindings,
  cleanup: ThreadCleanup,
  threadId: ThreadId,
  ownerUserId: UserId,
): Promise<ThreadCleanupResult> => {
  const steps: ReadonlyArray<
    readonly [ThreadCleanupStep, () => Promise<unknown>]
  > = [
    ["agent-history", () => cleanup.eraseAgentHistory(threadId)],
    ["sandbox", () => cleanup.destroySandbox(threadId)],
    [
      "execution-object",
      async () => {
        if (bindings.THREAD_EXECUTION === undefined) return;
        await drainThreadDaemon(bindings, threadId, "thread-deleted");
      },
    ],
    [
      "search-index",
      async () => {
        await ownerSearchIndex(bindings, ownerUserId)?.dropThread(threadId);
      },
    ],
    [
      "changes",
      async () => {
        if (bindings.DX_STORAGE !== undefined)
          await deleteChanges(bindings.DX_STORAGE, threadId);
      },
    ],
    ["attachments", () => deleteAttachments(bindings, threadId)],
    ["storage", () => deleteThreadStorage(bindings, threadId)],
  ];
  const failedSteps: ThreadCleanupStep[] = [];
  for (const [step, run] of steps) {
    try {
      await run();
    } catch (cause) {
      failedSteps.push(step);
      threadDeletionLogger.warn("Thread cleanup step failed.", {
        event: "thread_cleanup_step_failed",
        threadId,
        step,
        cause,
      });
    }
  }
  const complete = failedSteps.length === 0;
  const now = new Date().toISOString();
  await bindings.DB?.prepare(
    `UPDATE thread_deletion
        SET attempts = attempts + 1,
            last_attempt_at = ?2,
            completed_at = CASE WHEN ?3 THEN ?2 ELSE NULL END,
            last_error = ?4
      WHERE thread_id = ?1`,
  )
    .bind(
      threadId,
      now,
      complete ? 1 : 0,
      complete ? null : `Failed: ${failedSteps.join(", ")}`,
    )
    .run();
  threadDeletionLogger.info("Thread cleanup attempted.", {
    event: complete ? "thread_cleanup_completed" : "thread_cleanup_pending",
    threadId,
    failedSteps,
  });
  return { complete, failedSteps };
};

/** How long a failed cleanup waits before the cron retries it. */
export const CLEANUP_RETRY_AFTER_MS = 5 * 60 * 1_000;

/**
 * Retries the oldest unfinished cleanups whose last attempt is older than
 * the retry interval. Returns how many completed.
 */
export const sweepThreadDeletions = async (
  bindings: Bindings,
  cleanup: ThreadCleanup,
  now: Date,
  limit = 10,
): Promise<number> => {
  const db = bindings.DB;
  if (db === undefined) return 0;
  const { results } = await db
    .prepare(
      `SELECT thread_id AS threadId, owner_user_id AS ownerUserId
         FROM thread_deletion
        WHERE completed_at IS NULL
          AND (last_attempt_at IS NULL OR last_attempt_at < ?)
        ORDER BY last_attempt_at
        LIMIT ?`,
    )
    .bind(new Date(now.getTime() - CLEANUP_RETRY_AFTER_MS).toISOString(), limit)
    .all<{ threadId: ThreadId; ownerUserId: UserId }>();
  let completed = 0;
  for (const { threadId, ownerUserId } of results)
    if (
      (await purgeDeletedThread(bindings, cleanup, threadId, ownerUserId))
        .complete
    )
      completed++;
  return completed;
};
