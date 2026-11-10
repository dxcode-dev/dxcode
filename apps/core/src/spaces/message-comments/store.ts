import {
  type CommentedMessage,
  commentAsksAgent,
  MESSAGE_COMMENT_EXCERPT_MAX_LENGTH,
  MESSAGE_COMMENT_LIMIT,
  MESSAGE_COMMENT_MAX_LENGTH,
  MESSAGE_COMMENT_SUMMARY_COMMENTERS,
  type MessageComment,
  type MessageCommentPerson,
  type MessageCommentSummary,
  plainCommentText,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { userImageSql } from "../../avatars/storage.js";
import { displayNameSql } from "../../thread-sharing/service.js";

/**
 * Comments on a Space's messages, in D1 (`space_comment`). Each row
 * also keeps the commented message as its first commenter saw it, so the
 * Space's Comments list quotes it without reading the transcript.
 */

interface CommentRow {
  readonly id: string;
  readonly message_id: string;
  readonly message_excerpt: string;
  readonly message_author_user_id: string | null;
  readonly message_sent_at: number | null;
  readonly author_user_id: string | null;
  readonly body: string;
  readonly created_at: number;
}

export const newMessageCommentId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `mcm_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
};

/** Whether the Thread is a live Space. */
export const isSpaceThread = async (db: D1Database, threadId: string) =>
  (await db
    .prepare(
      "SELECT 1 AS found FROM threads WHERE id = ? AND kind = 'space' AND lifecycle_state != 'deleted'",
    )
    .bind(threadId)
    .first<number>("found")) !== null;

/** The people these user IDs name, with the names and pictures dx shows. */
export const peopleById = async (
  db: D1Database,
  userIds: Iterable<string | null>,
): Promise<ReadonlyMap<string, MessageCommentPerson>> => {
  const ids = [...new Set([...userIds].filter((id) => id !== null))];
  if (ids.length === 0) return new Map();
  const { results } = await db
    .prepare(
      `SELECT "user".id AS user_id,
              ${displayNameSql('"user"', "account")} AS name,
              account.username AS handle,
              ${userImageSql('"user"', "account")} AS image
         FROM "user"
         LEFT JOIN personal_account AS account ON account.user_id = "user".id
        WHERE "user".id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(ids))
    .all<{
      user_id: string;
      name: string | null;
      handle: string | null;
      image: string | null;
    }>();
  return new Map(
    results.map((row) => [
      row.user_id,
      {
        userId: row.user_id as UserId,
        name: (row.name?.trim() || "Member").slice(0, 256),
        ...(row.handle === null || row.handle === ""
          ? {}
          : { handle: row.handle.slice(0, 64) }),
        ...(row.image === null || row.image.length > 2_048
          ? {}
          : { avatarUrl: row.image }),
      },
    ]),
  );
};

const person = (
  people: ReadonlyMap<string, MessageCommentPerson>,
  userId: string | null,
) => (userId === null ? null : (people.get(userId) ?? null));

const commentedMessage = (
  row: CommentRow,
  people: ReadonlyMap<string, MessageCommentPerson>,
): CommentedMessage => ({
  messageId: row.message_id,
  excerpt: row.message_excerpt,
  author: person(people, row.message_author_user_id),
  sentAt: row.message_sent_at,
});

const commentData = (
  row: CommentRow,
  people: ReadonlyMap<string, MessageCommentPerson>,
): MessageComment => ({
  id: row.id,
  messageId: row.message_id,
  author: person(people, row.author_user_id),
  body: row.body,
  asksAgent: commentAsksAgent(row.body),
  createdAt: row.created_at,
});

/** A comment's first line, as a list row shows it. */
const commentExcerpt = (body: string) => {
  const line =
    plainCommentText(body)
      .split(/\r\n|\r|\n/)
      .find((text) => text.trim() !== "")
      ?.trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};

/**
 * Every commented message of the Space, in the order the messages were
 * sent (then by first comment): the message, how many comments it has, the
 * latest, and its most recent commenters.
 */
export const listMessageCommentSummaries = async (
  db: D1Database,
  threadId: string,
): Promise<ReadonlyArray<MessageCommentSummary>> => {
  const { results } = await db
    .prepare(
      `SELECT * FROM (
         SELECT comment.*,
                ROW_NUMBER() OVER (PARTITION BY message_id
                                   ORDER BY created_at, id) AS first_rank,
                ROW_NUMBER() OVER (PARTITION BY message_id
                                   ORDER BY created_at DESC, id DESC) AS last_rank,
                COUNT(*) OVER (PARTITION BY message_id) AS comment_count
           FROM space_comment AS comment
          WHERE thread_id = ?1
       )
       WHERE first_rank = 1 OR last_rank = 1`,
    )
    .bind(threadId)
    .all<
      CommentRow & {
        first_rank: number;
        last_rank: number;
        comment_count: number;
      }
    >();
  const { results: commenterRows } = await db
    .prepare(
      `SELECT message_id, author_user_id, MAX(created_at) AS latest
         FROM space_comment
        WHERE thread_id = ?1 AND author_user_id IS NOT NULL
        GROUP BY message_id, author_user_id`,
    )
    .bind(threadId)
    .all<{ message_id: string; author_user_id: string; latest: number }>();
  const people = await peopleById(db, [
    ...results.flatMap((row) => [
      row.author_user_id,
      row.message_author_user_id,
    ]),
    ...commenterRows.map((row) => row.author_user_id),
  ]);
  const commenters = new Map<
    string,
    Array<{ userId: string; latest: number }>
  >();
  for (const row of commenterRows) {
    const list = commenters.get(row.message_id) ?? [];
    list.push({ userId: row.author_user_id, latest: row.latest });
    commenters.set(row.message_id, list);
  }
  const first = new Map<string, (typeof results)[number]>();
  const last = new Map<string, (typeof results)[number]>();
  for (const row of results) {
    if (row.first_rank === 1) first.set(row.message_id, row);
    if (row.last_rank === 1) last.set(row.message_id, row);
  }
  return [...first.values()]
    .toSorted(
      (a, b) =>
        (a.message_sent_at ?? a.created_at) -
          (b.message_sent_at ?? b.created_at) || a.created_at - b.created_at,
    )
    .map((row) => {
      const latest = last.get(row.message_id) ?? row;
      return {
        message: commentedMessage(row, people),
        count: row.comment_count,
        lastComment: {
          author: person(people, latest.author_user_id),
          excerpt: commentExcerpt(latest.body),
          createdAt: latest.created_at,
        },
        commenters: (commenters.get(row.message_id) ?? [])
          .toSorted((a, b) => b.latest - a.latest)
          .flatMap(({ userId }) => {
            const found = people.get(userId);
            return found === undefined ? [] : [found];
          })
          .slice(0, MESSAGE_COMMENT_SUMMARY_COMMENTERS),
      };
    });
};

/** One message's comments, oldest first, and the message as commented. */
export const listMessageComments = async (
  db: D1Database,
  threadId: string,
  messageId: string,
): Promise<{
  readonly message: CommentedMessage | null;
  readonly comments: ReadonlyArray<MessageComment>;
}> => {
  const { results } = await db
    .prepare(
      `SELECT * FROM space_comment
        WHERE thread_id = ?1 AND message_id = ?2
        ORDER BY created_at, id`,
    )
    .bind(threadId, messageId)
    .all<CommentRow>();
  const people = await peopleById(
    db,
    results.flatMap((row) => [row.author_user_id, row.message_author_user_id]),
  );
  const head = results[0];
  return {
    message: head === undefined ? null : commentedMessage(head, people),
    comments: results.map((row) => commentData(row, people)),
  };
};

export type AddMessageCommentResult =
  | {
      readonly kind: "saved";
      readonly comment: MessageComment;
      readonly message: CommentedMessage;
    }
  | { readonly kind: "limit" }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * Adds a person's comment on a message. The first comment records the
 * message's text (cut to `MESSAGE_COMMENT_EXCERPT_MAX_LENGTH`), author, and
 * time; later comments keep what the first recorded.
 */
export const addMessageComment = async (
  db: D1Database,
  input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly authorUserId: string;
    readonly body: string;
    readonly message: {
      readonly excerpt: string;
      readonly authorUserId?: string;
      readonly sentAt?: number;
    };
    readonly now?: number;
  },
): Promise<AddMessageCommentResult> => {
  const body = input.body.trim();
  if (body.length === 0 || body.length > MESSAGE_COMMENT_MAX_LENGTH)
    return {
      kind: "invalid",
      message: `A comment is 1 to ${MESSAGE_COMMENT_MAX_LENGTH} characters.`,
    };
  const existing = await db
    .prepare(
      `SELECT count(*) AS comment_count,
              (SELECT message_excerpt FROM space_comment
                WHERE thread_id = ?1 AND message_id = ?2
                ORDER BY created_at, id LIMIT 1) AS message_excerpt,
              (SELECT message_author_user_id FROM space_comment
                WHERE thread_id = ?1 AND message_id = ?2
                ORDER BY created_at, id LIMIT 1) AS message_author_user_id,
              (SELECT message_sent_at FROM space_comment
                WHERE thread_id = ?1 AND message_id = ?2
                ORDER BY created_at, id LIMIT 1) AS message_sent_at
         FROM space_comment
        WHERE thread_id = ?1 AND message_id = ?2`,
    )
    .bind(input.threadId, input.messageId)
    .first<{
      comment_count: number;
      message_excerpt: string | null;
      message_author_user_id: string | null;
      message_sent_at: number | null;
    }>();
  const count = existing?.comment_count ?? 0;
  if (count >= MESSAGE_COMMENT_LIMIT) return { kind: "limit" };
  const excerpt =
    count > 0 && existing?.message_excerpt != null
      ? existing.message_excerpt
      : input.message.excerpt.trim().length > MESSAGE_COMMENT_EXCERPT_MAX_LENGTH
        ? `${input.message.excerpt.trim().slice(0, MESSAGE_COMMENT_EXCERPT_MAX_LENGTH - 1)}…`
        : input.message.excerpt.trim();
  const messageAuthor =
    count > 0
      ? (existing?.message_author_user_id ?? null)
      : (input.message.authorUserId ?? null);
  const sentAt =
    count > 0
      ? (existing?.message_sent_at ?? null)
      : input.message.sentAt !== undefined &&
          Number.isSafeInteger(Math.round(input.message.sentAt))
        ? Math.round(input.message.sentAt)
        : null;
  const row: CommentRow = {
    id: newMessageCommentId(),
    message_id: input.messageId,
    message_excerpt: excerpt,
    message_author_user_id: messageAuthor,
    message_sent_at: sentAt,
    author_user_id: input.authorUserId,
    body,
    created_at: input.now ?? Date.now(),
  };
  await db
    .prepare(
      `INSERT INTO space_comment
         (id, thread_id, message_id, message_excerpt, message_author_user_id,
          message_sent_at, author_user_id, body, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      row.id,
      input.threadId,
      row.message_id,
      row.message_excerpt,
      row.message_author_user_id,
      row.message_sent_at,
      row.author_user_id,
      row.body,
      row.created_at,
    )
    .run();
  const people = await peopleById(db, [
    row.author_user_id,
    row.message_author_user_id,
  ]);
  return {
    kind: "saved",
    comment: commentData(row, people),
    message: commentedMessage(row, people),
  };
};
