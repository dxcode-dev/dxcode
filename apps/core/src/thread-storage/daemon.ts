import {
  CompleteThreadStorageFileRequestSchema,
  CreateThreadStorageFileRequestSchema,
  type CreateThreadStorageFileResponse,
  sanitizeAttachmentFilename,
  type ThreadStorageError,
  type ThreadStorageFile,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Effect, Schema } from "effect";
import { userPrincipal } from "../attachments/access.js";
import {
  attachmentOrigin,
  attachmentPartCount,
  attachmentPartLength,
  attachmentResponseType,
  readAttachmentHead,
  resolveAttachmentType,
} from "../attachments/store.js";
import { attachmentTransfer, bareEtag } from "../attachments/transfer.js";
import { authorizeThreadRequest } from "../auth/authorize-thread.js";
import type { Bindings } from "../http/types.js";
import { threadStorageLogger } from "../logging.js";
import {
  findThreadStorageFile,
  isThreadStorageFileId,
  newThreadStorageFileId,
  purgeUnfinishedUploads,
  threadStorageFileData,
  threadStorageObjectKey,
} from "./store.js";

/**
 * What a Thread's dxd asks of its storage, once the Thread execution object
 * has proved the daemon key is this Thread's: `dxd files put` creates and
 * completes uploads into this Thread's storage only, and `dxd files get`
 * describes any stored file the Thread's owner could open, in any Thread.
 * Bytes never pass through Core: dxd PUTs parts to presigned R2 URLs and
 * downloads from a presigned GET.
 */
export interface DaemonStorageRequest {
  /** The Thread whose daemon key the request carried. */
  readonly threadId: ThreadId;
  readonly method: string;
  /** After `/v1/dxd/:threadId/storage`: ``, `/<id>`, or `/<id>/complete`. */
  readonly path: string;
  readonly body: string | undefined;
}

const reply = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const refuse = (error: string, status: 400 | 404 | 503) =>
  reply({ error } satisfies ThreadStorageError, status);

const decode = <A>(
  schema: Schema.Codec<A, unknown>,
  body: string | undefined,
) => {
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(body ?? ""));
  } catch {
    return undefined;
  }
};

const ROUTE = /^(?:\/(tsf_[0-9a-f]{32})(\/complete)?)?$/;

export const serveDaemonStorage = async (
  env: Bindings,
  request: DaemonStorageRequest,
): Promise<Response> => {
  const route = ROUTE.exec(request.path);
  const transfer = attachmentTransfer(env);
  const db = env.DB;
  const bucket = env.DX_STORAGE;
  if (route === null) return refuse("Not found.", 404);
  if (transfer === undefined || db === undefined || bucket === undefined)
    return refuse("Thread storage is unavailable.", 503);
  const [, id, complete] = route;
  const origin = attachmentOrigin(env, "https://thread.internal/");
  const threadId = request.threadId;
  try {
    if (request.method === "POST" && id === undefined) {
      const input = decode(CreateThreadStorageFileRequestSchema, request.body);
      if (input === undefined)
        return refuse("The storage request is invalid.", 400);
      await purgeUnfinishedUploads(db, transfer, threadId, Date.now());
      const fileId = newThreadStorageFileId();
      const key = threadStorageObjectKey(threadId, fileId);
      const uploadId = await transfer.create(key);
      await db
        .prepare(
          `INSERT INTO thread_storage_files
             (id, thread_id, object_key, upload_id, name, mime_type, size,
              state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', ?)`,
        )
        .bind(
          fileId,
          threadId,
          key,
          uploadId,
          sanitizeAttachmentFilename(input.name),
          input.mimeType.trim().slice(0, 255) || "application/octet-stream",
          input.size,
          Date.now(),
        )
        .run();
      const partCount = attachmentPartCount(input.size);
      const urls = await transfer.partUrls(
        fileId,
        key,
        uploadId,
        Array.from(
          { length: partCount },
          (_, index) => attachmentPartLength(input.size, index + 1) ?? 0,
        ),
      );
      return reply(
        {
          id: fileId,
          partSize: attachmentPartLength(input.size, 1) ?? input.size,
          partCount,
          parts: urls.map((url, index) => ({ partNumber: index + 1, url })),
        } satisfies CreateThreadStorageFileResponse,
        201,
      );
    }

    if (
      request.method === "POST" &&
      id !== undefined &&
      complete !== undefined
    ) {
      const row = await findThreadStorageFile(db, id);
      // Only this Thread finishes its own uploads.
      if (
        row === null ||
        row.thread_id !== threadId ||
        row.state !== "uploading" ||
        row.upload_id === null
      )
        return refuse("Not found.", 404);
      const input = decode(
        CompleteThreadStorageFileRequestSchema,
        request.body,
      );
      const numbers = input?.parts.map(({ partNumber }) => partNumber) ?? [];
      if (
        input === undefined ||
        numbers.length !== attachmentPartCount(row.size) ||
        numbers.some((value, index) => value !== index + 1)
      )
        return refuse("The uploaded parts are incomplete.", 400);
      await transfer.complete(
        row.object_key,
        row.upload_id,
        input.parts.map(({ partNumber, etag }) => ({
          partNumber,
          etag: bareEtag(etag),
        })),
      );
      const object = await bucket.head(row.object_key);
      if (object?.size !== row.size) {
        await bucket.delete(row.object_key);
        await db
          .prepare("DELETE FROM thread_storage_files WHERE id = ?")
          .bind(row.id)
          .run();
        return refuse("The uploaded file has the wrong size.", 400);
      }
      // A previewable type must be proved by the bytes, so a renamed file
      // never renders as an image or plays as a video.
      const mimeType = resolveAttachmentType(
        row.mime_type,
        await readAttachmentHead(bucket, row.object_key, row.size),
      );
      await db
        .prepare(
          `UPDATE thread_storage_files
              SET state = 'ready', upload_id = NULL, mime_type = ?
            WHERE id = ? AND state = 'uploading'`,
        )
        .bind(mimeType, row.id)
        .run();
      threadStorageLogger.info("Thread storage file stored.", {
        event: "thread_storage_file_stored",
        threadId,
        fileId: row.id,
        size: row.size,
        mimeType,
      });
      return reply(
        threadStorageFileData(
          { ...row, mime_type: mimeType, state: "ready", upload_id: null },
          origin,
        ) satisfies ThreadStorageFile,
      );
    }

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      id !== undefined &&
      complete === undefined
    ) {
      const row = await findThreadStorageFile(db, id);
      if (!isThreadStorageFileId(id) || row === null || row.state !== "ready")
        return refuse("Not found.", 404);
      // The key reads as the Thread's owner: any Thread's file they could
      // open in dx, which is how one Thread hands a file to another.
      const owner = await db
        .prepare("SELECT owner_user_id FROM threads WHERE id = ?")
        .bind(threadId)
        .first<{ readonly owner_user_id: string }>();
      const access =
        owner === null
          ? { authorized: false }
          : await Effect.runPromise(
              authorizeThreadRequest(
                row.thread_id,
                userPrincipal(owner.owner_user_id),
                db,
              ),
            );
      if (!access.authorized) return refuse("Not found.", 404);
      const url = await transfer.readUrl(
        row.object_key,
        attachmentResponseType(
          { mime_type: row.mime_type, filename: row.name },
          true,
        ),
      );
      return reply({ url, name: row.name, size: row.size });
    }
    return refuse("Not found.", 404);
  } catch (cause) {
    threadStorageLogger.error("Thread storage request failed.", {
      event: "thread_storage_daemon_request_failed",
      threadId,
      errorName: cause instanceof Error ? cause.name : "UnknownError",
      errorMessage:
        cause instanceof Error ? cause.message.slice(0, 500) : "unknown",
    });
    return refuse("The storage request failed.", 503);
  }
};
