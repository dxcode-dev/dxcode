import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/**
 * Artifacts: Markdown documents that belong to one Thread, which its agent,
 * its owner, and the people it is shared with for Contribute edit together.
 * Every save is a new revision, made only against the revision it started
 * from (`baseRevision`); a save against an older revision is refused with
 * `ARTIFACT_CONFLICT` and the newer revision, so no save overwrites someone
 * else's. Bodies live in R2, one immutable object per revision.
 */

/** The largest Markdown body one revision holds, in UTF-8 bytes. */
export const ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
/**
 * The most revision bytes one Thread keeps across all its artifacts. Saves
 * past it are refused with `ARTIFACT_STORAGE_FULL`.
 */
export const THREAD_ARTIFACT_MAX_STORED_BYTES = 100 * 1024 * 1024;
/**
 * How many of an artifact's newest revisions are always kept. Older agent
 * revisions are removed, except the agent's newest; every revision a person
 * saved is kept.
 */
export const ARTIFACT_RECENT_REVISIONS_KEPT = 50;
export const ARTIFACT_TITLE_MAX_LENGTH = 200;
/** A folder is one name, one level deep: no `/`. */
export const ARTIFACT_FOLDER_MAX_LENGTH = 64;
/** A comment's text, and the quoted text it sits on, in characters. */
export const ARTIFACT_COMMENT_MAX_LENGTH = 8_000;
export const ARTIFACT_COMMENT_QUOTE_MAX_LENGTH = 1_000;
/** The most comments, replies included, one artifact holds. */
export const ARTIFACT_COMMENT_LIMIT = 500;

export const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{32}$/;
export const ThreadArtifactIdSchema = Schema.String.check(
  Schema.isPattern(ARTIFACT_ID_PATTERN),
);

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** One line of text, trimmed by the server; at most 200 characters. */
export const ThreadArtifactTitleSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(ARTIFACT_TITLE_MAX_LENGTH * 2),
);
/** `''` for the top level, else one folder name without `/`, such as `Plans`. */
export const ThreadArtifactFolderSchema = Schema.String.check(
  Schema.isMaxLength(ARTIFACT_FOLDER_MAX_LENGTH * 2),
);
/** The size is checked in UTF-8 bytes against `ARTIFACT_MAX_BYTES`. */
export const ThreadArtifactMarkdownSchema = Schema.String;

/** Who saved a revision: a person, or the Thread's agent. */
export const ThreadArtifactAuthorSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("agent") }),
  Schema.Struct({
    kind: Schema.Literal("user"),
    /** Null once that person's account is deleted. */
    userId: Schema.NullOr(Schema.String),
    name: Schema.NullOr(Schema.String),
  }),
]);
export type ThreadArtifactAuthor = typeof ThreadArtifactAuthorSchema.Type;

export const ThreadArtifactSchema = Schema.Struct({
  id: ThreadArtifactIdSchema,
  threadId: ThreadId,
  folder: Schema.String,
  title: Schema.String,
  /** The current revision; a save names it as its `baseRevision`. */
  revision: Revision,
  /** The current revision's Markdown size in UTF-8 bytes. */
  sizeBytes: Schema.Int,
  createdBy: ThreadArtifactAuthorSchema,
  /** Who saved the current revision. */
  updatedBy: ThreadArtifactAuthorSchema,
  /** Unresolved comments, replies not counted. */
  openCommentCount: Schema.Int,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type ThreadArtifact = typeof ThreadArtifactSchema.Type;

/** `GET /v1/threads/:threadId/artifacts`: newest first, without bodies. */
export const ThreadArtifactListResponseSchema = successResponse(
  Schema.Struct({ artifacts: Schema.Array(ThreadArtifactSchema) }),
);
export type ThreadArtifactListResponse =
  typeof ThreadArtifactListResponseSchema.Type;

/**
 * An artifact with its current Markdown: the answer to `GET`, to a create,
 * and to a save.
 */
export const ThreadArtifactResponseSchema = successResponse(
  Schema.Struct({
    artifact: ThreadArtifactSchema,
    markdown: ThreadArtifactMarkdownSchema,
  }),
);
export type ThreadArtifactResponse = typeof ThreadArtifactResponseSchema.Type;

/**
 * `GET /v1/threads/:threadId/artifacts/:artifactId/revisions/:revision`: one
 * kept revision. A revision never changes, so it may be cached.
 */
export const ThreadArtifactRevisionResponseSchema = successResponse(
  Schema.Struct({
    artifactId: ThreadArtifactIdSchema,
    revision: Revision,
    /** The revision this one was saved against; null for the first. */
    baseRevision: Schema.NullOr(Revision),
    author: ThreadArtifactAuthorSchema,
    createdAt: Schema.Number,
    markdown: ThreadArtifactMarkdownSchema,
  }),
);
export type ThreadArtifactRevisionResponse =
  typeof ThreadArtifactRevisionResponseSchema.Type;

/** `POST /v1/threads/:threadId/artifacts`. */
export const CreateThreadArtifactRequestSchema = Schema.Struct({
  title: ThreadArtifactTitleSchema,
  folder: Schema.optional(ThreadArtifactFolderSchema),
  markdown: ThreadArtifactMarkdownSchema,
});
export type CreateThreadArtifactRequest =
  typeof CreateThreadArtifactRequestSchema.Type;

/**
 * `PUT /v1/threads/:threadId/artifacts/:artifactId`: a new revision made
 * from `baseRevision`. `title` and `folder` rename or move it at the same
 * time. `force` saves even when the artifact has moved past `baseRevision`,
 * replacing the newer revision: only for an explicit "keep my version".
 */
export const SaveThreadArtifactRequestSchema = Schema.Struct({
  baseRevision: Revision,
  markdown: ThreadArtifactMarkdownSchema,
  title: Schema.optional(ThreadArtifactTitleSchema),
  folder: Schema.optional(ThreadArtifactFolderSchema),
  force: Schema.optional(Schema.Boolean),
});
export type SaveThreadArtifactRequest =
  typeof SaveThreadArtifactRequestSchema.Type;

/** `DELETE /v1/threads/:threadId/artifacts/:artifactId`. */
export const DeleteThreadArtifactResponseSchema = successResponse(
  Schema.Struct({ deleted: Schema.Literal(true) }),
);

export const ARTIFACT_COMMENT_ID_PATTERN = /^cmt_[0-9a-f]{32}$/;
export const ThreadArtifactCommentIdSchema = Schema.String.check(
  Schema.isPattern(ARTIFACT_COMMENT_ID_PATTERN),
);

/**
 * A comment on an artifact, stored beside its Markdown, never in it. A
 * top-level comment sits on `quote`; after each save dx finds the quote in
 * the new revision again and moves `anchor` there. `anchor` is null when the
 * quoted text is gone (the comment shows as detached) and for replies, which
 * follow their parent.
 */
export const ThreadArtifactCommentSchema = Schema.Struct({
  id: ThreadArtifactCommentIdSchema,
  artifactId: ThreadArtifactIdSchema,
  /** The comment this one replies to; null for a top-level comment. */
  parentId: Schema.NullOr(ThreadArtifactCommentIdSchema),
  /** The text the comment sits on; `''` for a reply. */
  quote: Schema.String,
  anchor: Schema.NullOr(
    Schema.Struct({
      revision: Revision,
      /** UTF-16 offsets of the quote in that revision's Markdown. */
      start: Schema.Int,
      end: Schema.Int,
    }),
  ),
  author: ThreadArtifactAuthorSchema,
  body: Schema.String,
  createdAt: Schema.Number,
  /** Set on a top-level comment when it is resolved; replies follow it. */
  resolvedAt: Schema.NullOr(Schema.Number),
});
export type ThreadArtifactComment = typeof ThreadArtifactCommentSchema.Type;

/**
 * `GET /v1/threads/:threadId/artifacts/:artifactId/comments`: every comment
 * and reply, oldest first, resolved ones included.
 */
export const ThreadArtifactCommentListResponseSchema = successResponse(
  Schema.Struct({ comments: Schema.Array(ThreadArtifactCommentSchema) }),
);
export type ThreadArtifactCommentListResponse =
  typeof ThreadArtifactCommentListResponseSchema.Type;

/**
 * `POST /v1/threads/:threadId/artifacts/:artifactId/comments`: a top-level
 * comment on `quote`, found in the current revision (the occurrence nearest
 * `near`, a UTF-16 offset, when it appears more than once), or a reply to
 * `parentId`.
 */
export const CreateThreadArtifactCommentRequestSchema = Schema.Union([
  Schema.Struct({
    quote: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(ARTIFACT_COMMENT_QUOTE_MAX_LENGTH),
    ),
    near: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    body: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(ARTIFACT_COMMENT_MAX_LENGTH),
    ),
  }),
  Schema.Struct({
    parentId: ThreadArtifactCommentIdSchema,
    body: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(ARTIFACT_COMMENT_MAX_LENGTH),
    ),
  }),
]);
export type CreateThreadArtifactCommentRequest =
  typeof CreateThreadArtifactCommentRequestSchema.Type;

/**
 * The comment a create or a resolve returns:
 * `POST .../comments/:commentId/resolve` resolves a top-level comment and
 * hides its replies with it.
 */
export const ThreadArtifactCommentResponseSchema = successResponse(
  Schema.Struct({ comment: ThreadArtifactCommentSchema }),
);
export type ThreadArtifactCommentResponse =
  typeof ThreadArtifactCommentResponseSchema.Type;

/** The largest image an artifact can hold, in bytes. */
export const ARTIFACT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * `POST /v1/threads/:threadId/artifacts/images?name=<file name>` with the
 * image's bytes as the body: a PNG, JPEG, GIF, or WebP, decided from its
 * first bytes. It is stored with the Thread (Thread storage), so only people
 * who can open the Thread see it, and it goes when the Thread is deleted.
 * Write it into an artifact as `![alt](url)`.
 */
export const ThreadArtifactImageResponseSchema = successResponse(
  Schema.Struct({
    id: Schema.String,
    url: Schema.String,
    name: Schema.String,
    mimeType: Schema.String,
    size: Schema.Int,
  }),
);
export type ThreadArtifactImageResponse =
  typeof ThreadArtifactImageResponseSchema.Type;

export const ThreadArtifactErrorCodeSchema = Schema.Literals([
  "INVALID_REQUEST",
  "ARTIFACT_NOT_FOUND",
  "ARTIFACT_COMMENT_NOT_FOUND",
  "ARTIFACT_QUOTE_NOT_FOUND",
  "ARTIFACT_COMMENT_LIMIT",
  "ARTIFACT_IMAGE_INVALID",
  "ARTIFACT_IMAGE_TOO_LARGE",
  "ARTIFACT_REVISION_NOT_FOUND",
  "ARTIFACT_CONFLICT",
  "ARTIFACT_TOO_LARGE",
  "ARTIFACT_STORAGE_FULL",
  "ARTIFACTS_UNAVAILABLE",
  "ARTIFACT_NOTIFY_DISABLED",
]);
export type ThreadArtifactErrorCode = typeof ThreadArtifactErrorCodeSchema.Type;

/**
 * Every refusal. `ARTIFACT_CONFLICT` carries the newer revision the save did
 * not start from, so the caller merges its change into it and saves again.
 */
export const ThreadArtifactErrorResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: ThreadArtifactErrorCodeSchema,
    message: Schema.String,
    requestId: Schema.String,
    current: Schema.optional(
      Schema.Struct({
        artifact: ThreadArtifactSchema,
        markdown: ThreadArtifactMarkdownSchema,
      }),
    ),
  }),
});
export type ThreadArtifactErrorResponse =
  typeof ThreadArtifactErrorResponseSchema.Type;

/** The experimental flag for Notify agent (#1765). */
export const ARTIFACT_NOTIFY_AGENT_FEATURE = "artifact-notify-agent";

/**
 * `POST /v1/threads/:threadId/artifacts/:artifactId/notify`: wakes the
 * Thread's agent once with what people changed since it last saved the
 * artifact. Only with the `artifact-notify-agent` flag on.
 */
export const NotifyArtifactAgentResponseSchema = successResponse(
  Schema.Struct({
    notified: Schema.Literal(true),
    /** The revision the agent was told about. */
    revision: Revision,
  }),
);
export type NotifyArtifactAgentResponse =
  typeof NotifyArtifactAgentResponseSchema.Type;
