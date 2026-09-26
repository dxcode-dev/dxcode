import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { ThreadChangesWorktreeId } from "./changes.js";

export const THREAD_FILES_MAX_PATH_LENGTH = 1_024;
export const THREAD_FILES_MAX_TREE_PAGE_SIZE = 100;
export const THREAD_FILES_MAX_EDITABLE_BYTES = 256 * 1_024;

const NonNegativeInt = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const utf8 = new TextEncoder();
const hasControlCharacter = (value: string) =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });

const isFilesPath = (value: string) =>
  value.length > 0 &&
  value.length <= THREAD_FILES_MAX_PATH_LENGTH &&
  !value.startsWith("/") &&
  !value.endsWith("/") &&
  !value.includes("\\") &&
  !hasControlCharacter(value) &&
  value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        segment !== ".git" &&
        !segment.startsWith(".dx-files-"),
    );

export const ThreadFilesPath = Schema.String.check(
  Schema.makeFilter(isFilesPath),
).pipe(Schema.brand("@dx/ThreadFilesPath"));
export type ThreadFilesPath = typeof ThreadFilesPath.Type;

export const ThreadFilesWorktreeId = ThreadChangesWorktreeId;
export type ThreadFilesWorktreeId = typeof ThreadFilesWorktreeId.Type;

export const ThreadFilesCursor = Schema.String.check(
  Schema.isMinLength(8),
  Schema.isMaxLength(2_048),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
).pipe(Schema.brand("@dx/ThreadFilesCursor"));
export type ThreadFilesCursor = typeof ThreadFilesCursor.Type;

export const ThreadFileVersion = Schema.String.check(
  Schema.isPattern(/^sha256:[a-f0-9]{64}$/),
).pipe(Schema.brand("@dx/ThreadFileVersion"));
export type ThreadFileVersion = typeof ThreadFileVersion.Type;

export const ThreadFilesParamsSchema = Schema.Struct({ threadId: ThreadId });

export const ThreadFileTreeQuerySchema = Schema.Struct({
  worktree: Schema.optional(ThreadFilesWorktreeId),
  path: Schema.optional(ThreadFilesPath),
  cursor: Schema.optional(ThreadFilesCursor),
});

export const ThreadFileTreeEntrySchema = Schema.Struct({
  path: ThreadFilesPath,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  kind: Schema.Literals(["file", "directory", "symlink"]),
  sizeBytes: Schema.optional(NonNegativeInt),
});
export type ThreadFileTreeEntry = typeof ThreadFileTreeEntrySchema.Type;

export const ThreadFileTreeDataSchema = Schema.Struct({
  kind: Schema.Literal("tree"),
  path: Schema.optional(ThreadFilesPath),
  version: ThreadFileVersion,
  entries: Schema.Array(ThreadFileTreeEntrySchema).check(
    Schema.isMaxLength(THREAD_FILES_MAX_TREE_PAGE_SIZE),
  ),
  nextCursor: Schema.optional(ThreadFilesCursor),
});
export type ThreadFileTreeData = typeof ThreadFileTreeDataSchema.Type;

const FileFields = {
  path: ThreadFilesPath,
  language: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  mediaType: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
  sizeBytes: NonNegativeInt,
};

export const ThreadEditableFileDataSchema = Schema.Struct({
  kind: Schema.Literal("file"),
  ...FileFields,
  editable: Schema.Literal(true),
  contentVersion: ThreadFileVersion,
  content: Schema.String.check(
    Schema.makeFilter(
      (value) =>
        !value.includes("\0") &&
        utf8.encode(value).byteLength <= THREAD_FILES_MAX_EDITABLE_BYTES,
    ),
  ),
});

export const ThreadReadonlyFileDataSchema = Schema.Struct({
  kind: Schema.Literal("file"),
  ...FileFields,
  editable: Schema.Literal(false),
  readonlyReason: Schema.Literals(["binary", "encoding", "too-large"]),
  content: Schema.String.check(
    Schema.makeFilter(
      (value) =>
        utf8.encode(value).byteLength <= THREAD_FILES_MAX_EDITABLE_BYTES,
    ),
  ),
});

export const ThreadFileDataSchema = Schema.Union([
  ThreadEditableFileDataSchema,
  ThreadReadonlyFileDataSchema,
]);
export type ThreadFileData = typeof ThreadFileDataSchema.Type;

export const SaveThreadFileRequestSchema = Schema.Struct({
  expectedVersion: ThreadFileVersion,
  content: Schema.String.check(
    Schema.makeFilter(
      (value) =>
        !value.includes("\0") &&
        utf8.encode(value).byteLength <= THREAD_FILES_MAX_EDITABLE_BYTES,
    ),
  ),
});

export const GetThreadFileTreeResponseSchema = successResponse(
  ThreadFileTreeDataSchema,
);
export const GetThreadFileResponseSchema =
  successResponse(ThreadFileDataSchema);
export const SaveThreadFileResponseSchema = successResponse(
  Schema.Struct({
    kind: Schema.Literal("saved"),
    contentVersion: ThreadFileVersion,
  }),
);

export const ThreadFilesInvalidRequestResponseSchema = errorResponse(
  "THREAD_FILES_INVALID_REQUEST",
  "The Files request is invalid.",
);
export const ThreadFilesEntryNotFoundResponseSchema = errorResponse(
  "THREAD_FILES_ENTRY_NOT_FOUND",
  "The requested workspace entry was not found.",
);
export const ThreadFilesConflictResponseSchema = errorResponse(
  "THREAD_FILES_CONFLICT",
  "The file changed before the operation completed.",
);
export const ThreadFilesUnavailableResponseSchema = errorResponse(
  "THREAD_FILES_UNAVAILABLE",
  "Files are temporarily unavailable.",
);

export type GetThreadFileTreeResponse =
  typeof GetThreadFileTreeResponseSchema.Encoded;
export type GetThreadFileResponse = typeof GetThreadFileResponseSchema.Encoded;
export type SaveThreadFileResponse =
  typeof SaveThreadFileResponseSchema.Encoded;
