import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/** A file the message sent, as `parseMessageAttachments` reads it. */
const MessageAttachmentSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
  url: Schema.String,
});

/**
 * A message the viewer sent while the agent worked, waiting in the Thread's
 * queue for the agent to read it. Until then it can be edited in place or
 * withdrawn. `original` is its text exactly as the agent will get it, author
 * tag included; `text` is what the person wrote.
 */
export const ThreadQueuedMessageSchema = Schema.Struct({
  submissionId: Schema.String,
  text: Schema.String,
  original: Schema.String,
  attachments: Schema.Array(MessageAttachmentSchema),
  createdAt: Schema.String,
});
export type ThreadQueuedMessage = typeof ThreadQueuedMessageSchema.Type;

/** `GET /v1/threads/:threadId/messages/queued`: the viewer's own, in order. */
export const ListThreadQueuedMessagesResponseSchema = successResponse(
  Schema.Struct({ messages: Schema.Array(ThreadQueuedMessageSchema) }),
);

const idempotencyKey = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
);

/**
 * `POST /v1/threads/:threadId/messages/queued/:submissionId/edit`: replaces
 * a message the agent has not read. If the agent took it first, the edit
 * restarts from it, as editing a read message does.
 */
export const EditQueuedThreadMessageRequestSchema = Schema.Struct({
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200_000)),
  idempotencyKey,
});
export type EditQueuedThreadMessageRequest =
  typeof EditQueuedThreadMessageRequestSchema.Type;

export const EditQueuedThreadMessageResponseSchema = successResponse(
  Schema.Struct({
    /** `replaced`: the agent never saw the old text. `restarted`: it had. */
    outcome: Schema.Literals(["replaced", "restarted"]),
    submissionId: Schema.String,
  }),
);

/**
 * Deletes a message: `POST …/messages/queued/:submissionId/delete` withdraws
 * one the agent has not read; `POST …/messages/:entryId/delete` takes the
 * conversation back to just before one it read, and sends nothing in its
 * place. `original` is the read message's text as the transcript shows it,
 * author tag included, as an edit sends it.
 */
export const DeleteThreadMessageRequestSchema = Schema.Struct({
  idempotencyKey,
  original: Schema.optional(Schema.String.check(Schema.isMaxLength(1_000_000))),
});
export type DeleteThreadMessageRequest =
  typeof DeleteThreadMessageRequestSchema.Type;

export const DeleteThreadMessageResponseSchema = successResponse(
  Schema.Struct({ outcome: Schema.Literals(["withdrawn", "rewound"]) }),
);

const MESSAGE_READ_MESSAGE =
  "The agent read this message before the change arrived." as const;

/** Why a queued edit or a delete was refused. Nothing changed. */
export const ThreadMessageQueueErrorResponseSchema = Schema.Union([
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
    "Only the person who sent a message can change it.",
  ),
  errorResponse(
    "MESSAGE_CHANGED",
    "This message is no longer in the conversation as shown. Reload and try again.",
  ),
  /** The agent took a queued message first; `entryId` names it now. */
  Schema.Struct({
    status: Schema.Literal("error"),
    data: Schema.Struct({
      code: Schema.Literal("MESSAGE_READ"),
      message: Schema.Literal(MESSAGE_READ_MESSAGE),
      requestId: Schema.String,
      entryId: Schema.String,
    }),
  }),
  errorResponse(
    "MESSAGE_GONE",
    "This message is no longer waiting or in the conversation.",
  ),
  errorResponse(
    "AGENT_BUSY",
    "The agent did not stop in time. Try again in a moment.",
  ),
  errorResponse(
    "EDIT_NOT_SENT",
    "The conversation went back to before your message, but the edited message was not sent. Send it again.",
  ),
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  ),
]);
export type ThreadMessageQueueErrorCode =
  (typeof ThreadMessageQueueErrorResponseSchema.Type)["data"]["code"];
