import type { UserId } from "@dx/domain";
import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import { publishUserInvalidation } from "../realtime/publication.js";
import type { ThreadToolsContext } from "../threads/agent-tools.js";
import { readCallingThread } from "../threads/calling-thread.js";
import { requestAttention } from "./repository.js";

/**
 * `request_attention`: the agent lists its Thread in the owner's Needs-you
 * inbox. The Thread's next turn starting, which the owner's reply causes, or
 * the owner's Dismiss clears it (`threads/activity.ts`, `routes.ts`).
 */
export const createNeedsYouTools = (
  callingThreadId: string,
  getContext: () => ThreadToolsContext,
): ToolDefinition[] => [
  defineTool({
    name: "request_attention",
    description: [
      "List this Thread in its owner's Needs-you inbox, which shows every Thread waiting on them across their projects. Call it when you end your turn waiting on the owner: a question only they can answer, or an approval they must give. Then end your turn.",
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
    }),
    run: async ({ data }) => {
      const context = getContext();
      const owner = await readCallingThread(context.db, callingThreadId);
      await requestAttention(context.db, callingThreadId, {
        kind: data.kind,
        summary: data.summary,
        url: data.url,
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
          note: "This Thread is in the owner's Needs-you inbox until its next turn starts or the owner dismisses it. End your turn now.",
        },
      };
    },
  }),
];
