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
import { ownerRequest } from "../threads/owner-request.js";
import { portalWidgetSource } from "./pages.js";
import { sha256Hex } from "./store.js";
import { portalFeedbackPrompt } from "./thread-prompt.js";

/**
 * Core's side of the Feedback Widget in a Thread's Portal (see
 * portals/feedback.ts): the widget's script, and
 * delivering comments to the Thread as the person's own message, through the
 * route the web client uses, so it is admitted with the same access checks.
 */

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
      const { response, payload } = await ownerRequest(
        {
          bindings,
          ownerUserId: input.userId as UserId,
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
