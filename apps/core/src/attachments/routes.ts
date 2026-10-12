import {
  type AttachmentData,
  type AttachmentError,
  type AttachmentPartResponse,
  CompleteAttachmentRequestSchema,
  CreateAttachmentRequestSchema,
  type CreateAttachmentResponse,
  sanitizeAttachmentFilename,
} from "@dx/api";
import { Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { attachmentLogger } from "../logging.js";
import { canReadAttachment } from "./access.js";
import {
  AttachmentStorageUnavailable,
  attachmentBindings,
  attachmentData,
  attachmentObjectKey,
  attachmentOrigin,
  attachmentPartCount,
  attachmentPartLength,
  attachmentResponseType,
  deleteUnsentAttachment,
  findAttachment,
  isAttachmentId,
  newAttachmentId,
  purgeUnsentAttachments,
  readAttachmentHead,
  resolveAttachmentType,
  serveAttachment,
} from "./store.js";
import { attachmentTransfer, bareEtag } from "./transfer.js";

/** Bindings and transfer; attachments need both. */
const attachmentContext = (context: Context<AppEnv>) => {
  const transfer = attachmentTransfer(context.env);
  if (transfer === undefined) throw new AttachmentStorageUnavailable();
  return { ...attachmentBindings(context.env), transfer };
};

/** Run `work` after the response when the platform allows it. */
const afterResponse = (context: Context<AppEnv>, work: Promise<unknown>) => {
  const settled = work.catch(() => undefined);
  try {
    context.executionCtx.waitUntil(settled);
  } catch {
    // No execution context (tests): the work still runs.
  }
};

const error = (
  context: Context<AppEnv>,
  message: string,
  status: 400 | 403 | 404 | 409 | 413 | 503,
) => {
  context.header("Cache-Control", "no-store");
  return context.json<AttachmentError>({ error: message }, status);
};

const notFound = (context: Context<AppEnv>) =>
  error(context, "Attachment not found.", 404);

const decodeJson = async <A>(
  context: Context<AppEnv>,
  schema: Schema.Codec<A, unknown>,
) => {
  try {
    return Schema.decodeUnknownSync(schema)(await context.req.json());
  } catch {
    return undefined;
  }
};

/** The caller's own attachment that is still uploading. */
const ownUpload = async (context: Context<AppEnv>, id: string | undefined) => {
  if (!isAttachmentId(id)) return undefined;
  const { db } = attachmentBindings(context.env);
  const row = await findAttachment(db, id);
  return row !== null &&
    row.uploader_user_id === context.get("principal").userId &&
    row.state === "uploading" &&
    row.upload_id !== null
    ? row
    : undefined;
};

const handle =
  (operation: string, run: (context: Context<AppEnv>) => Promise<Response>) =>
  async (context: Context<AppEnv>) => {
    try {
      return await run(context);
    } catch (cause) {
      if (cause instanceof AttachmentStorageUnavailable)
        return error(context, "Attachments are unavailable.", 503);
      attachmentLogger.error("Attachment request failed.", {
        event: "attachment_request_failed",
        operation,
        requestId: context.get("requestId"),
        errorName: cause instanceof Error ? cause.name : "UnknownError",
        errorMessage:
          cause instanceof Error ? cause.message.slice(0, 500) : "unknown",
      });
      return error(context, "The attachment request failed.", 503);
    }
  };

/**
 * Uploads and downloads of message attachments, mounted at `/v1/attachments`
 * after authentication. A file uploads as an R2 multipart upload in parts of
 * `ATTACHMENT_PART_BYTES`, so a 500 MB file never needs one large request.
 */
export const attachmentRoutes = new Hono<AppEnv>()
  .post(
    "/",
    handle("create", async (context) => {
      const input = await decodeJson(context, CreateAttachmentRequestSchema);
      if (input === undefined)
        return error(context, "The attachment request is invalid.", 400);
      const { db, transfer } = attachmentContext(context);
      const uploader = context.get("principal").userId;
      // Each new upload also clears this uploader's abandoned ones, so
      // nothing depends on a scheduled job being configured.
      afterResponse(
        context,
        purgeUnsentAttachments(context.env, transfer, Date.now(), {
          uploaderUserId: uploader,
          limit: 20,
        }),
      );
      const id = newAttachmentId();
      const key = attachmentObjectKey(uploader, id);
      const uploadId = await transfer.create(key);
      await db
        .prepare(
          `INSERT INTO attachments
             (id, uploader_user_id, object_key, upload_id, filename, mime_type,
              size, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', ?)`,
        )
        .bind(
          id,
          uploader,
          key,
          uploadId,
          sanitizeAttachmentFilename(input.filename),
          input.mimeType.trim().slice(0, 255) || "application/octet-stream",
          input.size,
          Date.now(),
        )
        .run();
      const partCount = attachmentPartCount(input.size);
      const urls = await transfer.partUrls(
        id,
        key,
        uploadId,
        Array.from(
          { length: partCount },
          (_, index) => attachmentPartLength(input.size, index + 1) ?? 0,
        ),
      );
      context.header("Cache-Control", "no-store");
      return context.json<CreateAttachmentResponse>(
        {
          id,
          partSize: attachmentPartLength(input.size, 1) ?? input.size,
          partCount,
          parts: urls.map((url, index) => ({ partNumber: index + 1, url })),
        },
        201,
      );
    }),
  )
  .put(
    "/:id/parts/:partNumber",
    handle("part", async (context) => {
      // Deployed stages upload parts straight to R2.
      if (attachmentContext(context).transfer.kind !== "core")
        return notFound(context);
      const row = await ownUpload(context, context.req.param("id"));
      if (row === undefined) return notFound(context);
      const partNumber = Number(context.req.param("partNumber"));
      const expected = Number.isInteger(partNumber)
        ? attachmentPartLength(row.size, partNumber)
        : undefined;
      if (expected === undefined)
        return error(context, "The part number is invalid.", 400);
      const bytes = await context.req.arrayBuffer();
      if (bytes.byteLength !== expected)
        return error(context, "The part has the wrong size.", 400);
      const { bucket } = attachmentBindings(context.env);
      const part = await bucket
        .resumeMultipartUpload(row.object_key, row.upload_id as string)
        .uploadPart(partNumber, bytes);
      context.header("Cache-Control", "no-store");
      // The same contract as R2: the part is named by its ETag header.
      context.header("ETag", `"${part.etag}"`);
      return context.json<AttachmentPartResponse>({
        partNumber: part.partNumber,
        etag: part.etag,
      });
    }),
  )
  .post(
    "/:id/complete",
    handle("complete", async (context) => {
      const row = await ownUpload(context, context.req.param("id"));
      if (row === undefined) return notFound(context);
      const input = await decodeJson(context, CompleteAttachmentRequestSchema);
      const count = attachmentPartCount(row.size);
      const numbers = input?.parts.map(({ partNumber }) => partNumber) ?? [];
      if (
        input === undefined ||
        numbers.length !== count ||
        numbers.some((value, index) => value !== index + 1)
      )
        return error(context, "The uploaded parts are incomplete.", 400);
      const { db, bucket, transfer } = attachmentContext(context);
      await transfer.complete(
        row.object_key,
        row.upload_id as string,
        input.parts.map(({ partNumber, etag }) => ({
          partNumber,
          etag: bareEtag(etag),
        })),
      );
      const object = await bucket.head(row.object_key);
      if (object?.size !== row.size) {
        await bucket.delete(row.object_key);
        await db
          .prepare("DELETE FROM attachments WHERE id = ?")
          .bind(row.id)
          .run();
        return error(context, "The uploaded file has the wrong size.", 400);
      }
      const mimeType = resolveAttachmentType(
        row.mime_type,
        await readAttachmentHead(bucket, row.object_key, row.size),
      );
      await db
        .prepare(
          `UPDATE attachments
              SET state = 'ready', upload_id = NULL, mime_type = ?
            WHERE id = ? AND state = 'uploading'`,
        )
        .bind(mimeType, row.id)
        .run();
      attachmentLogger.info("Attachment uploaded.", {
        event: "attachment_uploaded",
        attachmentId: row.id,
        size: row.size,
        mimeType,
        requestId: context.get("requestId"),
      });
      context.header("Cache-Control", "no-store");
      return context.json<AttachmentData>(
        attachmentData(
          { ...row, mime_type: mimeType },
          attachmentOrigin(context.env, context.req.url),
        ),
      );
    }),
  )
  .delete(
    "/:id",
    handle("delete", async (context) => {
      const id = context.req.param("id");
      if (!isAttachmentId(id)) return notFound(context);
      const { db, bucket, transfer } = attachmentContext(context);
      const row = await findAttachment(db, id);
      if (
        row === null ||
        row.uploader_user_id !== context.get("principal").userId
      )
        return notFound(context);
      // A sent message keeps its files.
      if (!(await deleteUnsentAttachment(db, bucket, transfer, row)))
        return error(context, "The attachment was already sent.", 409);
      return context.body(null, 204);
    }),
  )
  .on(
    ["GET", "HEAD"],
    ["/:id", "/:id/:filename"],
    handle("read", async (context) => {
      const id = context.req.param("id");
      if (!isAttachmentId(id)) return notFound(context);
      const { db, bucket, transfer } = attachmentContext(context);
      const row = await findAttachment(db, id);
      if (
        row === null ||
        !(await canReadAttachment(db, row, context.get("principal")))
      )
        return notFound(context);
      const download = context.req.query("download") === "1";
      if (transfer.kind === "core")
        return serveAttachment(bucket, row, context.req.raw, { download });
      // The bytes come straight from R2; Core only authorizes and signs.
      const location = await transfer.readUrl(
        row.object_key,
        attachmentResponseType(row, download),
      );
      return new Response(null, {
        status: 302,
        headers: {
          location,
          // Shorter than the signature, so a cached redirect stays valid.
          "cache-control": "private, max-age=600",
        },
      });
    }),
  );
