import type { UserId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { finalReplyText, readHistory } from "../thread-search/history.js";
import { plainPreview } from "./plain-preview.js";

/**
 * What the agent last said in a Thread, as its owner reads it: the final
 * reply of the latest prompt, preferring the given submission's, as a plain
 * preview. Nothing when the history cannot say: no conversation yet, Flue
 * still indexing, or a response that ended on a tool call.
 */
export const latestAgentReply = async (
  bindings: Bindings,
  ownerUserId: UserId,
  threadId: string,
  submissionId?: string,
) => {
  const history = await readHistory(bindings, ownerUserId, threadId, 1);
  if (history.kind !== "page") return undefined;
  const replies = history.page.messages.filter(
    ({ role, purpose }) => role === "assistant" && purpose === "assistant",
  );
  const reply =
    replies.findLast((message) => message.submissionId === submissionId) ??
    replies.at(-1);
  const text = plainPreview(finalReplyText(reply?.parts ?? []));
  return text === "" ? undefined : text;
};
