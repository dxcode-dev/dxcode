import type { ThreadId, UserId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { notificationLogger } from "../logging.js";
import { threadPresentUsers } from "../realtime/publication.js";
import { settledTurn } from "./latest-reply.js";
import { publishNotification } from "./publish.js";

/**
 * The agent settled a submission. Flue reports it once per submission, and
 * once for each message that joined the running turn.
 */
export interface TurnCompletion {
  readonly threadId: ThreadId;
  readonly submissionId: string;
  readonly outcome: "completed" | "failed" | "aborted";
}

const FINISHED_WITHOUT_REPLY =
  "The agent finished its turn and is waiting for you.";
const STOPPED = "The agent stopped before finishing its turn.";

/**
 * Notifies a Thread's owner that its agent finished, with what the agent
 * said. Only root Threads notify: a child Thread is the agent's own errand,
 * and its parent is already waiting on it. A cancelled turn notifies nobody
 * — the person who stopped it is looking at it. Neither does a turn whose
 * owner has that Thread open: they are watching the reply arrive, and a
 * notification about what is already on their screen is noise.
 *
 * Never throws: a notification must not disturb the runtime observation it
 * rides on.
 */
export const notifyTurnCompleted = async (
  bindings: Bindings,
  completion: TurnCompletion,
): Promise<void> => {
  const db = bindings.DB;
  if (db === undefined || completion.outcome === "aborted") return;
  try {
    const thread = await db
      .prepare(
        `SELECT owner_user_id, parent_thread_id
           FROM threads
          WHERE id = ?1 AND lifecycle_state != 'deleted'`,
      )
      .bind(completion.threadId)
      .first<{ owner_user_id: string; parent_thread_id: string | null }>();
    if (thread === null || thread.parent_thread_id !== null) return;
    const ownerUserId = thread.owner_user_id as UserId;
    const watching = await threadPresentUsers(bindings, completion.threadId);
    if (watching.has(ownerUserId)) return;
    const turn = await settledTurn(
      bindings,
      ownerUserId,
      completion.threadId,
      completion.submissionId,
    ).catch((cause) => {
      notificationLogger.warn("The finished turn's reply was not read.", {
        event: "turn_completion_reply_read_failed",
        threadId: completion.threadId,
        cause,
      });
      return { submissionId: completion.submissionId, reply: undefined };
    });
    // Keyed by the turn, not the submission: messages that joined a running
    // turn settle with it, and the person is told about that turn once.
    await publishNotification(bindings, {
      topic: "turn_completed",
      sourceKey: `turn:${turn.submissionId}`,
      recipients: [ownerUserId],
      threadId: completion.threadId,
      excerpt:
        completion.outcome === "completed"
          ? (turn.reply ?? FINISHED_WITHOUT_REPLY)
          : STOPPED,
    });
  } catch (cause) {
    notificationLogger.warn("Turn completion was not notified.", {
      event: "turn_completion_notify_failed",
      threadId: completion.threadId,
      cause,
    });
  }
};
