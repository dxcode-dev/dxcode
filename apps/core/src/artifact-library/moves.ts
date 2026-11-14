import { threadStoragePath } from "@dx/api";
import { moveQuote } from "../thread-artifacts/anchors.js";
import { standaloneImagePath } from "../thread-artifacts/standalone-images.js";
import {
  type ArtifactBindings,
  artifactRevisionKey,
  artifactThreadPrefix,
  deletePrefix,
  standaloneArtifactImageKey,
} from "../thread-artifacts/store.js";

/**
 * Finishes moving the artifacts of the old artifact homes (0198): each was
 * a hidden Thread holding one standalone artifact. The migration made the
 * artifact standalone and deleted its home; its revision bodies and images
 * are still in R2 under that home, listed in `standalone_artifact_move`.
 * This copies each one to the artifact's own prefix, pointing image links
 * at the artifact's image route, then deletes the old objects and the row.
 * Idempotent: a run that fails part way leaves the row for the next one.
 */

interface MoveRow {
  readonly artifact_id: string;
  readonly from_thread_id: string;
  readonly deleted_at: number | null;
}

interface StoredFile {
  readonly id: string;
  readonly object_key: string;
  readonly name: string;
}

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

/** Points a body's links to its home's stored images at the artifact's. */
const relink = (
  text: string,
  homeId: string,
  artifactId: string,
  files: ReadonlyArray<StoredFile>,
) =>
  files.reduce(
    (body, file) =>
      body
        .split(threadStoragePath(homeId, file.id, file.name))
        .join(standaloneImagePath(artifactId, file.id, file.name)),
    text,
  );

const moveOne = async (db: D1Database, bucket: R2Bucket, move: MoveRow) => {
  const artifactId = move.artifact_id;
  const homeId = move.from_thread_id;
  const { results: files } = await db
    .prepare(
      `SELECT id, object_key, name FROM thread_storage_files
        WHERE thread_id = ? AND state = 'ready'`,
    )
    .bind(homeId)
    .all<StoredFile>();
  if (move.deleted_at === null) {
    // Images first, so no moved body links to a missing one.
    for (const file of files) {
      const object = await bucket.get(file.object_key);
      if (object === null) continue;
      await bucket.put(
        standaloneArtifactImageKey(artifactId, file.id, file.name),
        await object.arrayBuffer(),
        { httpMetadata: object.httpMetadata ?? {} },
      );
    }
    const { results: revisions } = await db
      .prepare(
        `SELECT revision, sha256 FROM thread_artifact_revision
          WHERE artifact_id = ? ORDER BY revision`,
      )
      .bind(artifactId)
      .all<{ revision: number; sha256: string }>();
    const current = await db
      .prepare("SELECT current_revision FROM thread_artifact WHERE id = ?")
      .bind(artifactId)
      .first<number>("current_revision");
    const statements: D1PreparedStatement[] = [];
    let before: string | undefined;
    let after: string | undefined;
    for (const { revision, sha256 } of revisions) {
      const object = await bucket.get(
        artifactRevisionKey(homeId, artifactId, revision, sha256),
      );
      // Moved by an earlier run that stopped before deleting the row.
      if (object === null) continue;
      const text = await object.text();
      const moved = relink(text, homeId, artifactId, files);
      const bytes = new TextEncoder().encode(moved);
      const hash = moved === text ? sha256 : await sha256Hex(bytes);
      await bucket.put(
        artifactRevisionKey(null, artifactId, revision, hash),
        bytes,
        { httpMetadata: object.httpMetadata ?? {}, sha256: hash },
      );
      if (hash !== sha256)
        statements.push(
          db
            .prepare(
              `UPDATE thread_artifact_revision SET sha256 = ?3, size_bytes = ?4
                WHERE artifact_id = ?1 AND revision = ?2`,
            )
            .bind(artifactId, revision, hash, bytes.byteLength),
        );
      if (revision === current) {
        before = text;
        after = moved;
      }
    }
    if (before !== undefined && after !== undefined && before !== after) {
      // Longer links move the text after them: open comments follow it.
      const { results: comments } = await db
        .prepare(
          `SELECT id, quote, anchor_start FROM thread_artifact_comment
            WHERE artifact_id = ?1 AND parent_id IS NULL
              AND anchor_revision = ?2`,
        )
        .bind(artifactId, current)
        .all<{ id: string; quote: string; anchor_start: number | null }>();
      for (const comment of comments) {
        const found = moveQuote(
          before,
          after,
          comment.quote,
          comment.anchor_start,
        );
        statements.push(
          db
            .prepare(
              `UPDATE thread_artifact_comment
                  SET anchor_start = ?2, anchor_end = ?3
                WHERE id = ?1`,
            )
            .bind(comment.id, found?.start ?? null, found?.end ?? null),
        );
      }
    }
    statements.push(
      db
        .prepare(
          `UPDATE thread_artifact
              SET size_bytes = COALESCE((
                    SELECT size_bytes FROM thread_artifact_revision
                     WHERE artifact_id = ?1 AND revision = current_revision
                  ), size_bytes),
                  stored_bytes = (
                    SELECT COALESCE(SUM(size_bytes), 0)
                      FROM thread_artifact_revision WHERE artifact_id = ?1
                  )
            WHERE id = ?1`,
        )
        .bind(artifactId),
    );
    await db.batch(statements);
  }
  // Everything the home stored goes: its artifact's old bodies and images.
  await deletePrefix(bucket, artifactThreadPrefix(homeId));
  for (const file of files) await bucket.delete(file.object_key);
  await db.batch([
    db
      .prepare("DELETE FROM thread_storage_files WHERE thread_id = ?")
      .bind(homeId),
    db
      .prepare("DELETE FROM standalone_artifact_move WHERE artifact_id = ?")
      .bind(artifactId),
  ]);
};

/** The minute sweep's part: moves up to `limit` artifacts. */
export const moveHomeArtifacts = async (
  bindings: ArtifactBindings,
  limit = 10,
) => {
  const db = bindings.DB;
  const bucket = bindings.DX_STORAGE;
  if (db === undefined || bucket === undefined) return 0;
  const { results } = await db
    .prepare(
      `SELECT move.artifact_id, move.from_thread_id, artifact.deleted_at
         FROM standalone_artifact_move AS move
         JOIN thread_artifact AS artifact ON artifact.id = move.artifact_id
        LIMIT ?`,
    )
    .bind(limit)
    .all<MoveRow>();
  for (const move of results) await moveOne(db, bucket, move);
  return results.length;
};
