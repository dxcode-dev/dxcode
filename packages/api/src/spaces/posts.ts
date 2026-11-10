import { Timestamp, UserId } from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";
import { MessageCommentPersonSchema } from "./message-comments.js";

/**
 * A Space's posts: what people see in its chat. A person's message in a
 * Space is a post, and the Space's agent publishes its own with the `post`
 * tool; the agent's text replies and tool calls are never shown. A post has
 * an ID (`pst_…`), can be edited by its author (earlier versions stay
 * readable), carries reactions, and takes comments (`message-comments`,
 * whose `messageId` is the post's ID).
 */

/** A post's text, in characters. */
export const SPACE_POST_MAX_LENGTH = 20_000;
/** Posts per page of `GET /v1/spaces/:threadId/posts`. */
export const SPACE_POSTS_DEFAULT_LIMIT = 50;
export const SPACE_POSTS_MAX_LIMIT = 100;

export const SPACE_POST_ID_PATTERN = /^pst_[0-9a-z]{26}$/;

export const SpacePostIdSchema = Schema.String.check(
  Schema.isPattern(SPACE_POST_ID_PATTERN),
);
export type SpacePostId = typeof SpacePostIdSchema.Type;

/** The reactions a post takes, from people and from the agent. */
export const SPACE_POST_REACTIONS = [
  "thumbs_up",
  "heart",
  "joy",
  "eyes",
  "wave",
] as const;
export const SpacePostReactionSchema = Schema.Literals(SPACE_POST_REACTIONS);
export type SpacePostReaction = typeof SpacePostReactionSchema.Type;

export const SpacePostTextSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(SPACE_POST_MAX_LENGTH),
);

/**
 * Who wrote a post: a person (`userId` absent once their account is gone)
 * or the Space's agent (`name` "dx").
 */
export const SpacePostAuthorSchema = Schema.Struct({
  kind: Schema.Literals(["user", "agent"]),
  userId: Schema.optional(UserId),
  name: Schema.String.check(Schema.isMaxLength(256)),
  handle: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  avatarUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
});
export type SpacePostAuthor = typeof SpacePostAuthorSchema.Type;

/** One reaction on a post, counted over everyone who gave it. */
export const SpacePostReactionCountSchema = Schema.Struct({
  reaction: SpacePostReactionSchema,
  count: Schema.Int,
  /** The requester gave it. */
  mine: Schema.Boolean,
  /** The agent gave it (dx's `eyes` while it works on the post, or its own). */
  agent: Schema.Boolean,
});
export type SpacePostReactionCount = typeof SpacePostReactionCountSchema.Type;

/** A post's comments, for its "N replies" row. */
export const SpacePostCommentsSchema = Schema.Struct({
  count: Schema.Int,
  lastAt: Schema.optional(Timestamp),
  /** Who commented, most recent first, at most three. */
  commenters: Schema.Array(MessageCommentPersonSchema).check(
    Schema.isMaxLength(3),
  ),
});

export const SpacePostSchema = Schema.Struct({
  id: SpacePostIdSchema,
  author: SpacePostAuthorSchema,
  /** Markdown, as its author last wrote it. */
  text: Schema.String,
  createdAt: Timestamp,
  /** When it was last edited; absent when never. */
  editedAt: Schema.optional(Timestamp),
  /** How many times it was edited; its revisions number one more. */
  revisionCount: Schema.Int,
  /** In the order they were first given. */
  reactions: Schema.Array(SpacePostReactionCountSchema),
  comments: SpacePostCommentsSchema,
});
export type SpacePost = typeof SpacePostSchema.Type;

/** `GET /v1/spaces/:threadId/posts?before=&limit=`. */
export const ListSpacePostsQuerySchema = Schema.Struct({
  /** Only posts older than this post. */
  before: Schema.optional(SpacePostIdSchema),
  limit: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[0-9]{1,3}$/)).pipe(
      Schema.decodeTo(Schema.FiniteFromString),
      Schema.decodeTo(
        Schema.Int.check(
          Schema.isBetween({ minimum: 1, maximum: SPACE_POSTS_MAX_LIMIT }),
        ),
      ),
    ),
  ),
});

/**
 * The newest `limit` posts (older than `before`), oldest first, so the last
 * item is the newest. `nextBefore` pages to older posts; absent at the
 * first post.
 */
export const ListSpacePostsResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(SpacePostSchema),
    nextBefore: Schema.optional(SpacePostIdSchema),
  }),
);
export type ListSpacePostsResponse =
  typeof ListSpacePostsResponseSchema.Encoded;

/** One version of a post. */
export const SpacePostRevisionSchema = Schema.Struct({
  /** 1 is the text as first posted; the highest is the current text. */
  revision: Schema.Int,
  text: Schema.String,
  createdAt: Timestamp,
});
export type SpacePostRevision = typeof SpacePostRevisionSchema.Type;

/** `GET /v1/spaces/:threadId/posts/:postId/revisions`: oldest first. */
export const SpacePostRevisionsResponseSchema = successResponse(
  Schema.Struct({ items: Schema.Array(SpacePostRevisionSchema) }),
);
export type SpacePostRevisionsResponse =
  typeof SpacePostRevisionsResponseSchema.Encoded;

/**
 * `POST /v1/spaces/:threadId/posts` (a person posts; it reaches the agent)
 * and `PATCH /v1/spaces/:threadId/posts/:postId` (its author edits it; the
 * edit reaches the agent).
 */
export const SpacePostTextRequestSchema = Schema.Struct({
  text: SpacePostTextSchema,
});
export type SpacePostTextRequest = typeof SpacePostTextRequestSchema.Type;

/**
 * `POST /v1/spaces/:threadId/posts` (201), `PATCH …/posts/:postId`, and
 * `PUT|DELETE …/posts/:postId/reactions/:reaction`: the post as it now is.
 */
export const SpacePostResponseSchema = successResponse(
  Schema.Struct({ post: SpacePostSchema }),
);
export type SpacePostResponse = typeof SpacePostResponseSchema.Encoded;

/** The tag that names a person's post for the agent. */
export const spacePostTag = (postId: string) => `<post id="${postId}" />`;

/** A person's post as the agent receives it: its text, then its tag. */
export const spacePostForAgent = (postId: string, text: string) =>
  `${text}\n\n${spacePostTag(postId)}`;

/** An edited post as the agent receives it: the new text, then the old. */
export const spacePostEditForAgent = (
  postId: string,
  text: string,
  previous: string,
) =>
  `${text}\n\n<edited_post id="${postId}">\n${previous.replaceAll("</edited_post>", "<\\/edited_post>")}\n</edited_post>`;

/** The `<post id="…" />` tags in a message the agent received. */
export const spacePostIdsIn = (body: string): ReadonlyArray<string> =>
  [...body.matchAll(/<post id="(pst_[0-9a-z]{26})" \/>/g)].flatMap(([, id]) =>
    id === undefined ? [] : [id],
  );

/** How a child's result reaches the Space's agent. */
export const WORKER_REPORT_PREFIX = "Worker report from ";

/** A child's result as the Space's agent receives it. */
export const spaceWorkerReport = (input: {
  readonly title: string;
  readonly url: string;
  readonly text: string;
}) =>
  `${WORKER_REPORT_PREFIX}${input.title.replaceAll("\n", " ")} (${input.url})\n\n${input.text}`;

/**
 * Where a comment's notification opens: the commented post, with the
 * comment in view in its Comments panel (`?message=`). The post's ID and
 * the comment's hex, `pst_….<32 hex>`, so it fits a notification's 64
 * characters. Undefined for a comment on anything but a post.
 */
export const commentLinkId = (postId: string, commentId: string) => {
  const hex = /^mcm_([0-9a-f]{32})$/.exec(commentId)?.[1];
  return SPACE_POST_ID_PATTERN.test(postId) && hex !== undefined
    ? `${postId}.${hex}`
    : undefined;
};

/** A comment's link: `pst_<26>.<32 hex>`. */
export const COMMENT_LINK_ID_PATTERN = /^(pst_[0-9a-z]{26})\.([0-9a-f]{32})$/;

/** The post and comment a comment's link (`commentLinkId`) names. */
export const parseCommentLinkId = (value: string) => {
  const match = COMMENT_LINK_ID_PATTERN.exec(value);
  return match === null || match[1] === undefined || match[2] === undefined
    ? undefined
    : { postId: match[1], commentId: `mcm_${match[2]}` };
};
