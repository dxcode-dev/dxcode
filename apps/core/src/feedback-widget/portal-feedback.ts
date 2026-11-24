import { FeedbackWidgetSendRequestSchema } from "@dx/api";
import type { UserId } from "@dx/domain";
import { Option, Schema } from "effect";
import type { Bindings } from "../http/types.js";
import { feedbackWidgetLogger } from "../logging.js";
import {
  PORTAL_FEEDBACK_SCRIPT_PATH,
  PORTAL_FEEDBACK_SEND_PATH,
  type PortalFeedbackResult,
  type PortalFeedbackSend,
  type PortalFeedbackService,
} from "../portals/feedback.js";
import { takeRequestBudget } from "../security/request-budget.js";
import { ownerRequest } from "../threads/owner-request.js";
import { portalWidgetSource } from "./pages.js";
import { sha256Hex } from "./store.js";
import { portalFeedbackPrompt } from "./thread-prompt.js";

/**
 * Core's side of the Feedback Widget in a Thread's Portal (see
 * portals/feedback.ts): the widget's script, and
 * delivering comments to the Thread through the route the web client uses,
 * so it is admitted with the same access checks. The message is marked as
 * from outside dx: any script on the page can send it.
 */

/**
 * Sends one person may make to one Thread from its Portal (#2437). Any script
 * on the page can post, and each send is a message of up to 128 KiB.
 */
export const PORTAL_FEEDBACK_BUDGETS = [
  { maximum: 10, windowMs: 60_000 },
  { maximum: 60, windowMs: 60 * 60_000 },
] as const;

const failure = (
  status: number,
  code: string,
  message: string,
): PortalFeedbackResult => ({
  status,
  body: { status: "error", data: { code, message } },
});

export const portalFeedbackService = (
  bindings: Bindings,
  waitUntil?: (promise: Promise<unknown>) => void,
): PortalFeedbackService => {
  return {
    async script() {
      return portalWidgetSource({
        scriptPath: PORTAL_FEEDBACK_SCRIPT_PATH,
        sendPath: PORTAL_FEEDBACK_SEND_PATH,
      });
    },
    async send(input: PortalFeedbackSend) {
      const decoded = Schema.decodeUnknownOption(
        FeedbackWidgetSendRequestSchema,
      )(input.body);
      if (Option.isNone(decoded))
        return failure(400, "INVALID_REQUEST", "Request validation failed.");
      const comments = decoded.value.comments;
      const elsewhere = comments.some((comment) => {
        try {
          return new URL(comment.pageUrl).origin !== input.origin;
        } catch {
          return true;
        }
      });
      if (elsewhere)
        return failure(
          403,
          "FEEDBACK_WIDGET_ORIGIN_NOT_ALLOWED",
          "Every comment must be on a page of this Portal.",
        );
      const db = bindings.DB;
      if (db === undefined)
        return failure(
          503,
          "UNAVAILABLE",
          "Feedback is unavailable right now.",
        );
      for (const budget of PORTAL_FEEDBACK_BUDGETS)
        if (
          !(await takeRequestBudget(
            db,
            `portal-feedback:${budget.windowMs}:${input.userId}:${input.threadId}`,
            budget,
          ))
        ) {
          feedbackWidgetLogger.warn("Portal feedback was rate limited.", {
            event: "portal_feedback_rate_limited",
            threadId: input.threadId,
            userId: input.userId,
          });
          return failure(
            429,
            "RATE_LIMITED",
            "Too many comments were sent to this Thread. Try again later.",
          );
        }
      const { response, payload } = await ownerRequest(
        {
          bindings,
          ownerUserId: input.userId as UserId,
          // Any script on the Portal's page can post here, so the text is
          // the page's, not the owner's word: tools that act only on the
          // owner's own word (manage_dx) refuse it.
          automation: "external",
          ...(waitUntil === undefined ? {} : { waitUntil }),
        },
        "POST",
        `/v1/agents/dx/${encodeURIComponent(input.threadId)}`,
        {
          kind: "user",
          body: portalFeedbackPrompt(comments, input.port),
          idempotencyKey: await sha256Hex(crypto.randomUUID()),
        },
      );
      if (response.status !== 202) {
        const refused = payload?.data as
          | { code?: string; message?: string }
          | undefined;
        feedbackWidgetLogger.warn("Portal feedback was not delivered.", {
          event: "portal_feedback_send_failed",
          threadId: input.threadId,
          userId: input.userId,
          status: response.status,
          code: refused?.code,
        });
        return failure(
          response.status === 503 ? 503 : 422,
          refused?.code ?? "FEEDBACK_NOT_DELIVERED",
          refused?.message ?? "dx could not send the comments to this Thread.",
        );
      }
      feedbackWidgetLogger.info("Portal feedback delivered.", {
        event: "portal_feedback_send",
        threadId: input.threadId,
        userId: input.userId,
        comments: comments.length,
      });
      return {
        status: 201,
        body: { status: "success", data: { threadId: input.threadId } },
      };
    },
  };
};
