import type { Bindings } from "../http/types.js";
import { threadPersistenceLogger } from "../logging.js";
import { ownerSearchIndex } from "./index-client.js";

/** Queues a Thread whose owner and title the caller already knows. */
export const enqueueKnownThreadSearchIndex = async (
  bindings: Bindings,
  thread: {
    readonly threadId: string;
    readonly ownerUserId: string;
    readonly title: string;
  },
): Promise<void> => {
  try {
    await ownerSearchIndex(bindings, thread.ownerUserId)?.enqueue(thread);
  } catch (error) {
    threadPersistenceLogger.warn(
      "Thread search indexing could not be queued.",
      {
        event: "thread_search_enqueue_failed",
        threadId: thread.threadId,
        code: error instanceof Error ? error.name : "UNKNOWN",
      },
    );
  }
};

/**
 * Queues a Thread in its owner's search index after a turn settles or its
 * title changes. The index reads the new history itself, shortly after.
 * Never rejects; a deployment without the index binding indexes nothing.
 */
export const enqueueThreadSearchIndex = async (
  bindings: Bindings,
  threadId: string,
): Promise<void> => {
  try {
    const row = await bindings.DB?.prepare(
      "SELECT owner_user_id, title FROM threads WHERE id = ? AND lifecycle_state != 'deleted'",
    )
      .bind(threadId)
      .first<{ owner_user_id: string; title: string }>();
    if (row === undefined || row === null) return;
    const index = ownerSearchIndex(bindings, row.owner_user_id);
    if (index === undefined) return;
    await index.enqueue({
      ownerUserId: row.owner_user_id,
      threadId,
      title: row.title,
    });
  } catch (error) {
    threadPersistenceLogger.warn(
      "Thread search indexing could not be queued.",
      {
        event: "thread_search_enqueue_failed",
        threadId,
        code: error instanceof Error ? error.name : "UNKNOWN",
      },
    );
  }
};

const missingExecutionContextMessage = "This context has no ExecutionContext";

/**
 * Queues the Thread after the response, or inline where a request has no
 * execution context (as in route tests).
 */
export const scheduleThreadSearchIndex = (
  executionContext: () => {
    readonly waitUntil: (promise: Promise<unknown>) => void;
  },
  bindings: Bindings,
  threadId: string,
): Promise<void> | undefined => {
  const queued = enqueueThreadSearchIndex(bindings, threadId);
  try {
    executionContext().waitUntil(queued);
    return undefined;
  } catch (cause) {
    if (
      cause instanceof Error &&
      cause.message === missingExecutionContextMessage
    )
      return queued;
    throw cause;
  }
};
