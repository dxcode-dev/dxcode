import {
  OFFER_REPLIES_TOOL,
  REPLY_OFFER_LIMIT,
  REPLY_OFFER_MAX_LENGTH,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import { publishUserInvalidation } from "../realtime/publication.js";
import { readArtifact } from "../thread-artifacts/store.js";
import type { ThreadToolsContext } from "../threads/agent-tools.js";
import { readCallingThread } from "../threads/calling-thread.js";
import { requestAttention } from "./repository.js";

/**
 * How the agent ends a turn on the owner.
 *
 * `request_attention`: the agent lists its Thread in the owner's Needs-you
 * inbox. The Thread's next turn starting, which the owner's reply causes, or
 * the owner's Dismiss clears it (`threads/activity.ts`, `routes.ts`).
 *
 * `offer_replies`: the agent offers the choices it ends on as replies. The
 * call's input is the record: with the experimental composer quick actions
 * on, Clef Flash picks which to show as chips above the composer, and a
 * click sends a reply's text unchanged (`../quick-actions/actions.ts`).
 */
export const createNeedsYouTools = (
  callingThreadId: string,
  getContext: () => ThreadToolsContext,
): ToolDefinition[] => [
  defineTool({
    name: "request_attention",
    description: [
      "List this Thread in its owner's Needs-you inbox, which shows every Thread waiting on them across their projects. Call it when you will end your turn waiting on the owner: a question only they can answer, or an approval they must give. Call it before you write your final reply, then write that reply, with your summary and the ask, as your last message. The reply after the last tool call is the one the owner sees in full.",
      "The listing clears when this Thread's next turn starts, such as when the owner replies, or when the owner dismisses it. A later call replaces the earlier ask. If another Thread's agent started this Thread, send your question to that Thread with send_thread_message instead.",
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
        v.description(
          'The ask in one line, at most 300 characters, such as "Approve merging PR #1240 after watching its proof video".',
        ),
      ),
      url: v.optional(
        v.pipe(
          v.string(),
          v.maxLength(2048),
          v.url(),
          v.regex(/^https?:\/\//),
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
            "Optional: the artifact in this Thread holding the ask as an unchecked checklist item that mentions the owner, such as `- [ ] @[Name](user:USER_ID) Approve merging #1240`. The owner can tick it from their Needs-you page, which wakes this Thread.",
          ),
        ),
      ),
    }),
    run: async ({ data }) => {
      const context = getContext();
      const owner = await readCallingThread(context.db, callingThreadId);
      if (
        data.artifact_id !== undefined &&
        (await readArtifact(
          context.bindings,
          callingThreadId,
          data.artifact_id,
        )) === undefined
      )
        throw new Error(
          `Artifact ${data.artifact_id} is not in this Thread. List this Thread's artifacts with the artifact tool.`,
        );
      await requestAttention(context.db, callingThreadId, {
        kind: data.kind,
        summary: data.summary,
        url: data.url,
        artifactId: data.artifact_id,
        requestedAt: new Date().toISOString(),
      });
      // A hint only: publication failures are logged, never thrown.
      await publishUserInvalidation(
        context.bindings,
        owner.ownerUserId as UserId,
        "needs-you.invalidated",
      );
      return {
        output: {
          listed: true,
          note: "This Thread is in the owner's Needs-you inbox until its next turn starts or the owner dismisses it. Now write your final reply, with your summary and the ask, and end your turn.",
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
