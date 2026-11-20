import { ProjectId, ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/**
 * dx Mail (wiki/agent-mail.md): one mailbox per person at
 * `username@<mail domain>`. Everything here exists only when the deployment
 * sets a mail domain; otherwise `GET /v1/mailbox` answers `enabled: false`.
 */

export const MailId = Schema.String.check(
  Schema.isPattern(/^mail_[0-9a-f]{32}$/),
);
export const MailLabelId = Schema.String.check(
  Schema.isPattern(/^mlb_[0-9a-f]{32}$/),
);

export const MailFolderSchema = Schema.Literals([
  "inbox",
  "sent",
  "archive",
  "spam",
]);
export type MailFolder = typeof MailFolderSchema.Type;

export const MailAgentAccessSchema = Schema.Literals([
  "all",
  "project",
  "none",
]);
export type MailAgentAccess = typeof MailAgentAccessSchema.Type;

export const MailAddressSchema = Schema.Struct({
  /** The display name, when the header gave one. */
  name: Schema.optional(Schema.String),
  address: Schema.String,
});
export type MailAddress = typeof MailAddressSchema.Type;

export const MailLabelSchema = Schema.Struct({
  id: MailLabelId,
  name: Schema.String,
  /** `user`: the person's own. `auto`: dx's automatic labelling. */
  kind: Schema.Literals(["user", "auto"]),
  /** Unread conversations in the Inbox with this label. */
  unread: Schema.Number,
});
export type MailLabel = typeof MailLabelSchema.Type;

/** A label on an email, and whether dx put it there automatically. */
export const MailItemLabelSchema = Schema.Struct({
  id: MailLabelId,
  name: Schema.String,
  automatic: Schema.Boolean,
});

/** One of the person's `+tag` addresses. */
export const MailProjectTagSchema = Schema.Struct({
  tag: Schema.String,
  projectId: ProjectId,
  projectName: Schema.String,
  address: Schema.String,
  unread: Schema.Number,
});
export type MailProjectTag = typeof MailProjectTagSchema.Type;

export const MailboxDataSchema = Schema.Union([
  Schema.Struct({ enabled: Schema.Literal(false) }),
  Schema.Struct({
    enabled: Schema.Literal(true),
    domain: Schema.String,
    username: Schema.String,
    /** `username@<domain>`. */
    address: Schema.String,
    /**
     * The person must pick a username before Mail opens: theirs is
     * a placeholder (`user-<hex>`) or a reserved name. That pick does not
     * use up their one change.
     */
    needsUsername: Schema.Boolean,
    /** They may still change their username once. */
    canChangeUsername: Schema.Boolean,
    canSend: Schema.Boolean,
    /** Why sending is off, in words the person reads. */
    sendingBlockedReason: Schema.optional(Schema.String),
    agentAccess: MailAgentAccessSchema,
    unread: Schema.Struct({
      inbox: Schema.Number,
      spam: Schema.Number,
    }),
    labels: Schema.Array(MailLabelSchema),
    projects: Schema.Array(MailProjectTagSchema),
    privateSenders: Schema.Array(Schema.String),
    limits: Schema.Struct({
      sendsPerDay: Schema.Number,
      recipientsPerEmail: Schema.Number,
      attachmentBytes: Schema.Number,
      sentToday: Schema.Number,
    }),
  }),
]);
export type MailboxData = typeof MailboxDataSchema.Type;
export const GetMailboxResponseSchema = successResponse(MailboxDataSchema);
export type GetMailboxResponse = typeof GetMailboxResponseSchema.Type;

/** One email conversation in a list. */
export const MailConversationSummarySchema = Schema.Struct({
  key: Schema.String,
  subject: Schema.String,
  /** The other people in it, newest first. */
  participants: Schema.Array(MailAddressSchema),
  latestAt: Schema.String,
  count: Schema.Number,
  unread: Schema.Boolean,
  preview: Schema.String,
  labels: Schema.Array(MailItemLabelSchema),
  tag: Schema.optional(Schema.String),
  private: Schema.Boolean,
  hasAttachments: Schema.Boolean,
  /** Every received email in it passed DMARC for its sender's domain. */
  authenticated: Schema.Boolean,
  /** Some agent read an email in it. */
  readByAgent: Schema.Boolean,
});
export type MailConversationSummary = typeof MailConversationSummarySchema.Type;

export const MailConversationListSchema = Schema.Struct({
  conversations: Schema.Array(MailConversationSummarySchema),
  /** Pass as `?before=` for the next, older page. */
  nextCursor: Schema.optional(Schema.String),
});
export const ListMailConversationsResponseSchema = successResponse(
  MailConversationListSchema,
);
export type ListMailConversationsResponse =
  typeof ListMailConversationsResponseSchema.Type;

export const MailAttachmentSchema = Schema.Struct({
  index: Schema.Number,
  filename: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
});

/** One email, opened. */
export const MailMessageSchema = Schema.Struct({
  id: MailId,
  direction: Schema.Literals(["in", "out"]),
  folder: MailFolderSchema,
  from: MailAddressSchema,
  to: Schema.Array(MailAddressSchema),
  cc: Schema.Array(MailAddressSchema),
  subject: Schema.String,
  receivedAt: Schema.String,
  text: Schema.String,
  /** For a sandboxed frame; absent for plain-text mail. */
  html: Schema.optional(Schema.String),
  attachments: Schema.Array(MailAttachmentSchema),
  authenticated: Schema.Boolean,
  labels: Schema.Array(MailItemLabelSchema),
  tag: Schema.optional(Schema.String),
  private: Schema.Boolean,
  read: Schema.Boolean,
  /** The agents that read it: "Read by agent in …". */
  readBy: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      title: Schema.String,
      readAt: Schema.String,
    }),
  ),
  /** The Thread this email started or followed up. */
  thread: Schema.optional(
    Schema.Struct({
      threadId: ThreadId,
      title: Schema.String,
      kind: Schema.Literals(["started", "followed_up"]),
    }),
  ),
  /** Why it is in Spam, in words, when dx put it there. */
  spamReason: Schema.optional(Schema.String),
  /**
   * For mail that isn't authenticated: `unverified` when its domain's own
   * servers sent it (SPF or an aligned signature, no DMARC verdict),
   * `untrusted` when dx filed it as Spam, wherever it is now.
   */
  trust: Schema.optional(Schema.Literals(["unverified", "untrusted"])),
});
export type MailMessage = typeof MailMessageSchema.Type;

export const MailConversationSchema = Schema.Struct({
  key: Schema.String,
  subject: Schema.String,
  messages: Schema.Array(MailMessageSchema),
});
export type MailConversation = typeof MailConversationSchema.Type;
export const GetMailConversationResponseSchema = successResponse(
  MailConversationSchema,
);
export type GetMailConversationResponse =
  typeof GetMailConversationResponseSchema.Type;

/** Changes to a whole conversation. */
export const UpdateMailConversationRequestSchema = Schema.Struct({
  read: Schema.optional(Schema.Boolean),
  folder: Schema.optional(Schema.Literals(["inbox", "archive", "spam"])),
  private: Schema.optional(Schema.Boolean),
  addLabels: Schema.optional(Schema.Array(MailLabelId)),
  removeLabels: Schema.optional(Schema.Array(MailLabelId)),
});
export type UpdateMailConversationRequest =
  typeof UpdateMailConversationRequestSchema.Type;

export const MailLabelNameSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(40),
);
export const CreateMailLabelRequestSchema = Schema.Struct({
  name: MailLabelNameSchema,
});
export const UpdateMailLabelRequestSchema = Schema.Struct({
  name: MailLabelNameSchema,
});
export const MailLabelResponseSchema = successResponse(MailLabelSchema);

export const UpdateMailboxSettingsRequestSchema = Schema.Struct({
  agentAccess: Schema.optional(MailAgentAccessSchema),
  /** Senders whose mail is always private. */
  addPrivateSender: Schema.optional(Schema.String),
  removePrivateSender: Schema.optional(Schema.String),
});

/**
 * `GET /v1/deployment-admin/users/lookup?q=`: one person by sign-in email or
 * username (current or retired), with what an admin can change for them.
 * Exact matches only, so it lists nobody.
 */
export const DeploymentAdminPersonSchema = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  email: Schema.String,
  username: Schema.String,
  usernameChangeAvailable: Schema.Boolean,
  mailSendingSuspended: Schema.Boolean,
});
export type DeploymentAdminPerson = typeof DeploymentAdminPersonSchema.Type;
export const DeploymentAdminPersonResponseSchema = successResponse(
  DeploymentAdminPersonSchema,
);

/** A deployment admin pauses (or resumes) a person's sending. */
export const SetMailSendingRequestSchema = Schema.Struct({
  suspended: Schema.Boolean,
});
export const SetMailSendingResponseSchema = successResponse(
  Schema.Struct({ userId: Schema.String, suspended: Schema.Boolean }),
);

const Recipients = Schema.Array(Schema.String).check(Schema.isMaxLength(20));

/** An attachment the person sends, base64. */
export const OutgoingAttachmentSchema = Schema.Struct({
  filename: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  mimeType: Schema.String.check(Schema.isMaxLength(255)),
  contentBase64: Schema.String,
});

export const SendMailRequestSchema = Schema.Struct({
  to: Recipients,
  cc: Schema.optional(Recipients),
  bcc: Schema.optional(Recipients),
  subject: Schema.String.check(Schema.isMaxLength(998)),
  text: Schema.String.check(Schema.isMaxLength(200_000)),
  /** The email this replies to, or forwards. */
  replyTo: Schema.optional(MailId),
  forwardOf: Schema.optional(MailId),
  /** Send from `username+tag@` instead of `username@`. */
  fromTag: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(OutgoingAttachmentSchema)),
});
export type SendMailRequest = typeof SendMailRequestSchema.Type;
export const SendMailResponseSchema = successResponse(
  Schema.Struct({ id: MailId, conversationKey: Schema.String }),
);

/*
 * Start thread (`POST /v1/mailbox/messages/:id/start-thread`) takes the New
 * Thread composer's own request, `CreateThreadRequestSchema`, and answers as
 * `POST /v1/threads` does, `CreateThreadResponseSchema`.
 */

/** Project Settings → Email: the person's address and the defaults. */
export const ProjectMailDataSchema = Schema.Union([
  Schema.Struct({ enabled: Schema.Literal(false) }),
  Schema.Struct({
    enabled: Schema.Literal(true),
    /** The viewer's own `username+tag@` for this Project. */
    address: Schema.String,
  }),
]);
export type ProjectMailData = typeof ProjectMailDataSchema.Type;
export const GetProjectMailResponseSchema = successResponse(
  ProjectMailDataSchema,
);
export type GetProjectMailResponse = typeof GetProjectMailResponseSchema.Type;
export const MailErrorCodeSchema = Schema.Literals([
  "MAIL_DISABLED",
  "MAIL_NOT_FOUND",
  "MAIL_INVALID_REQUEST",
  "MAIL_USERNAME_REQUIRED",
  "MAIL_SENDING_BLOCKED",
  "MAIL_SEND_LIMIT",
  "MAIL_SEND_FAILED",
  "MAIL_FORBIDDEN",
]);
export type MailErrorCode = typeof MailErrorCodeSchema.Type;
export const MailErrorResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: MailErrorCodeSchema,
    message: Schema.String,
    requestId: Schema.String,
  }),
});

export const MailNotFoundResponseSchema = errorResponse(
  "MAIL_NOT_FOUND",
  "That email was not found.",
);
