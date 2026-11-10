import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/**
 * `POST /v1/threads/:threadId/messages/:entryId/edit`: a person replaces one
 * of their earlier messages. The Thread's agent stops, the conversation goes
 * back to just before that message, and the edited message is sent in its
 * place. The turns after it leave the transcript and the agent's context;
 * files, artifacts, child Threads, and costs they produced stay.
 *
 * `original` is the message's text exactly as the transcript shows it, its
 * author tag included: the server checks the sender from it, and the agent
 * refuses the edit when the message no longer has that text.
 * `idempotencyKey` names the edit, so a retry converges on it.
 */
export const EditThreadMessageRequestSchema = Schema.Struct({
  original: Schema.String.check(Schema.isMaxLength(1_000_000)),
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200_000)),
  idempotencyKey: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(200),
  ),
});
export type EditThreadMessageRequest =
  typeof EditThreadMessageRequestSchema.Type;

export const EditThreadMessageResponseSchema = successResponse(
  Schema.Struct({ submissionId: Schema.String }),
);

/** The Flue entry id of a user message, as the transcript names it. */
export const THREAD_MESSAGE_ENTRY_ID = /^entry_[A-Za-z0-9_-]{1,400}$/;

/** Why an edit was refused. Nothing changed unless the code says so. */
export const EditThreadMessageErrorResponseSchema = Schema.Union([
  errorResponse("INVALID_REQUEST", "Request validation failed."),
  errorResponse("THREAD_NOT_FOUND", "Thread was not found."),
  errorResponse(
    "THREAD_ARCHIVED",
    "Thread is archived. Unarchive it before continuing.",
  ),
  errorResponse(
    "SPACE_POSTS_EDIT_IN_PLACE",
    "Edit a Space's posts from the post.",
  ),
  errorResponse(
    "MESSAGE_NOT_YOURS",
    "Only the person who sent a message can edit it.",
  ),
  errorResponse(
    "MESSAGE_CHANGED",
    "This message is no longer in the conversation as shown. Reload and try again.",
  ),
  errorResponse(
    "AGENT_BUSY",
    "The agent did not stop in time. Try again in a moment.",
  ),
  /** The conversation was rewound, but the edited message was not sent. */
  errorResponse(
    "EDIT_NOT_SENT",
    "The conversation went back to before your message, but the edited message was not sent. Send it again.",
  ),
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  ),
]);
export type EditThreadMessageErrorCode =
  (typeof EditThreadMessageErrorResponseSchema.Type)["data"]["code"];
