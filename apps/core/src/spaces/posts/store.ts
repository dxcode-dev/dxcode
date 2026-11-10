import type {
  MessageCommentPerson,
  SpacePost,
  SpacePostReaction,
} from "@dx/api";
import { DateTime } from "effect";
import { peopleById } from "../message-comments/store.js";

/**
 * A Space's posts in D1 (`space_post`, `space_post_revision`,
 * `space_post_reaction`): people's posts and the agent's, their earlier
 * versions, and their reactions. Routes and tools read and write them here.
 */

export interface SpacePostRow {
  readonly id: string;
  readonly space_thread_id: string;
  readonly author_kind: "user" | "agent";
  readonly author_user_id: string | null;
  readonly text: string;
  readonly request_key: string;
  readonly submission_id: string | null;
  readonly created_at: number;
  readonly edited_at: number | null;
}

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * A new post ID: `pst_` and 26 characters, the first ten the time, so IDs
 * sort roughly by when they were made.
 */
export const newSpacePostId = (now = Date.now()) => {
  let time = "";
  let rest = Math.max(0, Math.floor(now));
  for (let index = 0; index < 10; index++) {
    time = `${CROCKFORD[rest % 32]}${time}`;
    rest = Math.floor(rest / 32);
  }
  const random = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((value) => CROCKFORD[value % 32])
    .join("");
  return `pst_${time}${random}`;
};

const COLUMNS = `id, space_thread_id, author_kind, author_user_id, text, request_key,
  submission_id, created_at, edited_at`;

/**
 * Creates a post once per `requestKey`: a retry with the same key returns
 * the post the first attempt made, with `created` false.
 */
export const insertSpacePost = async (
  db: D1Database,
  input: {
    readonly spaceThreadId: string;
    readonly authorKind: "user" | "agent";
    readonly authorUserId: string | null;
    readonly text: string;
    readonly requestKey: string;
    readonly id?: string;
    readonly now?: number;
  },
): Promise<{ readonly post: SpacePostRow; readonly created: boolean }> => {
  const now = input.now ?? Date.now();
  const id = input.id ?? newSpacePostId(now);
  const inserted = await db
    .prepare(
      `INSERT INTO space_post
         (id, space_thread_id, author_kind, author_user_id, text, request_key,
          created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (space_thread_id, request_key) DO NOTHING`,
    )
    .bind(
      id,
      input.spaceThreadId,
      input.authorKind,
      input.authorUserId,
      input.text,
      input.requestKey,
      now,
    )
    .run();
  const post = await db
    .prepare(
      `SELECT ${COLUMNS} FROM space_post
        WHERE space_thread_id = ?1 AND request_key = ?2`,
    )
    .bind(input.spaceThreadId, input.requestKey)
    .first<SpacePostRow>();
  if (post === null) throw new Error("The post was not stored.");
  return { post, created: inserted.meta.changes > 0 };
};

/** One live post of this Space, or null. */
export const readSpacePost = (
  db: D1Database,
  spaceThreadId: string,
  postId: string,
) =>
  db
    .prepare(
      `SELECT ${COLUMNS} FROM space_post
        WHERE id = ?1 AND space_thread_id = ?2 AND deleted_at IS NULL`,
    )
    .bind(postId, spaceThreadId)
    .first<SpacePostRow>();

/** Forgets a post nobody's agent received. */
export const deleteSpacePost = async (db: D1Database, postId: string) => {
  await db.prepare("DELETE FROM space_post WHERE id = ?").bind(postId).run();
};

/**
 * Replaces a post's text, keeping the text it replaces as its next
 * revision. False when the post changed meanwhile (the caller read `post`).
 */
export const editSpacePost = async (
  db: D1Database,
  post: SpacePostRow,
  text: string,
  now = Date.now(),
) => {
  const [, updated] = await db.batch([
    db
      .prepare(
        `INSERT INTO space_post_revision (post_id, revision, text, created_at)
         SELECT ?1, count(*) + 1, ?2, ?3 FROM space_post_revision
          WHERE post_id = ?1`,
      )
      .bind(post.id, post.text, post.edited_at ?? post.created_at),
    db
      .prepare(
        `UPDATE space_post SET text = ?2, edited_at = ?3
          WHERE id = ?1 AND text = ?4`,
      )
      .bind(post.id, text, Math.max(now, post.created_at), post.text),
  ]);
  return (updated?.meta.changes ?? 0) > 0;
};

/** Every version of a post, oldest first; the last is its current text. */
export const listSpacePostRevisions = async (
  db: D1Database,
  post: SpacePostRow,
) => {
  const { results } = await db
    .prepare(
      `SELECT revision, text, created_at FROM space_post_revision
        WHERE post_id = ?1 ORDER BY revision`,
    )
    .bind(post.id)
    .all<{ revision: number; text: string; created_at: number }>();
  return [
    ...results,
    {
      revision: results.length + 1,
      text: post.text,
      created_at: post.edited_at ?? post.created_at,
    },
  ];
};

/** Records the agent submission a person's post reached. */
export const recordPostSubmission = async (
  db: D1Database,
  postId: string,
  submissionId: string,
) => {
  await db
    .prepare("UPDATE space_post SET submission_id = ?2 WHERE id = ?1")
    .bind(postId, submissionId)
    .run();
};

/**
 * Gives (`on`) or takes back a reaction. True when it changed anything.
 */
export const setSpacePostReaction = async (
  db: D1Database,
  input: {
    readonly postId: string;
    readonly reactor: { readonly kind: "agent" } | { readonly userId: string };
    readonly reaction: SpacePostReaction;
    readonly on: boolean;
    readonly now?: number;
  },
) => {
  const kind = "userId" in input.reactor ? "user" : "agent";
  const userId = "userId" in input.reactor ? input.reactor.userId : null;
  const result = input.on
    ? await db
        .prepare(
          `INSERT OR IGNORE INTO space_post_reaction
             (post_id, reactor_kind, user_id, reaction, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(
          input.postId,
          kind,
          userId,
          input.reaction,
          input.now ?? Date.now(),
        )
        .run()
    : await db
        .prepare(
          `DELETE FROM space_post_reaction
            WHERE post_id = ?1 AND reactor_kind = ?2
              AND ifnull(user_id, '') = ifnull(?3, '') AND reaction = ?4`,
        )
        .bind(input.postId, kind, userId, input.reaction)
        .run();
  return result.meta.changes > 0;
};

/**
 * Takes away dx's `eyes` from the Space's posts that reached the agent in
 * `submissionId`, or from all of them when it is undefined. The number of
 * reactions removed.
 */
export const clearAgentEyes = async (
  db: D1Database,
  spaceThreadId: string,
  submissionId?: string,
) =>
  (
    await db
      .prepare(
        `DELETE FROM space_post_reaction
          WHERE reactor_kind = 'agent' AND reaction = 'eyes'
            AND post_id IN (
              SELECT id FROM space_post
               WHERE space_thread_id = ?1 AND author_kind = 'user'
                 AND (?2 IS NULL OR submission_id = ?2))`,
      )
      .bind(spaceThreadId, submissionId ?? null)
      .run()
  ).meta.changes;

/**
 * The newest `limit` posts older than `before`, oldest first, and whether
 * older ones remain.
 */
export const listSpacePostRows = async (
  db: D1Database,
  spaceThreadId: string,
  options: { readonly before?: SpacePostRow; readonly limit: number },
) => {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM space_post
        WHERE space_thread_id = ?1 AND deleted_at IS NULL
          AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3))
        ORDER BY created_at DESC, id DESC
        LIMIT ?4`,
    )
    .bind(
      spaceThreadId,
      options.before?.created_at ?? null,
      options.before?.id ?? null,
      options.limit + 1,
    )
    .all<SpacePostRow>();
  return {
    rows: results.slice(0, options.limit).toReversed(),
    more: results.length > options.limit,
  };
};

export interface SpacePostDetails {
  readonly row: SpacePostRow;
  readonly author: SpacePost["author"];
  readonly revisionCount: number;
  readonly reactions: ReadonlyArray<{
    readonly reaction: SpacePostReaction;
    readonly count: number;
    readonly mine: boolean;
    readonly agent: boolean;
    /** Who gave it, people by name; the agent as "dx". */
    readonly by: ReadonlyArray<string>;
  }>;
  readonly comments: {
    readonly count: number;
    readonly lastAt?: number;
    readonly commenters: ReadonlyArray<MessageCommentPerson>;
  };
}

/** Posts with their authors, reactions, edits, and comments. */
export const spacePostDetails = async (
  db: D1Database,
  rows: ReadonlyArray<SpacePostRow>,
  /** Whose reactions count as `mine`; none for the agent. */
  viewerUserId?: string,
): Promise<ReadonlyArray<SpacePostDetails>> => {
  if (rows.length === 0) return [];
  const ids = JSON.stringify(rows.map(({ id }) => id));
  const spaceThreadId = rows[0]?.space_thread_id ?? "";
  const [reactions, revisions, comments] = await db.batch<
    Record<string, unknown>
  >([
    db
      .prepare(
        `SELECT post_id, reactor_kind, user_id, reaction FROM space_post_reaction
          WHERE post_id IN (SELECT value FROM json_each(?1))
          ORDER BY created_at, rowid`,
      )
      .bind(ids),
    db
      .prepare(
        `SELECT post_id, count(*) AS revisions FROM space_post_revision
          WHERE post_id IN (SELECT value FROM json_each(?1))
          GROUP BY post_id`,
      )
      .bind(ids),
    db
      .prepare(
        `SELECT message_id, author_user_id, created_at FROM space_comment
          WHERE thread_id = ?2
            AND message_id IN (SELECT value FROM json_each(?1))
          ORDER BY created_at DESC, id DESC`,
      )
      .bind(ids, spaceThreadId),
  ]);
  const reactionRows = (reactions?.results ?? []) as Array<{
    post_id: string;
    reactor_kind: "user" | "agent";
    user_id: string | null;
    reaction: SpacePostReaction;
  }>;
  const commentRows = (comments?.results ?? []) as Array<{
    message_id: string;
    author_user_id: string | null;
    created_at: number;
  }>;
  const people = await peopleById(db, [
    ...rows.map(({ author_user_id }) => author_user_id),
    ...reactionRows.map(({ user_id }) => user_id),
    ...commentRows.map(({ author_user_id }) => author_user_id),
  ]);
  const revisionCounts = new Map(
    (
      (revisions?.results ?? []) as Array<{
        post_id: string;
        revisions: number;
      }>
    ).map(({ post_id, revisions: count }) => [post_id, count]),
  );
  return rows.map((row) => {
    const person =
      row.author_user_id === null ? undefined : people.get(row.author_user_id);
    const author: SpacePost["author"] =
      row.author_kind === "agent"
        ? { kind: "agent", name: "dx" }
        : person === undefined
          ? { kind: "user", name: "Former member" }
          : { kind: "user", ...person };
    const grouped = new Map<
      SpacePostReaction,
      { count: number; mine: boolean; agent: boolean; by: string[] }
    >();
    for (const reaction of reactionRows) {
      if (reaction.post_id !== row.id) continue;
      const entry = grouped.get(reaction.reaction) ?? {
        count: 0,
        mine: false,
        agent: false,
        by: [],
      };
      entry.count += 1;
      if (reaction.reactor_kind === "agent") {
        entry.agent = true;
        entry.by.push("dx");
      } else {
        if (reaction.user_id === viewerUserId) entry.mine = true;
        entry.by.push(
          people.get(reaction.user_id ?? "")?.name ?? "Former member",
        );
      }
      grouped.set(reaction.reaction, entry);
    }
    const onPost = commentRows.filter(
      ({ message_id }) => message_id === row.id,
    );
    const commenters: MessageCommentPerson[] = [];
    for (const comment of onPost) {
      const commenter =
        comment.author_user_id === null
          ? undefined
          : people.get(comment.author_user_id);
      if (
        commenter !== undefined &&
        !commenters.some(({ userId }) => userId === commenter.userId) &&
        commenters.length < 3
      )
        commenters.push(commenter);
    }
    return {
      row,
      author,
      revisionCount: revisionCounts.get(row.id) ?? 0,
      reactions: [...grouped].map(([reaction, entry]) => ({
        reaction,
        ...entry,
      })),
      comments: {
        count: onPost.length,
        ...(onPost[0] === undefined ? {} : { lastAt: onPost[0].created_at }),
        commenters,
      },
    };
  });
};

const timestamp = (value: number) => DateTime.makeUnsafe(new Date(value));

/** A post as `GET /v1/spaces/:threadId/posts` returns it. */
export const spacePostData = (details: SpacePostDetails): SpacePost => ({
  id: details.row.id,
  author: details.author,
  text: details.row.text,
  createdAt: timestamp(details.row.created_at),
  ...(details.row.edited_at === null
    ? {}
    : { editedAt: timestamp(details.row.edited_at) }),
  revisionCount: details.revisionCount,
  reactions: details.reactions.map(({ reaction, count, mine, agent }) => ({
    reaction,
    count,
    mine,
    agent,
  })),
  comments: {
    count: details.comments.count,
    ...(details.comments.lastAt === undefined
      ? {}
      : { lastAt: timestamp(details.comments.lastAt) }),
    commenters: details.comments.commenters,
  },
});
