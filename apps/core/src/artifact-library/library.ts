import type {
  ArtifactAccess,
  ArtifactLibraryFilter,
  ArtifactLibraryItem,
  ArtifactSharing,
  ThreadArtifactKind,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  activeMemberSql,
  threadProjectReachableSql,
} from "../settings/members/membership-sql.js";
import {
  sharedThreadAccessSql,
  sharedThreadVisibleSql,
} from "../thread-sharing/access.js";

/**
 * The Artifacts library's reads: every live artifact a person may open. A
 * Thread's artifacts follow the rules that decide who may open the Thread:
 * a person opens those of Threads they own (in a Project they still reach)
 * and of Threads other members shared with a workspace they both belong to.
 * A standalone artifact belongs to its owner, who always opens it, and to
 * members of the owner's workspace while it is shared with it.
 */

interface LibraryRow {
  readonly id: string;
  readonly kind: ThreadArtifactKind;
  readonly title: string;
  readonly current_revision: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly thread_id: string | null;
  readonly thread_title: string | null;
  readonly thread_kind: "thread" | "space" | null;
  readonly lifecycle_state: "active" | "archived" | null;
  readonly owner_user_id: string;
  readonly owner_name: string | null;
  readonly sharing: ArtifactSharing;
  readonly updated_by_kind: "user" | "agent" | null;
  readonly updated_by_user_id: string | null;
  readonly updated_by_name: string | null;
  readonly created_by_kind: "user" | "agent";
  readonly created_by_user_id: string | null;
  readonly created_by_name: string | null;
  readonly pinned: number;
  readonly folder_id: string | null;
}

/**
 * SQL predicate on `thread` and `project`: `viewer` (a placeholder) may open
 * the Thread. `shared` (a placeholder, 1 or 0) is 0 for a principal that
 * acts for its own Threads only.
 */
const threadOpenableSql = (viewer: string, shared: string) => `(
  thread.lifecycle_state != 'deleted'
  AND project.deleted_at IS NULL
  AND ((thread.owner_user_id = ${viewer}
        AND ${threadProjectReachableSql("project", viewer)})
    OR (${shared} = 1
        AND ${sharedThreadVisibleSql("thread", "project", viewer)})))`;

/**
 * SQL: the ids of the live artifacts `viewer` may open, each once. Thread
 * artifacts, the viewer's standalone artifacts, and standalone artifacts
 * other members shared with a workspace both belong to, each read through
 * its own index.
 */
const openableIdsSql = (viewer: string, shared: string, only = "") => {
  const one = only === "" ? "" : `AND artifact.id = ${only}`;
  return `
  SELECT artifact.id
    FROM thread_artifact AS artifact
    JOIN threads AS thread ON thread.id = artifact.thread_id
    JOIN projects AS project ON project.id = thread.project_id
   WHERE artifact.deleted_at IS NULL ${one}
     AND ${threadOpenableSql(viewer, shared)}
  UNION ALL
  SELECT artifact.id FROM thread_artifact AS artifact
   WHERE artifact.thread_id IS NULL AND artifact.deleted_at IS NULL ${one}
     AND artifact.owner_user_id = ${viewer}
  UNION ALL
  SELECT artifact.id FROM thread_artifact AS artifact
   WHERE artifact.thread_id IS NULL AND artifact.deleted_at IS NULL ${one}
     AND artifact.workspace_access != 'none'
     AND ${shared} = 1
     AND artifact.owner_user_id != ${viewer}
     AND ${activeMemberSql("artifact.shared_workspace_id", viewer)}
     AND ${activeMemberSql("artifact.shared_workspace_id", "artifact.owner_user_id")}`;
};

/**
 * The columns of one item, for artifacts already known to be openable, as
 * `viewer` (a placeholder) sees it: their pin and their folder.
 */
const SELECT = (now: string, viewer: string) => `
  SELECT artifact.id, artifact.kind, artifact.title, artifact.current_revision,
         artifact.created_at, artifact.updated_at, artifact.thread_id,
         thread.title AS thread_title, thread.kind AS thread_kind,
         thread.lifecycle_state,
         COALESCE(artifact.owner_user_id, thread.owner_user_id) AS owner_user_id,
         owner.name AS owner_name,
         CASE WHEN artifact.thread_id IS NULL THEN
                CASE artifact.workspace_access WHEN 'none' THEN 'private'
                     ELSE artifact.workspace_access END
              WHEN thread.workspace_access = 'none' THEN 'private'
              WHEN ${sharedThreadAccessSql("thread", now)} = 'contribute' THEN 'edit'
              ELSE 'view' END AS sharing,
         current.author_kind AS updated_by_kind,
         current.author_user_id AS updated_by_user_id,
         saver.name AS updated_by_name,
         artifact.created_by_kind, artifact.created_by_user_id,
         creator.name AS created_by_name,
         pin.pinned_at IS NOT NULL AS pinned,
         filed.folder_id
    FROM thread_artifact AS artifact
    LEFT JOIN threads AS thread ON thread.id = artifact.thread_id
    LEFT JOIN "user" AS owner
      ON owner.id = COALESCE(artifact.owner_user_id, thread.owner_user_id)
    LEFT JOIN thread_artifact_revision AS current
      ON current.artifact_id = artifact.id
     AND current.revision = artifact.current_revision
    LEFT JOIN "user" AS saver ON saver.id = current.author_user_id
    LEFT JOIN "user" AS creator ON creator.id = artifact.created_by_user_id
    LEFT JOIN artifact_pin AS pin
      ON pin.user_id = ${viewer} AND pin.artifact_id = artifact.id
    LEFT JOIN artifact_folder_item AS filed
      ON filed.user_id = ${viewer} AND filed.artifact_id = artifact.id`;

/**
 * SQL predicate: a person had a hand in the artifact, so the default view
 * lists it even when the agent made it: someone saved a revision or
 * commented, or the viewer pinned or filed it.
 */
const touchedByPeopleSql = `(
  artifact.created_by_kind = 'user'
  OR pin.pinned_at IS NOT NULL
  OR filed.folder_id IS NOT NULL
  OR EXISTS (SELECT 1 FROM thread_artifact_revision AS edit
              WHERE edit.artifact_id = artifact.id AND edit.author_kind = 'user')
  OR EXISTS (SELECT 1 FROM thread_artifact_comment AS note
              WHERE note.artifact_id = artifact.id AND note.author_kind = 'user'))`;

const accessOf = (row: LibraryRow, viewer: string): ArtifactAccess =>
  row.owner_user_id === viewer
    ? "owner"
    : row.sharing === "edit"
      ? "edit"
      : "view";

const itemOf = (row: LibraryRow, viewer: string): ArtifactLibraryItem => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  threadId: row.thread_id as ThreadId | null,
  source:
    row.thread_id === null
      ? { kind: "standalone" }
      : {
          kind: row.thread_kind === "space" ? "space" : "thread",
          title: row.thread_title ?? "",
          archived: row.lifecycle_state === "archived",
        },
  owner: { userId: row.owner_user_id as UserId, name: row.owner_name },
  access: accessOf(row, viewer),
  sharing: row.sharing,
  revision: row.current_revision,
  createdBy:
    row.created_by_kind === "user"
      ? {
          kind: "user",
          userId: row.created_by_user_id,
          name: row.created_by_name,
        }
      : { kind: "agent" },
  pinned: row.pinned === 1,
  folderId: row.folder_id,
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
 * The artifacts `reader` may open in `filter`, those whose title holds
 * `query` when it is given: the reader's pins first, then what the reader
 * made, then the rest, each most recently saved first. Agent notes stay out: they belong
 * to their Thread, where people choose to show them.
 */
export const listLibrary = async (
  db: D1Database,
  reader: LibraryReader,
  options: {
    readonly query?: string;
    /** `everything` lists all it may open, as the agent's tool does. */
    readonly filter?: ArtifactLibraryFilter | "everything";
    readonly limit: number;
    readonly now?: Date;
  },
): Promise<ReadonlyArray<ArtifactLibraryItem>> => {
  const query = options.query?.trim() ?? "";
  const filter = options.filter ?? "all";
  const { results } = await db
    .prepare(
      `${SELECT("?4", "?1")}
        WHERE artifact.id IN (${openableIdsSql("?1", "?2")})
          AND artifact.audience = 'people'
          AND (?3 = '' OR artifact.title LIKE ?5 ESCAPE '\\')
          AND (?6 != 'all' OR ?3 != '' OR ${touchedByPeopleSql})
          AND (?6 != 'pinned' OR pin.pinned_at IS NOT NULL)
          AND (?6 != 'mine' OR artifact.created_by_user_id = ?1)
          AND (?6 != 'agent' OR artifact.created_by_kind = 'agent')
          AND (?6 != 'shared' OR COALESCE(artifact.owner_user_id, thread.owner_user_id) != ?1)
        ORDER BY pin.pinned_at IS NOT NULL DESC,
                 COALESCE(artifact.created_by_user_id = ?1, 0) DESC,
                 artifact.updated_at DESC, artifact.id
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
      `${SELECT("?3", "?1")}
        WHERE artifact.id = ?4
          AND artifact.id IN (${openableIdsSql("?1", "?2", "?4")})`,
    )
    .bind(reader.userId, reader.shared ? 1 : 0, now.toISOString(), artifactId)
    .first<LibraryRow>();
  return row === null ? undefined : itemOf(row, reader.userId);
};
