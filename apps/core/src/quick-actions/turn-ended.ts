import type { ThreadQuickAction } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { agentModelLogger } from "../logging.js";
import { readHistory } from "../thread-search/history.js";
import { clefAvailable } from "../workers-ai/clef.js";
import {
  chooseQuickActions,
  endedTurn,
  type QuickActionsCaller,
  workersAiQuickActions,
} from "./actions.js";
import { type ReplyWriter, workersAiReplyWriter } from "./reply-writer.js";
import { storedQuickActions, storeQuickActions } from "./store.js";

/** The settled submission the turn-end hook was told about. */
export interface SettledSubmission {
  readonly threadId: ThreadId;
  readonly submissionId: string;
  readonly outcome: "completed" | "failed" | "aborted";
}

/**
 * The turn-end hook for composer quick actions, run beside the finished-turn
 * notification on every settled submission, for Flue and Claude Code turns
 * alike. When the turn completed, it reads the agent message that ended the turn,
 * has a small text model write the replies the person might send next
 * (`reply-writer.ts`), asks Clef Flash which actions to show, and stores
 * the pick for the quick-actions
 * route to serve. A failed Clef call stores an empty pick, so the row
 * settles on nothing instead of waiting. Each message is picked for once,
 * however many submissions settle with its turn. Snooze is a candidate on
 * root Threads; the route offers it only to an owner who can snooze.
 *
 * Never throws: it must not disturb the runtime observation it rides on.
 */
export const pickQuickActionsAtTurnEnd = async (
  bindings: Bindings,
  settled: SettledSubmission,
  call: QuickActionsCaller = workersAiQuickActions,
  readTurnHistory: typeof readHistory = readHistory,
  writeReplies: ReplyWriter = workersAiReplyWriter,
): Promise<void> => {
  const db = bindings.DB;
  if (
    db === undefined ||
    settled.outcome !== "completed" ||
    !clefAvailable(bindings)
  )
    return;
  try {
    const thread = await db
      .prepare(
        `SELECT owner_user_id, parent_thread_id FROM threads
          WHERE id = ?1 AND lifecycle_state = 'active'`,
      )
      .bind(settled.threadId)
      .first<{ owner_user_id: string; parent_thread_id: string | null }>();
    if (thread === null) return;
    const history = await readTurnHistory(
      bindings,
      thread.owner_user_id as UserId,
      settled.threadId,
      1,
      [settled.submissionId],
    );
    if (history.kind !== "page") return;
    const turn = endedTurn(
      history.page,
      history.page.answeredBy.get(settled.submissionId) ?? settled.submissionId,
    );
    if (turn === undefined) return;
    if (
      (await storedQuickActions(db, settled.threadId))?.messageId ===
      turn.messageId
    )
      return;
    const replies = await writeReplies({ bindings, message: turn.reply });
    const chosen: ReadonlyArray<ThreadQuickAction> | undefined =
      await chooseQuickActions(
        call,
        bindings,
        turn,
        replies,
        thread.parent_thread_id === null,
      );
    await storeQuickActions(db, settled.threadId, {
      messageId: turn.messageId,
      actions: chosen ?? [],
    });
    agentModelLogger.info("Composer quick actions picked at turn end.", {
      event: "quick_actions_picked",
      threadId: settled.threadId,
      messageId: turn.messageId,
      written: replies.length,
      answered: chosen !== undefined,
      replies: (chosen ?? []).filter(({ kind }) => kind === "reply").length,
      snooze: (chosen ?? []).some(({ kind }) => kind === "snooze"),
    });
  } catch (cause) {
    agentModelLogger.warn("Composer quick actions were not picked.", {
      event: "quick_actions_pick_failed",
      threadId: settled.threadId,
      cause,
    });
  }
};
