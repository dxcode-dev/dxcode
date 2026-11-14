import { ARTIFACT_FOLDER_LIMIT, type ArtifactFolder } from "@dx/api";

/**
 * A person's own arrangement of their Artifacts library: pins and folders
 * one level deep. Nothing here changes an artifact or anyone else's
 * library. The caller has checked that the person may open the artifact.
 */

const newFolderId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `afd_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
};

export const isFolderId = (value: string) => /^afd_[0-9a-f]{32}$/.test(value);

/** The person's folders by name. */
export const listFolders = async (
  db: D1Database,
  userId: string,
): Promise<ReadonlyArray<ArtifactFolder>> =>
  (
    await db
      .prepare(
        `SELECT id, name FROM artifact_folder WHERE user_id = ?
          ORDER BY name COLLATE NOCASE, id`,
      )
      .bind(userId)
      .all<ArtifactFolder>()
  ).results;

export type FolderResult =
  | { readonly kind: "saved"; readonly folder: ArtifactFolder }
  | { readonly kind: "not-found" }
  | { readonly kind: "exists" }
  | { readonly kind: "limit" };

const isUniqueViolation = (cause: unknown) =>
  cause instanceof Error && /UNIQUE constraint failed/.test(cause.message);

export const createFolder = async (
  db: D1Database,
  userId: string,
  name: string,
  now = Date.now(),
): Promise<FolderResult> => {
  const id = newFolderId();
  try {
    const inserted = await db
      .prepare(
        `INSERT INTO artifact_folder (id, user_id, name, created_at)
         SELECT ?1, ?2, ?3, ?4
          WHERE (SELECT count(*) FROM artifact_folder WHERE user_id = ?2) < ?5`,
      )
      .bind(id, userId, name, now, ARTIFACT_FOLDER_LIMIT)
      .run();
    if (inserted.meta.changes !== 1) return { kind: "limit" };
  } catch (cause) {
    if (isUniqueViolation(cause)) return { kind: "exists" };
    throw cause;
  }
  return { kind: "saved", folder: { id, name } };
};

export const renameFolder = async (
  db: D1Database,
  userId: string,
  folderId: string,
  name: string,
): Promise<FolderResult> => {
  try {
    const renamed = await db
      .prepare(
        "UPDATE artifact_folder SET name = ?3 WHERE id = ?1 AND user_id = ?2",
      )
      .bind(folderId, userId, name)
      .run();
    if (renamed.meta.changes !== 1) return { kind: "not-found" };
  } catch (cause) {
    if (isUniqueViolation(cause)) return { kind: "exists" };
    throw cause;
  }
  return { kind: "saved", folder: { id: folderId, name } };
};

/** Deletes the folder; its artifacts go back to the top of the library. */
export const deleteFolder = async (
  db: D1Database,
  userId: string,
  folderId: string,
) => {
  const [, removed] = await db.batch([
    db
      .prepare(
        "DELETE FROM artifact_folder_item WHERE folder_id = ?1 AND user_id = ?2",
      )
      .bind(folderId, userId),
    db
      .prepare("DELETE FROM artifact_folder WHERE id = ?1 AND user_id = ?2")
      .bind(folderId, userId),
  ]);
  return removed?.meta.changes === 1;
};

/**
 * Files the artifact in one of the person's folders, or takes it out with
 * null. False when the folder is not theirs.
 */
export const moveToFolder = async (
  db: D1Database,
  userId: string,
  artifactId: string,
  folderId: string | null,
) => {
  if (folderId === null) {
    await db
      .prepare(
        "DELETE FROM artifact_folder_item WHERE user_id = ?1 AND artifact_id = ?2",
      )
      .bind(userId, artifactId)
      .run();
    return true;
  }
  const filed = await db
    .prepare(
      `INSERT INTO artifact_folder_item (user_id, artifact_id, folder_id)
       SELECT ?1, ?2, id FROM artifact_folder WHERE id = ?3 AND user_id = ?1
       ON CONFLICT (user_id, artifact_id) DO UPDATE SET folder_id = excluded.folder_id`,
    )
    .bind(userId, artifactId, folderId)
    .run();
  return filed.meta.changes === 1;
};

/** Pins or unpins the artifact for the person. */
export const setPinned = async (
  db: D1Database,
  userId: string,
  artifactId: string,
  pinned: boolean,
  now = Date.now(),
) => {
  await (pinned
    ? db
        .prepare(
          `INSERT INTO artifact_pin (user_id, artifact_id, pinned_at)
           VALUES (?1, ?2, ?3) ON CONFLICT (user_id, artifact_id) DO NOTHING`,
        )
        .bind(userId, artifactId, now)
    : db
        .prepare(
          "DELETE FROM artifact_pin WHERE user_id = ?1 AND artifact_id = ?2",
        )
        .bind(userId, artifactId)
  ).run();
};
