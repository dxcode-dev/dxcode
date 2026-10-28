import type { UserId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import {
  finalReplyText,
  type HistoryPage,
  readHistory,
} from "../thread-search/history.js";
import { plainPreview } from "./plain-preview.js";

/**
 * The final reply in a history page, preferring the given submission's, as
 * a plain preview. Nothing when the response ended on a tool call.
 */
const replyPreview = (page: HistoryPage, submissionId?: string) => {
  const replies = page.messages.filter(
    ({ role, purpose }) => role === "assistant" && purpose === "assistant",
  );
  const reply =
    replies.findLast((message) => message.submissionId === submissionId) ??
    replies.at(-1);
  const text = plainPreview(finalReplyText(reply?.parts ?? []));
  return text === "" ? undefined : text;
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
  return history.kind === "page" ? replyPreview(history.page) : undefined;
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
): Promise<{ readonly submissionId: string; readonly reply?: string }> => {
  const history = await readHistory(bindings, ownerUserId, threadId, 1, [
    submissionId,
  ]);
  if (history.kind !== "page") return { submissionId };
  const turn = history.page.answeredBy.get(submissionId) ?? submissionId;
  const reply = replyPreview(history.page, turn);
  return reply === undefined
    ? { submissionId: turn }
    : { submissionId: turn, reply };
};
