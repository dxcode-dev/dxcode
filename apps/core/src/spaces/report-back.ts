import type { ThreadId, UserId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { spaceLogger } from "../logging.js";
import type { HistoryPage } from "../thread-search/history.js";
import { ownerRequest } from "../threads/owner-request.js";
import { spacesEnabledFor } from "./gate.js";

/**
 * A Space's coordinator learns about its children only from messages, so
 * every change it must act on reaches it as one, from the child:
 *
 * - A finished turn. The child's agent is asked to send the Space a short
 *   message with `send_thread_message`; a model may answer in its own chat
 *   instead, so when a turn completes without a message to its Space, dx
 *   sends the turn's answer itself, as that tool would. A turn that ended
 *   with no text says so. No model call: the answer is sent as written,
 *   shortened at a paragraph past `REPORT_LIMIT` characters.
 * - A failed turn, which the child cannot report: `notifyTurnCompleted`
 *   (notifications/turn-completed.ts) tells every parent, a Space included,
 *   and says when a turn stopped on a Claude plan's limit resumes.
 * - Shipping that no turn of the child's tells: a merged pull request the
 *   child does not follow, or its owner's Ship & archive.
 *
 * A stopped turn is a person's act in the child and is not reported.
 * Each change has one idempotency key, so seeing it twice (a settled turn
 * replayed, a steered message settling with the turn that answered it, a
 * redelivered webhook) delivers one
 * message. These messages reach the Space's agent as worker reports
 * (`posts/admission.ts`).
 */

const REPORT_LIMIT = 800;
const SHORTENED_NOTE = "(Shortened. The whole answer is in the thread.)";

const sha256Hex = async (seed: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

/** Whether the turn's agent messaged the Space itself. */
export const turnReportedTo = (
  page: HistoryPage,
  submissionId: string,
  spaceThreadId: string,
) =>
  page.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.submissionId === submissionId &&
      (message.parts ?? []).some(
        (part) =>
          typeof part.toolName === "string" &&
          /(?:^|__)send_thread_message$/.test(part.toolName) &&
          part.state !== "output-error" &&
          typeof part.input === "object" &&
          part.input !== null &&
          (part.input as { readonly thread?: unknown }).thread ===
            spaceThreadId,
      ),
  );

/** The answer as a report: whole when short, else its first paragraphs. */
export const conciseReport = (reply: string) => {
  const text = reply.trim();
  if (text.length <= REPORT_LIMIT) return text;
  let kept = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    const next = kept === "" ? paragraph : `${kept}\n\n${paragraph}`;
    if (next.length > REPORT_LIMIT) break;
    kept = next;
  }
  if (kept === "") {
    const cut = text.slice(0, REPORT_LIMIT);
    const space = cut.lastIndexOf(" ");
    kept = `${(space > REPORT_LIMIT / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  // A cut inside a code block closes it.
  if ((kept.match(/```/g) ?? []).length % 2 === 1) kept = `${kept}\n\`\`\``;
  return `${kept}\n\n${SHORTENED_NOTE}`;
};

/** One report from a Space's child, or dx on its behalf, to the Space. */
interface SpaceReport {
  readonly spaceThreadId: ThreadId;
  readonly threadId: string;
  readonly ownerUserId: UserId;
  readonly body: string;
  /**
   * Names the change reported. Flue admits a key once, so the same change
   * seen twice reaches the Space once.
   */
  readonly key: string;
  /** What changed, for logs. */
  readonly kind: "turn" | "silent_turn" | "shipped";
}

/**
 * Sends the Space one report as the child, as `send_thread_message` would:
 * only to a Space still open, which the child's owner owns, from a child the
 * Space started. Never rejects.
 */
const sendSpaceReport = async (
  bindings: Bindings,
  input: SpaceReport,
): Promise<void> => {
  const db = bindings.DB;
  if (db === undefined) return;
  try {
    // One another child started reports to it, not to the Space.
    const space = await db
      .prepare(
        `SELECT 1 AS open FROM threads AS child
           JOIN threads AS space ON space.id = ?1
          WHERE child.id = ?3 AND space.owner_user_id = ?2
            AND space.lifecycle_state = 'active'
            AND (child.started_by_thread_id IS NULL
                 OR child.started_by_thread_id = space.id)`,
      )
      .bind(input.spaceThreadId, input.ownerUserId, input.threadId)
      .first();
    // A Space its owner turned off gets no reports (spaces/gate.ts).
    if (
      space === null ||
      !(await spacesEnabledFor(bindings, input.ownerUserId))
    )
      return;
    const { response } = await ownerRequest(
      {
        bindings,
        ownerUserId: input.ownerUserId,
        sourceThreadId: input.threadId,
      },
      "POST",
      `/v1/agents/dx/${encodeURIComponent(input.spaceThreadId)}`,
      {
        kind: "user",
        body: input.body,
        idempotencyKey: await sha256Hex(input.key),
      },
    );
    if (response.status !== 202)
      throw new Error(`The Space refused the report (${response.status}).`);
    spaceLogger.info("A Space thread's change was reported to its Space.", {
      event: "space_thread_reported",
      kind: input.kind,
      threadId: input.threadId,
      spaceThreadId: input.spaceThreadId,
    });
  } catch (cause) {
    spaceLogger.warn("A Space thread's change was not reported to its Space.", {
      event: "space_thread_report_failed",
      kind: input.kind,
      threadId: input.threadId,
      spaceThreadId: input.spaceThreadId,
      cause,
    });
  }
};

/** A turn's key, so a turn reports once. */
const turnKey = (threadId: string, submissionId: string) =>
  `space-report:${threadId}:${submissionId}`;

/** What dx says for a turn that ended with no text after its last tool. */
export const SILENT_TURN_REPORT =
  "(Sent by dx: this thread finished its turn without a written answer. Its card and the thread show where it stands.)";

/** What dx says for a turn whose history it could not read. */
export const UNREAD_TURN_REPORT =
  "(Sent by dx: this thread finished its turn, and dx could not read its answer. The thread has it.)";

/**
 * Sends the Space the child's finished turn when the child did not report
 * it. A turn that ended without text still reports, so the Space never
 * waits on it. Never rejects.
 */
export const reportTurnToSpace = async (
  bindings: Bindings,
  input: {
    readonly spaceThreadId: ThreadId;
    readonly threadId: string;
    readonly ownerUserId: UserId;
    /** The submission whose answer ended the turn. */
    readonly submissionId: string;
    /** Undefined when the thread's history could not be read. */
    readonly page: HistoryPage | undefined;
    readonly reply: string | undefined;
  },
): Promise<void> => {
  if (
    input.page !== undefined &&
    turnReportedTo(input.page, input.submissionId, input.spaceThreadId)
  )
    return;
  const reply = input.reply?.trim() ?? "";
  await sendSpaceReport(bindings, {
    spaceThreadId: input.spaceThreadId,
    threadId: input.threadId,
    ownerUserId: input.ownerUserId,
    body:
      input.reply === undefined
        ? UNREAD_TURN_REPORT
        : reply === ""
          ? SILENT_TURN_REPORT
          : conciseReport(reply),
    key: turnKey(input.threadId, input.submissionId),
    kind: reply === "" ? "silent_turn" : "turn",
  });
};

/** How a thread came to count as shipped, as the report says it. */
export type ShipSignal =
  | { readonly reason: "pull_request_merged"; readonly pullRequest: string }
  | { readonly reason: "ship_archived" };

/**
 * Tells a Space that one of its children shipped, when nothing else will:
 * a merged pull request wakes a thread only through a comment subscription
 * on it, so a thread that has one reports the merge itself in its next turn
 * and gets no second report here. A thread ships once, so it reports once.
 * Never rejects.
 */
export const reportShippedToSpace = async (
  bindings: Bindings,
  threadId: string,
  signal: ShipSignal,
): Promise<void> => {
  const db = bindings.DB;
  if (db === undefined) return;
  try {
    const row = await db
      .prepare(
        `SELECT child.owner_user_id AS ownerUserId, space.id AS spaceThreadId,
                EXISTS (
                  SELECT 1 FROM github_subscription AS s
                   WHERE s.thread_id = child.id
                     AND s.filter_kind = 'pr-comments'
                     AND s.destination = 'this-thread'
                     AND s.enabled = 1 AND s.state = 'active'
                     AND lower(s.repository) || '#' ||
                         json_extract(s.filter_json, '$.prNumber') = lower(?2)
                ) AS wakes
           FROM threads AS child
           JOIN threads AS space ON space.id = child.parent_thread_id
          WHERE child.id = ?1 AND space.kind = 'space'`,
      )
      .bind(
        threadId,
        signal.reason === "pull_request_merged" ? signal.pullRequest : "",
      )
      .first<{ ownerUserId: UserId; spaceThreadId: ThreadId; wakes: number }>();
    if (row === null || row.wakes === 1) return;
    await sendSpaceReport(bindings, {
      spaceThreadId: row.spaceThreadId,
      threadId,
      ownerUserId: row.ownerUserId,
      body:
        signal.reason === "pull_request_merged"
          ? `(Sent by dx: this thread's work shipped. Its pull request ${signal.pullRequest} merged.)`
          : "(Sent by dx: this thread's work shipped. Its owner marked it shipped and archived it.)",
      key: `space-shipped:${threadId}`,
      kind: "shipped",
    });
  } catch (cause) {
    spaceLogger.warn("A shipped Space thread was not reported to its Space.", {
      event: "space_thread_report_failed",
      kind: "shipped",
      threadId,
      cause,
    });
  }
};
