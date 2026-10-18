import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  type MessageAttachment,
  parseMessageAttachments,
  stripMessageAttachmentTags,
  withMessageAttachments,
} from "@dx/api";
import type { Bindings } from "../http/types.js";
import { canReadAttachment, userPrincipal } from "./access.js";
import {
  type AttachmentRow,
  attachmentData,
  attachmentOrigin,
  findAttachment,
  isAttachmentId,
} from "./store.js";

export class MessageAttachmentsRejected extends Error {}

export interface ResolvedMessageAttachments {
  /** What the person wrote, without any attachment tags. */
  readonly text: string;
  readonly rows: ReadonlyArray<AttachmentRow>;
}

/**
 * Check the files a user message names without changing anything. The
 * client's `<dx_attachments>` block only proposes attachment ids: each must
 * be a finished upload the sender can read, their own or one sent in a
 * Thread they can read. Thread creation runs this before it creates the
 * Thread, so a refused message never leaves an empty Thread behind.
 */
export const resolveMessageAttachments = async (
  bindings: Bindings,
  input: { readonly senderUserId: string; readonly body: string },
): Promise<ResolvedMessageAttachments> => {
  const parsed = parseMessageAttachments(input.body);
  const ids = [...new Set(parsed.attachments.map(({ id }) => id))];
  // Tags a person typed must not pose as files.
  if (ids.length === 0)
    return { text: stripMessageAttachmentTags(input.body), rows: [] };
  if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE)
    throw new MessageAttachmentsRejected(
      `Attach no more than ${MAX_ATTACHMENTS_PER_MESSAGE} files.`,
    );
  if (!ids.every(isAttachmentId))
    throw new MessageAttachmentsRejected("An attachment is invalid.");
  const db = bindings.DB;
  if (db === undefined)
    throw new MessageAttachmentsRejected("Attachments are unavailable.");
  const sender = userPrincipal(input.senderUserId);
  const rows: AttachmentRow[] = [];
  for (const id of ids) {
    const row = await findAttachment(db, id);
    if (row === null || !(await canReadAttachment(db, row, sender)))
      throw new MessageAttachmentsRejected(
        "An attachment is unavailable. Remove it and attach the file again.",
      );
    rows.push(row);
  }
  return { text: parsed.text, rows };
};

/**
 * The message as the agent receives it: the block rewritten from Core's
 * records, so the agent sees each file's real name, type, size, and download
 * URL. It records nothing, so a refused message leaves no trace, and a retry
 * of the same message produces the same body, which Flue needs to recognize
 * it.
 */
export const messageAttachmentBody = (
  bindings: Bindings,
  resolved: ResolvedMessageAttachments,
  requestUrl: string,
): {
  readonly body: string;
  readonly attachments: ReadonlyArray<MessageAttachment>;
} => {
  if (resolved.rows.length === 0)
    return { body: resolved.text, attachments: [] };
  const origin = attachmentOrigin(bindings, requestUrl);
  const attachments = resolved.rows.map((row) => {
    const data = attachmentData(row, origin);
    return {
      id: data.id,
      name: data.filename,
      mimeType: data.mimeType,
      size: data.size,
      url: data.url,
    };
  });
  return {
    body: withMessageAttachments(resolved.text, attachments),
    attachments,
  };
};

/**
 * Record that a message sent its files in this Thread, which lets every
 * reader of the Thread open them and stops their deletion. Recording a file
 * again is a no-op, so a retried message can record it again.
 */
export const linkMessageAttachments = async (
  db: D1Database,
  input: {
    readonly threadId: string;
    readonly senderUserId: string;
    readonly rows: ReadonlyArray<AttachmentRow>;
  },
) => {
  if (input.rows.length === 0) return;
  const now = Date.now();
  try {
    // The foreign key refuses a file deleted since the check.
    await db.batch(
      input.rows.map((row) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO attachment_threads
               (attachment_id, thread_id, sender_user_id, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(row.id, input.threadId, input.senderUserId, now),
      ),
    );
  } catch {
    throw new MessageAttachmentsRejected(
      "An attachment is unavailable. Remove it and attach the file again.",
    );
  }
};

/** Records the message's files in the Thread, then rewrites its block. */
export const admitMessageAttachments = async (
  bindings: Bindings,
  input: {
    readonly threadId: string;
    readonly senderUserId: string;
    readonly body: string;
    readonly requestUrl: string;
    /** Already checked by `resolveMessageAttachments`. */
    readonly resolved?: ResolvedMessageAttachments;
  },
) => {
  const resolved =
    input.resolved ?? (await resolveMessageAttachments(bindings, input));
  await linkMessageAttachments(bindings.DB as D1Database, {
    threadId: input.threadId,
    senderUserId: input.senderUserId,
    rows: resolved.rows,
  });
  return messageAttachmentBody(bindings, resolved, input.requestUrl);
};
