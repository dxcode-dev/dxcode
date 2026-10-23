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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A daemon's candidate with every file whose patch Changes cannot show
 * (NUL bytes: git diffs a Git bundle as text, because it opens with a text
 * header) turned into a binary file without a patch, as git reports it once
 * the file is marked binary. Applied to the raw message before decoding, so
 * one such file never makes the whole candidate, or the daemon's
 * connection, invalid. Anything else passes through unchanged.
 */
export const repairCandidatePatches = (message: unknown): unknown => {
  if (!isRecord(message) || !isRecord(message.outcome)) return message;
  const capture = message.outcome.capture;
  if (!isRecord(capture) || !Array.isArray(capture.ranges)) return message;
  let repaired = false;
  const ranges = capture.ranges.map((range: unknown) => {
    if (!isRecord(range) || !Array.isArray(range.files)) return range;
    return {
      ...range,
      files: range.files.map((file: unknown) => {
        if (
          !isRecord(file) ||
          typeof file.patch !== "string" ||
          !file.patch.includes("\0")
        )
          return file;
        repaired = true;
        return { ...file, binary: true, truncated: false, patch: "" };
      }),
    };
  });
  return repaired
    ? {
        ...message,
        outcome: { ...message.outcome, capture: { ...capture, ranges } },
      }
    : message;
};
