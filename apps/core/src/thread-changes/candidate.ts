import {
  THREAD_CHANGES_MAX_COMMITS,
  THREAD_CHANGES_MAX_FILES,
  THREAD_CHANGES_MAX_PATCH_BYTES,
  THREAD_CHANGES_MAX_WORKTREES,
  ThreadChangedFileSchema,
  ThreadChangesCommitSchema,
  ThreadChangesCommitSha,
  ThreadChangesRangeSchema,
  ThreadChangesWorktreeSchema,
} from "@dx/api";
import { Schema } from "effect";
import { utf8ExceedsBytes } from "../encoding/utf8.js";

const NonNegativeInt = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

export const ThreadChangesFingerprint = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/),
);

const ThreadChangesPatch = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      !value.includes("\0") &&
      !utf8ExceedsBytes(value, THREAD_CHANGES_MAX_PATCH_BYTES),
  ),
);

export const ThreadChangesCandidateFileSchema = Schema.Struct({
  ...ThreadChangedFileSchema.fields,
  patch: ThreadChangesPatch,
});

export const ThreadChangesCandidateRangeSchema = Schema.Struct({
  range: ThreadChangesRangeSchema,
  truncated: Schema.Boolean,
  summary: Schema.Struct({
    additions: NonNegativeInt,
    deletions: NonNegativeInt,
    files: NonNegativeInt,
  }),
  files: Schema.Array(ThreadChangesCandidateFileSchema).check(
    Schema.isMaxLength(THREAD_CHANGES_MAX_FILES),
  ),
});

export const ThreadChangesCandidateContentSchema = Schema.Struct({
  fingerprint: ThreadChangesFingerprint,
  baseline: ThreadChangesCommitSha,
  head: ThreadChangesCommitSha,
  branch: Schema.NullOr(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  upstreamLabel: Schema.NullOr(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  ahead: NonNegativeInt,
  commits: Schema.Array(ThreadChangesCommitSchema).check(
    Schema.isMaxLength(THREAD_CHANGES_MAX_COMMITS),
  ),
  worktrees: Schema.optional(
    Schema.Array(ThreadChangesWorktreeSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(THREAD_CHANGES_MAX_WORKTREES),
    ),
  ),
  ranges: Schema.Array(ThreadChangesCandidateRangeSchema).check(
    Schema.isMaxLength(THREAD_CHANGES_MAX_COMMITS + 2),
  ),
});
export type ThreadChangesCandidateContent =
  typeof ThreadChangesCandidateContentSchema.Type;
