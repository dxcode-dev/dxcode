import {
  type AttachmentData,
  type AttachmentErrorResponse,
  AttachmentErrorResponseSchema,
  CompleteAttachmentRequestSchema,
  CreateAttachmentRequestSchema,
  type CreateAttachmentResponse,
  sanitizeAttachmentFilename,
} from "@dx/api";
import { Schema } from "effect";
import { type Context, Hono } from "hono";
import { readBoundedJson } from "../http/bounded-body.js";
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

type AttachmentRefusal = AttachmentErrorResponse["data"]["code"];

const REFUSALS = {
  INVALID_REQUEST: [400, "The attachment request is invalid."],
  ATTACHMENT_NOT_FOUND: [404, "Attachment not found."],
  ATTACHMENT_PARTS_INCOMPLETE: [400, "The uploaded parts are incomplete."],
  ATTACHMENT_SIZE_MISMATCH: [400, "The uploaded file has the wrong size."],
  ATTACHMENT_ALREADY_SENT: [409, "The attachment was already sent."],
  ATTACHMENTS_UNAVAILABLE: [503, "Attachments are unavailable."],
  ATTACHMENT_REQUEST_FAILED: [503, "The attachment request failed."],
} as const satisfies Record<AttachmentRefusal, readonly [number, string]>;

const error = (context: Context<AppEnv>, code: AttachmentRefusal) => {
  const [status, message] = REFUSALS[code];
  context.header("Cache-Control", "no-store");
  return context.json(
    Schema.encodeUnknownSync(AttachmentErrorResponseSchema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );
};

const notFound = (context: Context<AppEnv>) =>
  error(context, "ATTACHMENT_NOT_FOUND");

const decodeJson = async <A>(
  context: Context<AppEnv>,
  schema: Schema.Codec<A, unknown>,
) => {
  try {
    return Schema.decodeUnknownSync(schema)(
      await readBoundedJson(context.req.raw),
    );
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
        return error(context, "ATTACHMENTS_UNAVAILABLE");
      attachmentLogger.error("Attachment request failed.", {
        event: "attachment_request_failed",
        operation,
        requestId: context.get("requestId"),
        errorName: cause instanceof Error ? cause.name : "UnknownError",
        errorMessage:
          cause instanceof Error ? cause.message.slice(0, 500) : "unknown",
      });
      return error(context, "ATTACHMENT_REQUEST_FAILED");
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
      if (input === undefined) return error(context, "INVALID_REQUEST");
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
        return error(context, "ATTACHMENT_PARTS_INCOMPLETE");
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
        return error(context, "ATTACHMENT_SIZE_MISMATCH");
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
        return error(context, "ATTACHMENT_ALREADY_SENT");
      return context.body(null, 204);
    }),
  )
  .on(
    ["GET", "HEAD"],
    ["/:id", "/:id/:filename"],
    handle("read", async (context) => {
      const id = context.req.param("id");
      if (!isAttachmentId(id)) return notFound(context);
      const { db, transfer } = attachmentContext(context);
      const row = await findAttachment(db, id);
      if (
        row === null ||
        !(await canReadAttachment(db, row, context.get("principal")))
      )
        return notFound(context);
      const download = context.req.query("download") === "1";
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
