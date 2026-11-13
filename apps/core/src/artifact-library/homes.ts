import type { ArtifactSharing, ThreadArtifactKind } from "@dx/api";
import { newThreadId, type ThreadId, type UserId } from "@dx/domain";
import { threadProjectReachableSql } from "../settings/members/membership-sql.js";
import type {
  ArtifactBindings,
  ArtifactWithMarkdown,
} from "../thread-artifacts/store.js";
import { createArtifact } from "../thread-artifacts/store.js";
import { CONTRIBUTE_WITHOUT_END } from "../thread-sharing/access.js";
import { ownerWorkspaceId } from "../thread-sharing/service.js";

/**
 * Artifact homes: the hidden Thread each standalone artifact lives in. A
 * home has `artifact_home = 1`, holds one artifact, and never runs an agent
 * or an Orb; it lists in no Thread list. Sharing a standalone artifact is
 * its home's workspace sharing, per artifact.
 */

const HOME_TITLE_LENGTH = 80;

/**
 * The Project a new home belongs to: the one the owner worked in last,
 * else any Project they reach. A home needs one because every Thread does;
 * readers never see it, and members' access does not depend on it.
 */
const homeProjectId = async (db: D1Database, ownerUserId: string) =>
  (
    await db
      .prepare(
        `SELECT project.id FROM projects AS project
          WHERE project.deleted_at IS NULL
            AND ${threadProjectReachableSql("project", "?1")}
          ORDER BY (SELECT MAX(thread.last_activity_at) FROM threads AS thread
                     WHERE thread.project_id = project.id
                       AND thread.owner_user_id = ?1
                       AND thread.artifact_home = 0) DESC,
                   project.created_at
          LIMIT 1`,
      )
      .bind(ownerUserId)
      .first<{ id: string }>()
  )?.id;

export type CreateStandaloneResult =
  | {
      readonly kind: "created";
      readonly artifactId: string;
      readonly homeId: ThreadId;
      readonly value: ArtifactWithMarkdown;
    }
  | { readonly kind: "no-project" }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * Creates a private standalone artifact for `ownerUserId`: its home, then
 * the artifact at revision 1. A home whose artifact could not be made is
 * removed again.
 */
export const createStandaloneArtifact = async (
  bindings: ArtifactBindings & { readonly DB: D1Database },
  input: {
    readonly ownerUserId: string;
    readonly title: string;
    readonly kind?: ThreadArtifactKind;
    readonly markdown?: string;
    readonly writer:
      | { readonly kind: "user"; readonly userId: string }
      | { readonly kind: "agent"; readonly submissionId?: string };
    readonly now?: Date;
  },
): Promise<CreateStandaloneResult> => {
  const db = bindings.DB;
  const projectId = await homeProjectId(db, input.ownerUserId);
  if (projectId === undefined) return { kind: "no-project" };
  const now = input.now ?? new Date();
  const threadId = newThreadId();
  const title =
    input.title.replace(/\s+/g, " ").trim().slice(0, HOME_TITLE_LENGTH) ||
    "Artifact";
  await db
    .prepare(
      `INSERT INTO threads
         (id, title, project_id, owner_user_id, visibility, workspace_access,
          lifecycle_state, kind, artifact_home, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'private', 'none', 'active', 'thread', 1, ?5, ?5)`,
    )
    .bind(threadId, title, projectId, input.ownerUserId, now.toISOString())
    .run();
  const result = await createArtifact(bindings, {
    threadId,
    title: input.title,
    kind: input.kind ?? "document",
    markdown: input.markdown ?? "",
    writer: input.writer,
    now: now.getTime(),
  });
  if (result.kind === "saved")
    return {
      kind: "created",
      artifactId: result.value.artifact.id,
      homeId: threadId,
      value: result.value,
    };
  await db
    .prepare("DELETE FROM threads WHERE id = ?1 AND artifact_home = 1")
    .bind(threadId)
    .run();
  return {
    kind: "invalid",
    message:
      result.kind === "invalid"
        ? result.message
        : "The artifact could not be created.",
  };
};

export type ShareResult =
  | { readonly kind: "shared" }
  | { readonly kind: "no-workspace" };

/**
 * Sets who besides its owner opens a standalone artifact: no one, every
 * member of the owner's workspace to read, or to edit. Edit never expires,
 * unlike a Thread's Contribute. The caller has checked that `homeId` is an
 * artifact home `ownerUserId` owns.
 */
export const shareStandaloneArtifact = async (
  db: D1Database,
  input: {
    readonly homeId: ThreadId;
    readonly ownerUserId: UserId;
    readonly sharing: ArtifactSharing;
    readonly now?: Date;
  },
): Promise<ShareResult> => {
  const workspaceId =
    input.sharing === "private"
      ? undefined
      : await ownerWorkspaceId(db, input.ownerUserId);
  if (input.sharing !== "private" && workspaceId === undefined)
    return { kind: "no-workspace" };
  const access =
    input.sharing === "private"
      ? "none"
      : input.sharing === "edit"
        ? "contribute"
        : "view";
  await db
    .prepare(
      `UPDATE threads
          SET workspace_access = ?2, shared_workspace_id = ?3,
              contribute_until = ?4,
              visibility = CASE WHEN ?2 = 'none' THEN 'private' ELSE 'workspace' END,
              updated_at = ?5
        WHERE id = ?1 AND owner_user_id = ?6 AND artifact_home = 1`,
    )
    .bind(
      input.homeId,
      access,
      workspaceId ?? null,
      access === "contribute" ? CONTRIBUTE_WITHOUT_END : null,
      (input.now ?? new Date()).toISOString(),
      input.ownerUserId,
    )
    .run();
  return { kind: "shared" };
};
