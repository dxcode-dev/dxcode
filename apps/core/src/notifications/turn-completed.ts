import type { ThreadId, UserId } from "@dx/domain";
import { claudePlanResetOf } from "../claude-code/plan-wait.js";
import type { Bindings } from "../http/types.js";
import { notificationLogger } from "../logging.js";
import { threadPresentUsers } from "../realtime/publication.js";
import { classifyRunFailure, runFailureText } from "../runtime/run-failure.js";
import { sha256Hex } from "../threads/agent-tools.js";
import { ownerRequest } from "../threads/owner-request.js";
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
  /** Why a failed turn failed, as Flue settled it. */
  readonly error?: { readonly message: string; readonly type?: string };
}

const FINISHED_WITHOUT_REPLY =
  "The agent finished its turn and is waiting for you.";
const STOPPED = "The agent stopped before finishing its turn.";
/** A failed child tells its parent at most once in this window. */
const PARENT_NOTICE_WINDOW_MS = 30 * 60_000;
const EXCERPT_FAILURE_CHARS = 240;

/** What a failed turn tells people, without dx's failure stamp. */
const failureText = (error: TurnCompletion["error"]) => {
  if (error === undefined || error.message.trim() === "") return undefined;
  const code = classifyRunFailure({ message: error.message }).code;
  if (code === "WORKSPACE_DISK_FULL")
    return "Orb disk full: the turn failed before the agent could start. Send a message to retry: dx clears package caches and temporary files first, and if the disk is still full, starts the agent in recovery mode to free space.";
  return `The turn failed: ${runFailureText(error.message).slice(0, EXCERPT_FAILURE_CHARS)}`;
};

/**
 * A child Thread's failed turn, told to the parent that started it: its
 * agent never replied, so without this the parent waits forever (#1614).
 * Sent as a message from the child, so it starts the parent's turn; at most
 * once per child in PARENT_NOTICE_WINDOW_MS, so a child that keeps failing
 * cannot loop with its parent. A turn stopped on its Claude plan's limit
 * waits for the plan's reset and then runs again by itself
 * (claude-code/plan-wait.ts), so the parent hears that, once per reset,
 * however often the child is woken while it waits. Answers whether the
 * parent took it.
 */
const tellParent = async (
  bindings: Bindings,
  ownerUserId: UserId,
  child: { readonly id: ThreadId; readonly title: string | null },
  parentThreadId: string,
  text: string,
  planResetsAt: number | undefined,
) => {
  const window = Math.floor(Date.now() / PARENT_NOTICE_WINDOW_MS);
  const resumes =
    planResetsAt === undefined
      ? ""
      : ` dx runs it again by itself when the plan resets at ${new Date(
          planResetsAt * 1000,
        )
          .toISOString()
          .slice(0, 16)
          .replace("T", " ")} UTC, and it reports then.`;
  const { response } = await ownerRequest(
    { bindings, ownerUserId, sourceThreadId: child.id },
    "POST",
    `/v1/agents/dx/${encodeURIComponent(parentThreadId)}`,
    {
      kind: "user",
      body: `Child Thread ${child.title === null ? "" : `"${child.title}" `}(${child.id}) failed its turn and could not reply. ${text}${resumes}`,
      idempotencyKey: await sha256Hex(
        planResetsAt === undefined
          ? `turn-failed:${child.id}:${String(window)}`
          : `turn-failed:${child.id}:plan:${String(planResetsAt)}`,
      ),
    },
  );
  return response.status === 202;
};

/**
 * Notifies a Thread's owner that its agent finished, with what the agent
 * said, or why the turn failed. Only root Threads notify the owner: a child
 * Thread is the agent's own errand, and its parent is already waiting on it,
 * so a child's failed turn is told to its parent instead (or to the owner
 * when the parent can no longer take it). A cancelled turn notifies nobody
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
        `SELECT t.owner_user_id, t.parent_thread_id, t.title,
                p.lifecycle_state AS parent_lifecycle_state
           FROM threads t
           LEFT JOIN threads p ON p.id = t.parent_thread_id
          WHERE t.id = ?1 AND t.lifecycle_state != 'deleted'`,
      )
      .bind(completion.threadId)
      .first<{
        owner_user_id: string;
        parent_thread_id: string | null;
        title: string | null;
        parent_lifecycle_state: string | null;
      }>();
    if (thread === null) return;
    const failure =
      completion.outcome === "failed"
        ? failureText(completion.error)
        : undefined;
    // A child's turn is its parent's errand: only a failure is news there.
    // A parent that is gone or archived cannot take it; the owner can.
    if (thread.parent_thread_id !== null) {
      if (failure === undefined) return;
      const told =
        thread.parent_lifecycle_state === "active" &&
        (await tellParent(
          bindings,
          thread.owner_user_id as UserId,
          { id: completion.threadId, title: thread.title },
          thread.parent_thread_id,
          failure,
          claudePlanResetOf(completion.error?.message),
        ).catch(() => false));
      if (told) return;
    }
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
          : (failure ?? STOPPED),
    });
  } catch (cause) {
    notificationLogger.warn("Turn completion was not notified.", {
      event: "turn_completion_notify_failed",
      threadId: completion.threadId,
      cause,
    });
  }
};
