import type {
  ThreadReadOnlyResponseSchema,
  ThreadStorageErrorResponse,
  ThreadStorageListResponse,
} from "@dx/api";
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
  isReadableThreadStorageFile,
  isThreadStorageFileId,
  mayReadStoredFile,
  type ThreadStorageRow,
  threadStorageFileData,
} from "./store.js";

const LIST_LIMIT = 200;

const REFUSALS = {
  THREAD_STORAGE_FILE_NOT_FOUND: [404, "File not found."],
  THREAD_STORAGE_UNAVAILABLE: [503, "Thread storage is unavailable."],
  THREAD_STORAGE_REQUEST_FAILED: [503, "The storage request failed."],
} as const satisfies Record<
  ThreadStorageErrorResponse["data"]["code"],
  readonly [404 | 503, ThreadStorageErrorResponse["data"]["message"]]
>;

/** The refusals of `ThreadStorageErrorResponseSchema` in @dx/api. */
const refuse = (context: Context<AppEnv>, code: keyof typeof REFUSALS) => {
  const [status, message] = REFUSALS[code];
  context.header("Cache-Control", "no-store");
  return context.json(
    {
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    } as ThreadStorageErrorResponse,
    status,
  );
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
      return refuse(context, "THREAD_STORAGE_REQUEST_FAILED");
    }
  };

/**
 * Reading a Thread's storage, mounted at `/v1/threads` behind
 * `authorizeThread`: whoever can read the Thread, its owner or a member it is
 * shared with, reads the files its agent shared. Listing them, and the work a
 * read-only restart rescued, are Orb contents: `authorizeThread` refuses the
 * list, and this route the rescued work, to a View-only member. Nothing here needs the Thread's Orb or its
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
        return refuse(context, "THREAD_STORAGE_UNAVAILABLE");
      const { results } = await db
        .prepare(
          `SELECT * FROM thread_storage_files
            WHERE thread_id = ? AND state = 'ready' AND expires_at IS NULL
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
      const now = Date.now();
      const db = context.env.DB;
      const transfer = attachmentTransfer(context.env);
      if (db === undefined || transfer === undefined)
        return refuse(context, "THREAD_STORAGE_UNAVAILABLE");
      const row = isThreadStorageFileId(fileId)
        ? await findThreadStorageFile(db, fileId)
        : null;
      // The URL's Thread is the one authorized; the file must be its own.
      if (
        row === null ||
        !isReadableThreadStorageFile(row, now) ||
        row.thread_id !== context.req.param("threadId")
      )
        return refuse(context, "THREAD_STORAGE_FILE_NOT_FOUND");
      if (!mayReadStoredFile(row, context.get("threadAccess"))) {
        context.header("Cache-Control", "no-store");
        return context.json(
          {
            status: "error",
            data: {
              code: "THREAD_READ_ONLY",
              message: "Only contributors can open the Orb's rescued work.",
              requestId: context.get("requestId"),
            },
          } satisfies typeof ThreadReadOnlyResponseSchema.Type,
          403,
        );
      }
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
          // Shorter than the signature, so a cached redirect stays valid,
          // and never past a temporary file's expiry.
          "cache-control": `private, max-age=${
            row.expires_at === null
              ? 600
              : Math.min(600, Math.floor((row.expires_at - now) / 1000))
          }`,
        },
      });
    }),
  );
