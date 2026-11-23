import type { SpaceData } from "@dx/api";
import { parseMessageAttachments, SPACE_POST_ID_PATTERN } from "@dx/api";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { Link2, MessagesSquare, Reply } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import type { ComposerSlot } from "../../shared/composer/composer-slot.js";
import { copyText } from "../../shared/copy-text.js";
import { Button } from "../../shared/ui/button.js";
import {
  quoteSelection,
  type SelectionMenuAction,
  type SelectionSurface,
  selectionCopyActions,
} from "../../shared/ui/selection-actions.js";
import { SelectionMenu } from "../../shared/ui/selection-menu.js";
import { UnarchiveToContinue } from "../../shared/ui/unarchive-to-continue.js";
import { SpaceCatchUpCard } from "./cards/catch-up-card.js";
import {
  type CommentableMessage,
  useQuoteInComment,
} from "./comments/message-comments.js";
import { SpaceComposer } from "./posts/space-composer.js";
import { SpacePostImages, SpacePostLinks } from "./posts/space-post-files.js";
import {
  postContent,
  postTime,
  stillSending,
} from "./posts/space-post-format.js";
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
  text: postContent(post).text,
  ...(post.author.kind === "user" && post.author.userId !== undefined
    ? { author: { userId: post.author.userId, name: post.author.name } }
    : {}),
  sentAt: new Date(postTime(post.createdAt)).toISOString(),
});

/** The Space's posts; a post still sending has no ID yet. */
const POSTS: SelectionSurface = {
  region: ".space-chat-scroll",
  message: "article.space-post[data-post-id]",
  content: ".message-content",
  // dx writes Markdown; people write plain text.
  markdown: (post) => post.dataset.kind === "agent",
};

/**
 * The toolbar at text selected in a post, as in a Thread: Reply quotes it
 * into the Space's composer, Comment into the post's comments, with Copy as
 * Markdown, Copy with Styling, and Copy Highlighted Link.
 */
function PostSelectionMenu({
  spaceThreadId,
  onReply,
}: {
  readonly spaceThreadId: SpaceData["threadId"];
  /** Absent while the Space is archived. */
  readonly onReply?: (quote: string) => void;
}) {
  const quoteInComment = useQuoteInComment(spaceThreadId);
  return (
    <SelectionMenu
      surface={POSTS}
      actions={(selection): ReadonlyArray<SelectionMenuAction> => {
        const postId = selection.message.dataset.postId ?? "";
        const quote = () => {
          window.getSelection()?.removeAllRanges();
          return quoteSelection(selection.text);
        };
        // A post's link opens the chat at it, as a mention's does.
        const link = new URL(
          `/threads/${spaceThreadId}?message=${encodeURIComponent(postId)}`,
          window.location.href,
        ).href;
        return [
          ...(onReply === undefined
            ? []
            : [
                {
                  key: "r",
                  label: "Reply",
                  Icon: Reply,
                  run: () => onReply(quote()),
                },
              ]),
          {
            key: "m",
            label: "Comment",
            Icon: MessagesSquare,
            run: () => void quoteInComment(postId, quote()),
          },
          ...selectionCopyActions(selection),
          {
            key: "l",
            label: "Copy Highlighted Link",
            Icon: Link2,
            run: () => void copyText(link, "Link"),
          },
        ];
      }}
    />
  );
}

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
  Composer,
  renderComments,
  onUnarchive,
  unarchiving,
}: {
  readonly space: SpaceData;
  /** The Thread composer's box, from the Thread route. */
  readonly Composer: ComposerSlot;
  readonly renderComments?: RenderSpaceComments;
  readonly onUnarchive?: () => void;
  readonly unarchiving: boolean;
}) {
  const { identity } = useAuthenticatedIdentity();
  // The composer's Reply, which a selection in a post quotes into.
  const composerReply = React.useRef<(quote: string) => void>(undefined);
  const posts = useInfiniteQuery(
    spacePostsQueryOptions(identity.id, space.threadId),
  );
  const sending = usePendingSpacePosts(identity.id, space.threadId);
  const archived = space.lifecycleState === "archived";
  const items = flattenSpacePosts(posts.data);
  const pending = stillSending(sending, items, identity.id);
  // `?message=pst_…`, a mention's link: the chat opens at that post and
  // flashes it once. The Thread route loads older pages until it arrives,
  // and turns a comment's link (`pst_….<hex>`) into its Comments panel.
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
          {pending.map(({ key, text, posted }) => {
            const files = parseMessageAttachments(posted).attachments;
            return (
              <article
                key={key}
                className="space-post user-message"
                data-kind="mine"
                data-pending=""
                aria-busy="true"
                aria-label="Posting"
              >
                <div className="space-post-body">
                  <SpacePostImages attachments={files} />
                  <div className="message-content">
                    {text === "" ? null : (
                      <p className="user-message-text">{text}</p>
                    )}
                    <SpacePostLinks attachments={files} />
                  </div>
                </div>
              </article>
            );
          })}
          {archived ? null : (
            <SpaceCatchUpCard spaceThreadId={space.threadId} />
          )}
        </div>
      </div>
      {archived ? (
        <div className="agent-composer-dock space-composer-dock">
          <UnarchiveToContinue
            pending={unarchiving}
            onUnarchive={onUnarchive}
          />
        </div>
      ) : (
        <SpaceComposer
          spaceThreadId={space.threadId}
          Composer={Composer}
          replyRef={composerReply}
        />
      )}
      <PostSelectionMenu
        spaceThreadId={space.threadId}
        {...(archived
          ? {}
          : { onReply: (quote) => composerReply.current?.(quote) })}
      />
      {renderComments?.({ findMessage })}
    </div>
  );
}
