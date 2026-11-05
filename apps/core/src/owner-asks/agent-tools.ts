import {
  OFFER_REPLIES_TOOL,
  REPLY_OFFER_LIMIT,
  REPLY_OFFER_MAX_LENGTH,
} from "@dx/api";
import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import { addOwnerAsk } from "../thread-artifacts/owner-ask.js";
import type { ThreadToolsContext } from "../threads/agent-tools.js";

/**
 * How the agent ends a turn on the owner.
 *
 * `request_attention`: the agent asks its Thread's owner for an answer or an
 * approval. The ask is an unchecked checklist item mentioning the owner in
 * the Thread's Plan artifact, or in the artifact the agent names
 * (`thread-artifacts/owner-ask.ts`); the mention notifies the owner, and a
 * tick or an answer under it wakes the Thread.
 *
 * `offer_replies`: the agent offers the choices it ends on as replies. The
 * call's input is the record: with the experimental composer quick actions
 * on, Clef Flash picks which to show as chips above the composer, and a
 * click sends a reply's text unchanged (`../quick-actions/actions.ts`).
 */
export const createOwnerAskTools = (
  callingThreadId: string,
  getContext: () => ThreadToolsContext,
  submissionId?: string,
): ToolDefinition[] => [
  defineTool({
    name: "request_attention",
    description: [
      "Ask this Thread's owner for an answer or an approval. It adds the ask as an unchecked checklist item that mentions them to this Thread's Plan artifact, creating the artifact when there is none; the mention notifies them. Call it when you will end your turn waiting on the owner: a question only they can answer, or an approval they must give. Call it before you write your final reply, then write that reply, with your summary and the ask, as your last message. The reply after the last tool call is the one the owner sees in full.",
      "When the owner ticks the item or writes under it, this Thread wakes with a message saying so. The ask stays open until someone ticks it: when the owner answers in the conversation instead, tick it yourself with the artifact tool. If you already wrote the ask as a checklist item mentioning the owner in another artifact, pass its artifact_id and nothing is added. If another Thread's agent started this Thread, send your question to that Thread with send_thread_message instead.",
    ].join("\n\n"),
    input: v.object({
      kind: v.pipe(
        v.picklist(["question", "approval"]),
        v.description(
          "question: you need an answer or a decision. approval: you need the owner to approve something before you continue, such as merging a pull request.",
        ),
      ),
      summary: v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1),
        v.maxLength(300),
        v.regex(/^[^\r\n]*$/, "The summary is one line."),
        v.description(
          'The ask in one line, at most 300 characters, such as "Approve merging PR #1240 after watching its proof video". It becomes the checklist item\'s text.',
        ),
      ),
      url: v.optional(
        v.pipe(
          v.string(),
          v.maxLength(2048),
          v.url(),
          v.regex(/^https?:\/\/[^\s()]*$/),
          v.description(
            "Optional https link the ask is about, such as a pull request or an issue comment.",
          ),
        ),
      ),
      artifact_id: v.optional(
        v.pipe(
          v.string(),
          v.regex(/^art_[0-9a-f]{32}$/),
          v.description(
            "Optional: the artifact in this Thread for the ask, instead of the Plan artifact. When it already holds an unchecked checklist item that mentions the owner, such as `- [ ] @[Name](user:USER_ID) Approve merging #1240`, nothing is added.",
          ),
        ),
      ),
    }),
    run: async ({ data }) => {
      const ask = await addOwnerAsk(getContext(), callingThreadId, {
        summary: data.summary,
        url: data.url,
        artifactId: data.artifact_id,
        submissionId,
      });
      return {
        output: {
          listed: true,
          artifact_id: ask.artifactId,
          title: ask.title,
          revision: ask.revision,
          note: `${ask.added ? `The ask is in "${ask.title}"` : `"${ask.title}" already holds the ask`} and the owner is notified. Now write your final reply, with your summary and the ask, and end your turn.`,
        },
      };
    },
  }),
  defineTool({
    name: OFFER_REPLIES_TOOL,
    description: [
      `Offer up to ${REPLY_OFFER_LIMIT} replies the person can send with one click. Call it when you end your turn by asking them to choose between explicit options, such as "Ship it now" and "Add tests first", with one reply per option; then end your turn. dx may show them as buttons above the message box until the next message; a click sends that reply's text exactly as you wrote it.`,
      "Write each reply as the person's own short message. Offer none when your question is open-ended.",
    ].join("\n\n"),
    input: v.object({
      replies: v.pipe(
        v.array(
          v.pipe(
            v.string(),
            v.trim(),
            v.minLength(1),
            v.maxLength(REPLY_OFFER_MAX_LENGTH),
          ),
        ),
        v.minLength(1),
        v.maxLength(REPLY_OFFER_LIMIT),
        v.description(
          `One to ${REPLY_OFFER_LIMIT} replies, each at most ${REPLY_OFFER_MAX_LENGTH} characters, written as the person's message.`,
        ),
      ),
    }),
    run: ({ data }) =>
      Promise.resolve({
        output: {
          offered: data.replies,
          note: "The person may see these as reply buttons. End your turn now.",
        },
      }),
  }),
];
