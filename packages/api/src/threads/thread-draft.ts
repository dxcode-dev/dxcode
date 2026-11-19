import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/** The longest draft a person can keep in one composer. */
export const THREAD_DRAFT_MAX_LENGTH = 65_536;

export const ThreadDraftText = Schema.String.check(
  Schema.isMaxLength(THREAD_DRAFT_MAX_LENGTH),
);

/**
 * A box inside a Thread other than its composer, as `?slot=` names it:
 * `post-comment:<message id>` (the comment box under a Space post),
 * `artifact-comment:<artifact id>` (a new comment on a Thread's artifact), or
 * `artifact-reply:<comment id>` (a reply to an artifact comment). Absent, the
 * draft is the Thread's own composer, a Space's included.
 */
export const ThreadDraftSlot = Schema.String.check(
  Schema.isPattern(
    /^(?:post-comment|artifact-comment|artifact-reply):[A-Za-z0-9_.:-]{1,160}$/u,
  ),
);
export type ThreadDraftSlot = typeof ThreadDraftSlot.Type;

export const ThreadDraftParamsSchema = Schema.Struct({
  threadId: ThreadId,
  slot: Schema.optional(ThreadDraftSlot),
});

/**
 * `GET /v1/threads/:threadId/draft[?slot=]`, and `PUT` with `{ text }`: the
 * signed-in person's unsent text in one of this Thread's boxes, the same on
 * each of their devices. The last write wins; `""` means no draft.
 */
export const ThreadDraftResponseSchema = successResponse(
  Schema.Struct({ text: ThreadDraftText }),
);
export type ThreadDraftResponse = typeof ThreadDraftResponseSchema.Type;

export const UpdateThreadDraftRequestSchema = Schema.Struct({
  text: ThreadDraftText,
});

export const ThreadDraftErrorResponseSchema = Schema.Union([
  errorResponse("INVALID_REQUEST", "Request validation failed."),
  errorResponse("THREAD_NOT_FOUND", "Thread was not found."),
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  ),
]);

/**
 * A composer that starts something before any Thread exists: New Thread, or
 * New Space (whose draft is its form as JSON).
 */
export const WorkspaceDraftSlot = Schema.Literals(["new-thread", "new-space"]);
export type WorkspaceDraftSlot = typeof WorkspaceDraftSlot.Type;

/** A workspace's id, or `personal` outside any workspace. */
export const WorkspaceDraftKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u),
);

export const WorkspaceDraftParamsSchema = Schema.Struct({
  workspace: WorkspaceDraftKey,
  slot: WorkspaceDraftSlot,
});

/**
 * `GET /v1/drafts/workspaces/:workspace/:slot`, and `PUT` with `{ text }`:
 * the signed-in person's unsent New Thread or New Space in that workspace,
 * the same on each of their devices. Shares the Thread draft's bodies.
 */
export const WorkspaceDraftErrorResponseSchema = Schema.Union([
  errorResponse("INVALID_REQUEST", "Request validation failed."),
  errorResponse("WORKSPACE_NOT_FOUND", "Workspace was not found."),
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  ),
]);
