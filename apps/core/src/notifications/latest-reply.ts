import type { UserId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import {
  finalReplyText,
  type HistoryMessage,
  type HistoryPage,
  readHistory,
} from "../thread-search/history.js";
import { plainPreview } from "./plain-preview.js";

/**
 * The final reply in a history page, preferring the given submission's.
 * Nothing when the response ended on a tool call.
 */
const finalReply = (page: HistoryPage, submissionId?: string) => {
  const replies = page.messages.filter(
    ({ role, purpose }) => role === "assistant" && purpose === "assistant",
  );
  return (
    replies.findLast((message) => message.submissionId === submissionId) ??
    replies.at(-1)
  );
};

const replyPreview = (reply: HistoryMessage | undefined) => {
  const text = plainPreview(finalReplyText(reply?.parts ?? []));
  return text === "" ? undefined : text;
};

/**
 * The transcript row of a reply's last words, which a notification opens
 * at: `row:<message id>:text:<n>`, n counting the message's text parts as
 * the web transcript does.
 */
const replyRow = (reply: HistoryMessage) => {
  const parts = reply.parts ?? [];
  let occurrence = -1;
  let row: string | undefined;
  for (const part of parts) {
    if (part.type !== "text") continue;
    occurrence += 1;
    if ((part.text ?? "").trim() !== "")
      row = `row:${reply.id}:text:${occurrence}`;
  }
  return row;
};

/**
 * What the agent last said in a Thread, as its owner reads it: the final
 * reply of the latest prompt. Nothing when the history cannot say: no
 * conversation yet, Flue still indexing, or a response that ended on a tool
 * call.
 */
export const latestAgentReply = async (
  bindings: Bindings,
  ownerUserId: UserId,
  threadId: string,
) => {
  const history = await readHistory(bindings, ownerUserId, threadId, 1);
  return history.kind === "page"
    ? replyPreview(finalReply(history.page))
    : undefined;
};

/**
 * The turn a settled submission belongs to. A message sent while the agent
 * worked joins the running turn and settles with it, so the turn is named
 * by the submission whose response answered it. A history Flue cannot serve
 * names the turn by the submission itself.
 */
export const settledTurn = async (
  bindings: Bindings,
  ownerUserId: UserId,
  threadId: string,
  submissionId: string,
): Promise<{
  readonly submissionId: string;
  readonly reply?: string;
  /** The reply's transcript row, to open the Thread at. */
  readonly replyRow?: string;
}> => {
  const history = await readHistory(bindings, ownerUserId, threadId, 1, [
    submissionId,
  ]);
  if (history.kind !== "page") return { submissionId };
  const turn = history.page.answeredBy.get(submissionId) ?? submissionId;
  const message = finalReply(history.page, turn);
  const reply = replyPreview(message);
  const row =
    reply === undefined || message === undefined
      ? undefined
      : replyRow(message);
  return {
    submissionId: turn,
    ...(reply === undefined ? {} : { reply }),
    ...(row === undefined ? {} : { replyRow: row }),
  };
};
