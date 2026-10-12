import { Principal } from "@dx/domain";
import { Effect, Schema } from "effect";
import { authorizeThreadRequest } from "../auth/authorize-thread.js";
import type { AttachmentRow } from "./store.js";

/** The Threads checked when deciding who may read a file. */
const MAX_CHECKED_THREADS = 50;

/**
 * Whether a user may read an attachment: their own upload, or a file sent in
 * any Thread they can read (owned, or shared with them). The browser and the
 * guest's `dxd files get`, which acts as the Thread's owner, use the same
 * rule, so an agent can fetch any file its owner could open.
 */
export const canReadAttachment = async (
  db: D1Database,
  row: AttachmentRow,
  principal: Principal,
) => {
  if (row.state !== "ready") return false;
  if (row.uploader_user_id === principal.userId) return true;
  const { results } = await db
    .prepare(
      `SELECT thread_id FROM attachment_threads
        WHERE attachment_id = ?
        ORDER BY created_at
        LIMIT ?`,
    )
    .bind(row.id, MAX_CHECKED_THREADS)
    .all<{ readonly thread_id: string }>();
  for (const { thread_id } of results) {
    const access = await Effect.runPromise(
      authorizeThreadRequest(thread_id, principal, db),
    );
    if (access.authorized) return true;
  }
  return false;
};

export const userPrincipal = (userId: string) =>
  Schema.decodeUnknownSync(Principal)({ userId });
