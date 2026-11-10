import type { SpaceData } from "@dx/api";
import { parseCommentLinkId, SPACE_POST_ID_PATTERN } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import type { DictationSlot } from "../../shared/dictation/dictation-slot.js";
import { useMountEffect } from "../../shared/hooks/use-mount-effect.js";
import { Button } from "../../shared/ui/button.js";
import { SpaceCatchUpCard } from "./cards/catch-up-card.js";
import type { CommentableMessage } from "./comments/message-comments.js";
import { SpaceComposer, UnarchiveToContinue } from "./posts/space-composer.js";
import { postTime, stillSending } from "./posts/space-post-format.js";
import { SpacePostList } from "./posts/space-post-list.js";
import {
  flattenSpacePosts,
  type SpacePost,
  spacePostsQueryOptions,
  usePendingSpacePosts,
} from "./posts/space-posts-queries.js";

/** What the comments panel shows of a post before its comments load. */
const commentable = (
  space: SpaceData,
  post: SpacePost,
): CommentableMessage => ({
  threadId: space.threadId,
  messageId: post.id,
  text: post.text,
  ...(post.author.kind === "user" && post.author.userId !== undefined
    ? { author: { userId: post.author.userId, name: post.author.name } }
    : {}),
  sentAt: new Date(postTime(post.createdAt)).toISOString(),
});

/** Reads the next older page once, as the linked post is not loaded yet. */
function LoadOlderPosts({ load }: { readonly load: () => void }) {
  useMountEffect(load);
  return null;
}

/**
 * Turns a comment's link into its post's open Comments panel, with the
 * comment to bring into view, once.
 */
function OpenCommentLink({
  spaceThreadId,
  postId,
  commentId,
}: {
  readonly spaceThreadId: ThreadId;
  readonly postId: string;
  readonly commentId: string;
}) {
  const navigate = useNavigate();
  useMountEffect(() => {
    void navigate({
      to: "/threads/$threadId",
      params: { threadId: spaceThreadId },
      search: ({ message: _message, ...rest }: Record<string, unknown>) => ({
        ...rest,
        comments: postId,
        comment: commentId,
      }),
      replace: true,
    });
  });
  return null;
}

/** Opens comments over the chat; the Space route supplies who is typing. */
export type RenderSpaceComments = (input: {
  readonly findMessage: (messageId: string) => CommentableMessage | undefined;
}) => React.ReactNode;

/**
 * The Space chat tab: the posts people and dx made, newest at the bottom,
 * the catch-up card, and the composer, or Unarchive to Continue while the
 * Space is archived. The posts' comments open over it.
 */
export function SpaceChat({
  space,
  dictation,
  renderComments,
  onUnarchive,
  unarchiving,
}: {
  readonly space: SpaceData;
  readonly dictation?: DictationSlot;
  readonly renderComments?: RenderSpaceComments;
  readonly onUnarchive?: () => void;
  readonly unarchiving: boolean;
}) {
  const { identity } = useAuthenticatedIdentity();
  const posts = useInfiniteQuery(
    spacePostsQueryOptions(identity.id, space.threadId),
  );
  const sending = usePendingSpacePosts(identity.id, space.threadId);
  const archived = space.lifecycleState === "archived";
  const items = flattenSpacePosts(posts.data);
  const pending = stillSending(sending, items, identity.id);
  // `?message=pst_…`, a mention's link: the chat opens at that post, loading
  // older pages until it arrives, and flashes it once.
  const linked = useSearch({
    strict: false,
    select: (search) => (search as { readonly message?: unknown }).message,
  });
  const [shownLink, setShownLink] = React.useState<string>();
  const focusPostId =
    typeof linked === "string" &&
    SPACE_POST_ID_PATTERN.test(linked) &&
    linked !== shownLink
      ? linked
      : undefined;
  const linkLoaded =
    focusPostId === undefined || items.some(({ id }) => id === focusPostId);
  // A comment's link (`pst_….<hex>`): that post's Comments panel, open at
  // the comment.
  const commentLink =
    typeof linked === "string" ? parseCommentLinkId(linked) : undefined;
  const findMessage = (messageId: string) => {
    const post = items.find(({ id }) => id === messageId);
    return post === undefined ? undefined : commentable(space, post);
  };
  return (
    <div className="space-chat" data-archived={archived ? "" : undefined}>
      {/* Reversed, so the chat opens at its newest post and stays there as
          posts arrive. */}
      <div className="space-chat-scroll">
        <div className="space-chat-content" aria-busy={posts.isPending}>
          {commentLink === undefined ? null : (
            <OpenCommentLink
              key={`${commentLink.postId}:${commentLink.commentId}`}
              spaceThreadId={space.threadId}
              postId={commentLink.postId}
              commentId={commentLink.commentId}
            />
          )}
          {!linkLoaded && posts.hasNextPage && !posts.isFetchingNextPage ? (
            <LoadOlderPosts
              key={posts.data?.pages.length ?? 0}
              load={() => void posts.fetchNextPage()}
            />
          ) : null}
          {posts.hasNextPage ? (
            <div className="space-chat-earlier">
              <Button
                variant="ghost"
                size="xs"
                disabled={posts.isFetchingNextPage}
                onClick={() => void posts.fetchNextPage()}
              >
                Earlier Posts
              </Button>
            </div>
          ) : null}
          {posts.isError && posts.data === undefined ? (
            <div className="space-chat-error" role="alert">
              <span>Could not load this Space's posts.</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void posts.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : null}
          <SpacePostList
            spaceThreadId={space.threadId}
            posts={items}
            permissions={{ react: !archived, comment: true }}
            focusPostId={linkLoaded ? focusPostId : undefined}
            onFocused={() => setShownLink(focusPostId)}
          />
          {pending.map(({ key, text }) => (
            <article
              key={key}
              className="space-post user-message"
              data-kind="mine"
              data-pending=""
              aria-busy="true"
              aria-label="Posting"
            >
              <div className="space-post-body">
                <div className="message-content">
                  <p className="user-message-text">{text}</p>
                </div>
              </div>
            </article>
          ))}
          {archived ? null : (
            <SpaceCatchUpCard spaceThreadId={space.threadId} />
          )}
        </div>
      </div>
      {archived ? (
        <UnarchiveToContinue pending={unarchiving} onUnarchive={onUnarchive} />
      ) : (
        <SpaceComposer spaceThreadId={space.threadId} dictation={dictation} />
      )}
      {renderComments?.({ findMessage })}
    </div>
  );
}
