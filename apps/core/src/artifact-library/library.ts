import type {
  ArtifactAccess,
  ArtifactLibraryFilter,
  ArtifactLibraryItem,
  ArtifactSharing,
  ThreadArtifactKind,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { threadProjectReachableSql } from "../settings/members/membership-sql.js";
import {
  sharedThreadAccessSql,
  sharedThreadVisibleSql,
} from "../thread-sharing/access.js";

/**
 * The Artifacts library's reads: every live artifact a person may open,
 * decided by the same rules that decide who may open a Thread. A person
 * opens the artifacts of Threads they own (in a Project they still reach)
 * and of Threads other members shared with a workspace they both belong
 * to. A standalone artifact's home is such a Thread, so a private one is
 * the owner's alone.
 */

interface LibraryRow {
  readonly id: string;
  readonly kind: ThreadArtifactKind;
  readonly title: string;
  readonly current_revision: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly thread_id: string;
  readonly thread_title: string;
  readonly thread_kind: "thread" | "space";
  readonly artifact_home: number;
  readonly lifecycle_state: "active" | "archived";
  readonly owner_user_id: string;
  readonly owner_name: string | null;
  readonly workspace_access: "none" | "view" | "contribute";
  readonly shared_access: "view" | "contribute";
  readonly updated_by_kind: "user" | "agent" | null;
  readonly updated_by_user_id: string | null;
  readonly updated_by_name: string | null;
}

/**
 * SQL predicate on `thread` and `project`: `viewer` (a placeholder) may open
 * the Thread. `shared` (a placeholder, 1 or 0) is 0 for a principal that
 * acts for its own Threads only.
 */
const openableSql = (viewer: string, shared: string) => `(
  thread.lifecycle_state != 'deleted'
  AND project.deleted_at IS NULL
  AND ((thread.owner_user_id = ${viewer}
        AND ${threadProjectReachableSql("project", viewer)})
    OR (${shared} = 1
        AND ${sharedThreadVisibleSql("thread", "project", viewer)})))`;

const SELECT = (now: string) => `
  SELECT artifact.id, artifact.kind, artifact.title, artifact.current_revision,
         artifact.created_at, artifact.updated_at,
         thread.id AS thread_id, thread.title AS thread_title,
         thread.kind AS thread_kind, thread.artifact_home,
         thread.lifecycle_state, thread.owner_user_id,
         owner.name AS owner_name, thread.workspace_access,
         ${sharedThreadAccessSql("thread", now)} AS shared_access,
         current.author_kind AS updated_by_kind,
         current.author_user_id AS updated_by_user_id,
         saver.name AS updated_by_name
    FROM thread_artifact AS artifact
    JOIN threads AS thread ON thread.id = artifact.thread_id
    JOIN projects AS project ON project.id = thread.project_id
    LEFT JOIN "user" AS owner ON owner.id = thread.owner_user_id
    LEFT JOIN thread_artifact_revision AS current
      ON current.artifact_id = artifact.id
     AND current.revision = artifact.current_revision
    LEFT JOIN "user" AS saver ON saver.id = current.author_user_id
   WHERE artifact.deleted_at IS NULL`;

const sharingOf = (row: LibraryRow): ArtifactSharing =>
  row.workspace_access === "none"
    ? "private"
    : row.shared_access === "contribute"
      ? "edit"
      : "view";

const accessOf = (row: LibraryRow, viewer: string): ArtifactAccess =>
  row.owner_user_id === viewer
    ? "owner"
    : row.shared_access === "contribute"
      ? "edit"
      : "view";

const itemOf = (row: LibraryRow, viewer: string): ArtifactLibraryItem => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  threadId: row.thread_id as ThreadId,
  source:
    row.artifact_home === 1
      ? { kind: "standalone" }
      : {
          kind: row.thread_kind === "space" ? "space" : "thread",
          title: row.thread_title,
          archived: row.lifecycle_state === "archived",
        },
  owner: { userId: row.owner_user_id as UserId, name: row.owner_name },
  access: accessOf(row, viewer),
  sharing: sharingOf(row),
  revision: row.current_revision,
  updatedBy:
    row.updated_by_kind === "user"
      ? {
          kind: "user",
          userId: row.updated_by_user_id,
          name: row.updated_by_name,
        }
      : { kind: "agent" },
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** `%`, `_`, and `\` match themselves in a LIKE pattern. */
const likePattern = (query: string) =>
  `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

export interface LibraryReader {
  readonly userId: string;
  /** False for a principal that acts for its own Threads only. */
  readonly shared: boolean;
}

/**
 * The artifacts `reader` may open, most recently saved first, those whose
 * title holds `query` when it is given.
 */
export const listLibrary = async (
  db: D1Database,
  reader: LibraryReader,
  options: {
    readonly query?: string;
    readonly filter?: ArtifactLibraryFilter;
    readonly limit: number;
    readonly now?: Date;
  },
): Promise<ReadonlyArray<ArtifactLibraryItem>> => {
  const query = options.query?.trim() ?? "";
  const filter = options.filter ?? "all";
  const { results } = await db
    .prepare(
      `${SELECT("?4")}
         AND ${openableSql("?1", "?2")}
         AND (?3 = '' OR artifact.title LIKE ?5 ESCAPE '\\')
         AND (?6 != 'mine' OR (thread.artifact_home = 1 AND thread.owner_user_id = ?1))
         AND (?6 != 'shared' OR thread.owner_user_id != ?1)
         AND (?6 != 'threads' OR thread.artifact_home = 0)
       ORDER BY artifact.updated_at DESC, artifact.id
       LIMIT ?7`,
    )
    .bind(
      reader.userId,
      reader.shared ? 1 : 0,
      query,
      (options.now ?? new Date()).toISOString(),
      likePattern(query),
      filter,
      options.limit,
    )
    .all<LibraryRow>();
  return results.map((row) => itemOf(row, reader.userId));
};

/**
 * One artifact `reader` may open, wherever it lives; undefined when it does
 * not exist or `reader` may not open it, which look the same.
 */
export const findLibraryItem = async (
  db: D1Database,
  reader: LibraryReader,
  artifactId: string,
  now = new Date(),
): Promise<ArtifactLibraryItem | undefined> => {
  if (!/^art_[0-9a-f]{32}$/.test(artifactId)) return undefined;
  const row = await db
    .prepare(
      `${SELECT("?3")}
         AND artifact.id = ?4
         AND ${openableSql("?1", "?2")}`,
    )
    .bind(reader.userId, reader.shared ? 1 : 0, now.toISOString(), artifactId)
    .first<LibraryRow>();
  return row === null ? undefined : itemOf(row, reader.userId);
};
