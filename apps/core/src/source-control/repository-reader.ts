/**
 * Read-only access to one repository's default branch on its host, without an
 * Orb. Core builds one per request from a source lease (a restricted GitHub
 * installation token or the viewer's Bitbucket connection) or anonymously for
 * a public repository; nothing here writes, and no credential leaves Core.
 */

export interface RepositoryCommit {
  readonly sha: string;
  readonly subject: string;
  readonly authorName: string;
  readonly committedAt: Date;
  readonly url: string;
}

export interface RepositoryEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "directory" | "file" | "symlink" | "submodule";
  readonly url: string;
}

export interface RepositoryDirectory {
  readonly entries: ReadonlyArray<RepositoryEntry>;
  readonly truncated: boolean;
}

export interface RepositoryHostIdentity {
  readonly fullName: string;
  readonly webUrl: string;
  readonly defaultBranch: string;
}

export interface RepositoryReader {
  readonly provider: "github" | "bitbucket" | "git";
  readonly repository: () => Promise<RepositoryHostIdentity>;
  /** The host's page listing every commit on the default branch. */
  readonly commitsUrl: (repository: RepositoryHostIdentity) => string;
  /** Newest first; empty when the repository has no commits. */
  readonly commits: (limit: number) => Promise<ReadonlyArray<RepositoryCommit>>;
  /** `undefined` when the default branch has no directory at `path`. */
  readonly directory: (
    path: string,
  ) => Promise<RepositoryDirectory | undefined>;
  /**
   * The newest commit at or before `head` that touched each path. A host that
   * cannot answer cheaply answers an empty map.
   */
  readonly lastCommits: (
    head: string,
    paths: ReadonlyArray<string>,
  ) => Promise<ReadonlyMap<string, RepositoryCommit>>;
}

/** The most entries one directory answer carries. */
export const MAX_DIRECTORY_ENTRIES = 1_000;

export const commitSubject = (message: string) =>
  (message.split("\n", 1)[0] ?? "").trim().slice(0, 500);

/** Directories first, then by name, as a file browser lists them. */
export const sortEntries = (entries: ReadonlyArray<RepositoryEntry>) =>
  [...entries].sort((left, right) =>
    (left.kind === "directory") === (right.kind === "directory")
      ? left.name.localeCompare(right.name)
      : left.kind === "directory"
        ? -1
        : 1,
  );

/** `segments` URL-encoded one by one and joined with `/`. */
export const encodePath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");
