import { ProjectId, Timestamp } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/** `value` with every percent escape decoded, however deeply nested. */
const fullyDecoded = (value: string) => {
  let current = value;
  for (let depth = 0; depth < 8; depth += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return undefined;
    }
    if (next === current) return current;
    current = next;
  }
  return undefined;
};

const isRepositoryDirectory = (path: string) => {
  if (path === "") return true;
  // A backslash, a control character, or an escape that decodes to a
  // separator or a dot segment could climb out once some layer decodes it.
  const decoded = fullyDecoded(path);
  return (
    decoded !== undefined &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control characters.
    !/[\\\u0000-\u001f\u007f]/.test(decoded) &&
    decoded.split("/").length === path.split("/").length &&
    decoded
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
};

/**
 * A repository directory as a link or a request may spell it: surrounding
 * whitespace and trailing slashes dropped, so `src/` is `src`. A leading
 * slash stays, and the path schema refuses it.
 */
export const normalizeProjectRepositoryPath = (path: string) =>
  path.trim().replace(/(?<=[^/])\/+$/, "");

/**
 * A directory in the repository, relative to its root: `""` is the root, and
 * a nested directory is `src/app`, with no leading or trailing slash, no `.`
 * or `..` segment, no backslash or control character, and no percent escape
 * that decodes to any of those.
 */
export const ProjectRepositoryPath = Schema.String.check(
  Schema.isMaxLength(1024),
  Schema.makeFilter(isRepositoryDirectory),
);
export type ProjectRepositoryPath = typeof ProjectRepositoryPath.Type;

export const ProjectRepositoryBrowseParamsSchema = Schema.Struct({
  projectId: ProjectId,
});

export const ProjectRepositoryBrowseQuerySchema = Schema.Struct({
  path: Schema.optional(ProjectRepositoryPath),
});

/** One commit on the default branch, linked on its host. */
export const ProjectRepositoryCommitSchema = Schema.Struct({
  sha: Schema.String,
  /** The first line of the message. */
  subject: Schema.String,
  authorName: Schema.String,
  committedAt: Timestamp,
  url: Schema.String,
});
export type ProjectRepositoryCommit = typeof ProjectRepositoryCommitSchema.Type;

/**
 * One entry of a directory. `url` opens a file or submodule on its host; a
 * directory opens in dx. `lastCommit` is the newest commit that touched the
 * entry, when the host reports it.
 */
export const ProjectRepositoryEntrySchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  kind: Schema.Literals(["directory", "file", "symlink", "submodule"]),
  url: Schema.String,
  lastCommit: Schema.optional(
    Schema.Struct({
      sha: Schema.String,
      subject: Schema.String,
      committedAt: Timestamp,
      url: Schema.String,
    }),
  ),
});
export type ProjectRepositoryEntry = typeof ProjectRepositoryEntrySchema.Type;

export const ProjectRepositoryHostSchema = Schema.Struct({
  provider: Schema.Literals([
    "git",
    "github",
    "bitbucket",
    "gitlab",
    "forgejo",
  ]),
  fullName: Schema.String,
  webUrl: Schema.String,
});

/**
 * Why a bound repository cannot be browsed now. `reconnect`: the viewer has no
 * live connection that reaches it. `access-removed`: the connection no longer
 * reaches it. `rate-limited` and `provider-unavailable` pass. `unsupported`:
 * dx does not read this host without an Orb.
 */
export const ProjectRepositoryUnavailableReason = Schema.Literals([
  "reconnect",
  "access-removed",
  "rate-limited",
  "provider-unavailable",
  "unsupported",
]);
export type ProjectRepositoryUnavailableReason =
  typeof ProjectRepositoryUnavailableReason.Type;

/**
 * The Project's primary repository at its default branch: its newest commits
 * and one directory, read without an Orb through the viewer's source
 * connection, or anonymously for a public GitHub repository. A Project
 * without a repository is `none`; a repository without commits is `empty`; a
 * `path` the default branch lacks as a directory is `path-not-found`.
 */
export const ProjectRepositoryBrowseDataSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("none") }),
  Schema.Struct({
    state: Schema.Literal("empty"),
    repository: ProjectRepositoryHostSchema,
  }),
  Schema.Struct({
    state: Schema.Literal("unavailable"),
    repository: ProjectRepositoryHostSchema,
    reason: ProjectRepositoryUnavailableReason,
  }),
  Schema.Struct({
    state: Schema.Literal("path-not-found"),
    repository: ProjectRepositoryHostSchema,
    defaultBranch: Schema.String,
    path: ProjectRepositoryPath,
  }),
  Schema.Struct({
    state: Schema.Literal("ready"),
    repository: ProjectRepositoryHostSchema,
    defaultBranch: Schema.String,
    /** The host's page listing every commit on the default branch. */
    commitsUrl: Schema.String,
    /** Newest first, at most five. */
    commits: Schema.Array(ProjectRepositoryCommitSchema),
    path: ProjectRepositoryPath,
    /** Directories first, then by name. */
    entries: Schema.Array(ProjectRepositoryEntrySchema),
    /** The directory has more entries than the answer carries. */
    truncated: Schema.Boolean,
  }),
]);
export type ProjectRepositoryBrowseData =
  typeof ProjectRepositoryBrowseDataSchema.Type;

export const GetProjectRepositoryBrowseResponseSchema = successResponse(
  ProjectRepositoryBrowseDataSchema,
);
export type GetProjectRepositoryBrowseResponse =
  typeof GetProjectRepositoryBrowseResponseSchema.Encoded;

export const ProjectRepositoryBrowseInvalidRequestResponseSchema =
  errorResponse("INVALID_REQUEST", "Request validation failed.");

export const ProjectRepositoryBrowseNotFoundResponseSchema = errorResponse(
  "PROJECT_NOT_FOUND",
  "Project not found.",
);

export const ProjectRepositoryBrowsePersistenceUnavailableResponseSchema =
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  );
