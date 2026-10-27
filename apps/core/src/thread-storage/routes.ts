import type { ThreadStorageError, ThreadStorageListResponse } from "@dx/api";
import { type Context, Hono } from "hono";
import {
  attachmentOrigin,
  attachmentResponseType,
} from "../attachments/store.js";
import { attachmentTransfer } from "../attachments/transfer.js";
import type { AppEnv } from "../http/types.js";
import { threadStorageLogger } from "../logging.js";
import {
  findThreadStorageFile,
  isThreadStorageFileId,
  type ThreadStorageRow,
  threadStorageFileData,
} from "./store.js";

const LIST_LIMIT = 200;

const refuse = (context: Context<AppEnv>, error: string, status: 404 | 503) => {
  context.header("Cache-Control", "no-store");
  return context.json<ThreadStorageError>({ error }, status);
};

const handle =
  (operation: string, run: (context: Context<AppEnv>) => Promise<Response>) =>
  async (context: Context<AppEnv>) => {
    try {
      return await run(context);
    } catch (cause) {
      threadStorageLogger.error("Thread storage request failed.", {
        event: "thread_storage_request_failed",
        operation,
        requestId: context.get("requestId"),
        errorName: cause instanceof Error ? cause.name : "UnknownError",
        errorMessage:
          cause instanceof Error ? cause.message.slice(0, 500) : "unknown",
      });
      return refuse(context, "The storage request failed.", 503);
    }
  };

/**
 * Reading a Thread's storage, mounted at `/v1/threads` behind
 * `authorizeThread`: whoever can read the Thread, its owner or a member it is
 * shared with, reads its files. Nothing here needs the Thread's Orb or its
 * execution object, so a file stays readable after the Orb sleeps, stops, or
 * is destroyed, and while the Thread is archived. There is no write route:
 * only the Thread's own dxd writes, through the daemon ingress.
 */
export const threadStorageRoutes = new Hono<AppEnv>()
  .get(
    "/:threadId/storage",
    handle("list", async (context) => {
      const db = context.env.DB;
      if (db === undefined)
        return refuse(context, "Thread storage is unavailable.", 503);
      const { results } = await db
        .prepare(
          `SELECT * FROM thread_storage_files
            WHERE thread_id = ? AND state = 'ready'
            ORDER BY created_at DESC, rowid DESC
            LIMIT ?`,
        )
        .bind(context.req.param("threadId"), LIST_LIMIT)
        .all<ThreadStorageRow>();
      const origin = attachmentOrigin(context.env, context.req.url);
      context.header("Cache-Control", "no-store");
      return context.json<ThreadStorageListResponse>({
        files: results.map((row) => threadStorageFileData(row, origin)),
      });
    }),
  )
  .on(
    ["GET", "HEAD"],
    ["/:threadId/storage/:fileId", "/:threadId/storage/:fileId/:name"],
    handle("read", async (context) => {
      const fileId = context.req.param("fileId");
      const db = context.env.DB;
      const transfer = attachmentTransfer(context.env);
      if (db === undefined || transfer === undefined)
        return refuse(context, "Thread storage is unavailable.", 503);
      const row = isThreadStorageFileId(fileId)
        ? await findThreadStorageFile(db, fileId)
        : null;
      // The URL's Thread is the one authorized; the file must be its own.
      if (
        row === null ||
        row.state !== "ready" ||
        row.thread_id !== context.req.param("threadId")
      )
        return refuse(context, "File not found.", 404);
      // The bytes come straight from R2; Core only authorizes and signs.
      const location = await transfer.readUrl(
        row.object_key,
        attachmentResponseType(
          { mime_type: row.mime_type, filename: row.name },
          context.req.query("download") === "1",
        ),
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
