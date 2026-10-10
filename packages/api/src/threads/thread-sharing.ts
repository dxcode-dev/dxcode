import { ThreadId, Timestamp, UserId } from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/** What the owner granted the workspace. */
export const ThreadWorkspaceAccessSchema = Schema.Literals([
  "none",
  "view",
  "contribute",
]);

export type ThreadWorkspaceAccess = typeof ThreadWorkspaceAccessSchema.Type;

/** What the requesting user may do in this Thread. */
export const ThreadViewerAccessSchema = Schema.Literals([
  "owner",
  "contribute",
  "view",
]);

export type ThreadViewerAccess = typeof ThreadViewerAccessSchema.Type;

/** How long Contribute (multiplayer) stays on. */
export const ThreadContributeDurationSchema = Schema.Literals([
  "1h",
  "3h",
  "3d",
  "7d",
]);

export type ThreadContributeDuration =
  typeof ThreadContributeDurationSchema.Type;

export const THREAD_CONTRIBUTE_DURATION_MS: Record<
  ThreadContributeDuration,
  number
> = {
  "1h": 60 * 60 * 1_000,
  "3h": 3 * 60 * 60 * 1_000,
  "3d": 3 * 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
};

/**
 * Effective workspace sharing. Contribute past `contributeUntil` is reported
 * as View: multiplayer ended but the Thread stays shared.
 */
export const ThreadSharingDataSchema = Schema.Struct({
  workspaceAccess: Schema.Literals(["view", "contribute"]),
  contributeUntil: Schema.optional(Timestamp),
});

export type ThreadSharingData = typeof ThreadSharingDataSchema.Type;

export const ThreadParticipantDataSchema = Schema.Struct({
  userId: UserId,
  name: Schema.String.check(Schema.isMaxLength(256)),
  /** Their username, shown as `@handle`. */
  handle: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  image: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
  owner: Schema.optional(Schema.Boolean),
});

export type ThreadParticipantData = typeof ThreadParticipantDataSchema.Type;

export const UpdateThreadSharingParamsSchema = Schema.Struct({
  threadId: ThreadId,
});

export const UpdateThreadSharingRequestSchema = Schema.Struct({
  workspaceAccess: ThreadWorkspaceAccessSchema,
  /** Contribute only; defaults to 7 days. */
  contributeFor: Schema.optional(ThreadContributeDurationSchema),
  /** Remember "Don't ask me again" for the multiplayer confirmation. */
  skipMultiplayerConfirmation: Schema.optional(Schema.Boolean),
});

export type UpdateThreadSharingRequest =
  typeof UpdateThreadSharingRequestSchema.Type;

export const UpdateThreadSharingResponseSchema = successResponse(
  Schema.Struct({
    threadId: ThreadId,
    sharing: Schema.optional(ThreadSharingDataSchema),
    skipMultiplayerConfirmation: Schema.Boolean,
  }),
);

export type UpdateThreadSharingResponseData =
  (typeof UpdateThreadSharingResponseSchema.Type)["data"];

export const ThreadSharingErrorCode = Schema.Literals([
  "INVALID_REQUEST",
  "THREAD_NOT_FOUND",
  "THREAD_SHARING_OWNER_ONLY",
  "THREAD_SHARING_UNAVAILABLE",
  "THREAD_READ_ONLY",
  "PERSISTENCE_UNAVAILABLE",
]);

export type ThreadSharingErrorCode = typeof ThreadSharingErrorCode.Type;

export const ThreadSharingErrorResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: ThreadSharingErrorCode,
    message: Schema.String,
    requestId: Schema.String,
  }),
});
