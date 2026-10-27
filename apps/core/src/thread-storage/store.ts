import { type ThreadStorageFile, threadStoragePath } from "@dx/api";
import type { AttachmentTransfer } from "../attachments/transfer.js";
import type { Bindings } from "../http/types.js";

/**
 * One file in a Thread's storage: its D1 row and R2 object. The row is the
 * index other features read (the transcript, other Threads); the object holds
 * the bytes, under the Thread's own prefix.
 */
export interface ThreadStorageRow {
  readonly id: string;
  readonly thread_id: string;
  readonly object_key: string;
  readonly upload_id: string | null;
  readonly name: string;
  readonly mime_type: string;
  readonly size: number;
  readonly state: "uploading" | "ready";
  readonly created_at: number;
}

export const newThreadStorageFileId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `tsf_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
};

export const isThreadStorageFileId = (
  value: string | undefined | null,
): value is string =>
  typeof value === "string" && /^tsf_[0-9a-f]{32}$/.test(value);

export const threadStorageObjectKey = (threadId: string, id: string) =>
  `thread-storage/${threadId}/${id}`;

export const threadStorageFileData = (
  row: ThreadStorageRow,
  origin: string,
): ThreadStorageFile => ({
  id: row.id,
  threadId: row.thread_id,
  name: row.name,
  mimeType: row.mime_type,
  size: row.size,
  url: `${origin}${threadStoragePath(row.thread_id, row.id, row.name)}`,
  createdAt: row.created_at,
});

export const findThreadStorageFile = (db: D1Database, id: string) =>
  db
    .prepare("SELECT * FROM thread_storage_files WHERE id = ?")
    .bind(id)
    .first<ThreadStorageRow>();

/** Uploads a Thread started and did not finish within this are deleted. */
export const UNFINISHED_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Delete a Thread's uploads that never finished: dxd stopped, the Orb went
 * away mid-transfer, or a part failed. Runs whenever the Thread starts
 * another upload, so nothing depends on a scheduled job.
 */
export const purgeUnfinishedUploads = async (
  db: D1Database,
  transfer: AttachmentTransfer,
  threadId: string,
  now: number,
) => {
  const { results } = await db
    .prepare(
      `SELECT * FROM thread_storage_files
        WHERE thread_id = ? AND state = 'uploading' AND created_at < ?
        LIMIT 20`,
    )
    .bind(threadId, now - UNFINISHED_UPLOAD_RETENTION_MS)
    .all<ThreadStorageRow>();
  for (const row of results) {
    await db
      .prepare(
        "DELETE FROM thread_storage_files WHERE id = ? AND state = 'uploading'",
      )
      .bind(row.id)
      .run();
    if (row.upload_id !== null)
      await transfer
        .abort(row.object_key, row.upload_id)
        .catch(() => undefined);
  }
  return results.length;
};

const DELETE_PAGE = 1_000;

/**
 * Remove everything a deleted Thread stored: the bytes under its prefix
 * first, so a retry after a failure still finds the rows, then the rows.
 * Unfinished multipart uploads hold no object; R2 expires them.
 */
export const deleteThreadStorage = async (
  bindings: Pick<Bindings, "DB" | "DX_STORAGE">,
  threadId: string,
) => {
  const bucket = bindings.DX_STORAGE;
  if (bucket !== undefined)
    for (;;) {
      const page = await bucket.list({
        prefix: `thread-storage/${threadId}/`,
        limit: DELETE_PAGE,
      });
      if (page.objects.length > 0)
        await bucket.delete(page.objects.map(({ key }) => key));
      if (!page.truncated) break;
    }
  await bindings.DB?.prepare(
    "DELETE FROM thread_storage_files WHERE thread_id = ?",
  )
    .bind(threadId)
    .run();
};
