import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

export const THREAD_CHANGES_MAX_FILES = 200;
export const THREAD_CHANGES_MAX_COMMITS = 50;
export const THREAD_CHANGES_MAX_WORKTREES = 5;
export const THREAD_CHANGES_MAX_PATCH_BYTES = 256 * 1_024;
export const THREAD_CHANGES_MAX_PATH_LENGTH = 1_024;

const NonNegativeInt = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

const isRelativePath = (value: string) =>
  value.length > 0 &&
  value.length <= THREAD_CHANGES_MAX_PATH_LENGTH &&
  !value.startsWith("/") &&
  !value.endsWith("/") &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  value
    .split("/")
    .every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );

export const ThreadChangesPath = Schema.String.check(
  Schema.makeFilter(isRelativePath),
).pipe(Schema.brand("@dx/ThreadChangesPath"));
export type ThreadChangesPath = typeof ThreadChangesPath.Type;

export const ThreadChangesCaptureId = Schema.String.check(
  Schema.isMinLength(8),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
).pipe(Schema.brand("@dx/ThreadChangesCaptureId"));
export type ThreadChangesCaptureId = typeof ThreadChangesCaptureId.Type;

export const ThreadChangesWorktreeId = Schema.String.check(
  Schema.isPattern(/^(?:primary|wt_[a-f0-9]{16})$/),
).pipe(Schema.brand("@dx/ThreadChangesWorktreeId"));
export type ThreadChangesWorktreeId = typeof ThreadChangesWorktreeId.Type;

export const ThreadChangesCommitSha = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{40}$/),
).pipe(Schema.brand("@dx/ThreadChangesCommitSha"));
export type ThreadChangesCommitSha = typeof ThreadChangesCommitSha.Type;

export const ThreadChangesRangeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("uncommitted") }),
  Schema.Struct({
    kind: Schema.Literal("commit"),
    sha: ThreadChangesCommitSha,
  }),
]);
export type ThreadChangesRange = typeof ThreadChangesRangeSchema.Type;

export const ThreadChangesRangeQuerySchema = Schema.Struct({
  range: Schema.optional(Schema.String),
});

export const ThreadChangesDiffQuerySchema = Schema.Struct({
  range: Schema.optional(Schema.String),
  path: ThreadChangesPath,
  captureId: Schema.optional(ThreadChangesCaptureId),
  worktree: Schema.optional(ThreadChangesWorktreeId),
});

export const THREAD_CHANGES_SUBPROTOCOL = "dx-changes-v1";
export const ThreadChangesEventSchema = Schema.Struct({
  type: Schema.Literal("changes-updated"),
});

export const ThreadChangesParamsSchema = Schema.Struct({
  threadId: ThreadId,
});

export const ThreadChangedFileSchema = Schema.Struct({
  worktree: Schema.optional(ThreadChangesWorktreeId),
  path: ThreadChangesPath,
  status: Schema.Literals(["added", "deleted", "modified", "untracked"]),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  binary: Schema.Boolean,
  truncated: Schema.Boolean,
});
export type ThreadChangedFile = typeof ThreadChangedFileSchema.Type;

export const ThreadChangesWorktreeSchema = Schema.Struct({
  id: ThreadChangesWorktreeId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  head: ThreadChangesCommitSha,
  branch: Schema.optional(
    Schema.NullOr(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    ),
  ),
});
export type ThreadChangesWorktree = typeof ThreadChangesWorktreeSchema.Type;

export const ThreadChangesSummarySchema = Schema.Struct({
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  files: NonNegativeInt,
});
export type ThreadChangesSummary = typeof ThreadChangesSummarySchema.Type;

export const ThreadChangesCommitSchema = Schema.Struct({
  sha: ThreadChangesCommitSha,
  shortSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{7,40}$/)),
  subject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
});
export type ThreadChangesCommit = typeof ThreadChangesCommitSchema.Type;

const CapturedChangesFields = {
  captureId: ThreadChangesCaptureId,
  freshness: Schema.Literals(["complete", "stale"]),
  capturedAt: Schema.String.check(
    Schema.isMinLength(20),
    Schema.isMaxLength(40),
  ),
  dirtySince: Schema.optional(
    Schema.String.check(Schema.isMinLength(20), Schema.isMaxLength(40)),
  ),
};

export const ThreadChangesMissingDataSchema = Schema.Struct({
  kind: Schema.Literal("missing"),
});

export const ThreadChangesDataSchema = Schema.Struct({
  kind: Schema.Literal("changes"),
  ...CapturedChangesFields,
  range: ThreadChangesRangeSchema,
  truncated: Schema.Boolean,
  baseline: ThreadChangesCommitSha,
  head: ThreadChangesCommitSha,
  branch: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  upstreamLabel: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  ahead: NonNegativeInt,
  summary: ThreadChangesSummarySchema,
  files: Schema.Array(ThreadChangedFileSchema).check(
    Schema.isMaxLength(THREAD_CHANGES_MAX_FILES),
  ),
  worktrees: Schema.optional(
    Schema.Array(ThreadChangesWorktreeSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(THREAD_CHANGES_MAX_WORKTREES),
    ),
  ),
  commits: Schema.Array(ThreadChangesCommitSchema).check(
    Schema.isMaxLength(THREAD_CHANGES_MAX_COMMITS),
  ),
});
export type ThreadChangesData = typeof ThreadChangesDataSchema.Type;

export const ThreadChangesDiffDataSchema = Schema.Struct({
  kind: Schema.Literal("diff"),
  ...CapturedChangesFields,
  range: ThreadChangesRangeSchema,
  file: ThreadChangedFileSchema,
  patch: Schema.String.check(
    Schema.makeFilter(
      (value) =>
        !value.includes("\0") &&
        new TextEncoder().encode(value).byteLength <=
          THREAD_CHANGES_MAX_PATCH_BYTES,
    ),
  ),
});
export type ThreadChangesDiffData = typeof ThreadChangesDiffDataSchema.Type;

export const GetThreadChangesResponseSchema = successResponse(
  Schema.Union([ThreadChangesMissingDataSchema, ThreadChangesDataSchema]),
);
export const GetThreadChangesDiffResponseSchema = successResponse(
  ThreadChangesDiffDataSchema,
);

export const PushThreadChangesRequestSchema = Schema.Struct({
  expectedCaptureId: ThreadChangesCaptureId,
  idempotencyKey: Schema.String.check(
    Schema.isMinLength(8),
    Schema.isMaxLength(512),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  ),
  confirmation: Schema.Literal("push"),
});

export const PushThreadChangesResponseSchema = successResponse(
  Schema.Struct({
    kind: Schema.Literal("pushed"),
    status: Schema.Literals(["pushed", "already-succeeded"]),
    sha: Schema.optional(ThreadChangesCommitSha),
  }),
);

export const ThreadChangesInvalidRequestResponseSchema = errorResponse(
  "THREAD_CHANGES_INVALID_REQUEST",
  "The Changes request is invalid.",
);
export const ThreadChangesConflictResponseSchema = errorResponse(
  "THREAD_CHANGES_CONFLICT",
  "Changes became stale before the operation completed.",
);
export const ThreadChangesUnavailableResponseSchema = errorResponse(
  "THREAD_CHANGES_UNAVAILABLE",
  "Changes are temporarily unavailable.",
);

export type GetThreadChangesResponse =
  typeof GetThreadChangesResponseSchema.Encoded;
export type GetThreadChangesDiffResponse =
  typeof GetThreadChangesDiffResponseSchema.Encoded;
export type PushThreadChangesResponse =
  typeof PushThreadChangesResponseSchema.Encoded;
