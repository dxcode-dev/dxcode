import type { ThreadId, UserId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { spaceLogger } from "../logging.js";
import type { HistoryPage } from "../thread-search/history.js";
import { ownerRequest } from "../threads/owner-request.js";
import { spacesEnabledFor } from "./gate.js";

/**
 * A Space's child reports back when its turn ends: its agent is asked to
 * send the Space a short message with `send_thread_message`. A model may
 * answer in its own chat instead, and then the Space would wait for good.
 * So when a child's turn completes without a message to its Space, dx sends
 * the Space the turn's answer itself, from the child, as that tool would:
 * the Space shows it as "<child> finished: …" and its agent goes on.
 *
 * - No model call: the answer is sent as written, shortened at a paragraph
 *   past `REPORT_LIMIT` characters, with a note that the thread has it all.
 * - Each turn's report has one idempotency key, so seeing a turn settle
 *   twice, or a steered message settling with the turn that answered it,
 *   delivers one message.
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

/**
 * Sends the Space the child's finished turn when the child did not report
 * it. Never rejects.
 */
export const reportTurnToSpace = async (
  bindings: Bindings,
  input: {
    readonly spaceThreadId: ThreadId;
    readonly threadId: string;
    readonly ownerUserId: UserId;
    readonly page: HistoryPage;
    /** The submission whose answer ended the turn. */
    readonly submissionId: string;
    readonly reply: string;
  },
): Promise<void> => {
  const db = bindings.DB;
  if (
    db === undefined ||
    input.reply.trim() === "" ||
    turnReportedTo(input.page, input.submissionId, input.spaceThreadId)
  )
    return;
  try {
    // Only to a Space still open, which the child's owner owns, from a
    // child the Space started: one another child started reports to it.
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
        body: conciseReport(input.reply),
        idempotencyKey: await sha256Hex(
          `space-report:${input.threadId}:${input.submissionId}`,
        ),
      },
    );
    if (response.status !== 202)
      throw new Error(`The Space refused the report (${response.status}).`);
    spaceLogger.info("A Space thread's turn was reported to its Space.", {
      event: "space_thread_reported",
      threadId: input.threadId,
      spaceThreadId: input.spaceThreadId,
    });
  } catch (cause) {
    spaceLogger.warn("A Space thread's turn was not reported to its Space.", {
      event: "space_thread_report_failed",
      threadId: input.threadId,
      spaceThreadId: input.spaceThreadId,
      cause,
    });
  }
};
