import {
  COMMENTED_MESSAGE_ID_PATTERN,
  type CommentedMessage,
  type MessageComment,
  type MessageCommentPerson,
  type MessageCommentSummary,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowUp,
  ChevronDown,
  ChevronUp,
  MessagesSquare,
  X,
} from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { useCommentMentions } from "../../../shared/comments/comment-mention-menu.js";
import { asksAgent } from "../../../shared/comments/comment-mentions.js";
import {
  type CommentPeople,
  CommentText,
} from "../../../shared/comments/comment-text.js";
import type { DictationSlot } from "../../../shared/dictation/dictation-slot.js";
import { Avatar } from "../../../shared/ui/avatar.js";
import { Button } from "../../../shared/ui/button.js";
import { RichMarkdown } from "../../../shared/ui/rich-markdown.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import { ThreadReferenceContext } from "../../../shared/ui/thread-reference-context.js";
import { TimeText } from "../../../shared/ui/time-text.js";
import { formatRelativeTime } from "../../../shared/utils.js";
import { threadMembersQueryOptions } from "../../threads/sharing/thread-chat-queries.js";
import { spaceThreadReferences } from "../cards/space-thread-references.js";
import { showLinked } from "../posts/focus-post.js";
import {
  messageCommentSummariesQueryOptions,
  messageCommentsQueryOptions,
  useAddMessageComment,
} from "./message-comments-queries.js";
import "./message-comments.css";

/**
 * Comments on a Space's messages: people discuss any message beside the
 * main chat. The agent never reads a comment unless it mentions @dx, and
 * then it answers in the main chat. The open message is
 * the URL's `comments` search parameter, so the panel survives a reload and
 * the Space's Comments list opens it.
 */

/** A message of the transcript people can comment on. */
export interface CommentableMessage {
  readonly threadId: ThreadId;
  /** The post's ID. */
  readonly messageId: string;
  readonly text: string;
  /** Who wrote it; absent for the agent. */
  readonly author?: { readonly userId: string; readonly name: string };
  readonly sentAt?: string;
}

/** Someone typing a comment on one of the Thread's messages (`scope`). */
export interface CommentTyping {
  readonly userId: string;
  readonly scope: string;
}

/** Whether the id is one comments can be kept under: a post's. */
const isCommentableId = (messageId: string) =>
  COMMENTED_MESSAGE_ID_PATTERN.test(messageId);

const relative = (at: number) => (now: number) =>
  formatRelativeTime({ epochMilliseconds: at }, now);

/** Opens a post's comments over the Space's chat, or closes them. */
export const useOpenMessageComments = (threadId: ThreadId) => {
  const navigate = useNavigate();
  return (messageId: string | undefined) =>
    void navigate({
      to: "/threads/$threadId",
      params: { threadId },
      search: (previous: Record<string, unknown>) => {
        // The comment a link brought into view belongs to the panel it opened.
        const { comments: _comments, comment: _comment, ...rest } = previous;
        return messageId === undefined
          ? rest
          : { ...rest, comments: messageId };
      },
      replace: true,
    });
};

const useSummaries = (threadId: ThreadId) => {
  const { identity } = useAuthenticatedIdentity();
  return useQuery(messageCommentSummariesQueryOptions(identity.id, threadId));
};

function PersonAvatar({
  person,
}: {
  readonly person: MessageCommentPerson | null;
}) {
  return person === null ? (
    <Avatar name="Former member" seed="former" />
  ) : (
    <Avatar
      name={person.name}
      seed={person.userId}
      {...(person.avatarUrl === undefined ? {} : { image: person.avatarUrl })}
    />
  );
}

/** The commented message at the top of the panel. */
function QuotedMessage({
  message,
  viewerId,
  people,
}: {
  readonly message: CommentedMessage;
  readonly viewerId: string;
  readonly people: CommentPeople;
}) {
  if (message.author?.userId === viewerId)
    return (
      <div className="message-comments-quote user-message">
        <div className="message-content">
          <CommentText text={message.excerpt} people={people} />
        </div>
      </div>
    );
  return (
    <div className="message-comments-quote message-comment">
      <div className="message-comment-author">
        {message.author === null ? (
          <strong>dx</strong>
        ) : (
          <>
            <PersonAvatar person={message.author} />
            <strong>{message.author.name}</strong>
          </>
        )}
        {message.sentAt === null ? null : (
          <time dateTime={new Date(message.sentAt).toISOString()}>
            <TimeText text={relative(message.sentAt)} />
          </time>
        )}
      </div>
      {message.author === null ? (
        // dx's post as the chat shows it: Markdown, its threads as cards
        // and chips.
        <div className="message-comment-text message-comments-quote-markdown">
          <ThreadReferenceContext.Provider value={spaceThreadReferences}>
            <RichMarkdown>{message.excerpt}</RichMarkdown>
          </ThreadReferenceContext.Provider>
        </div>
      ) : (
        <p className="message-comment-text">
          <CommentText text={message.excerpt} people={people} />
        </p>
      )}
    </div>
  );
}

/** Brings a linked comment into view in the panel and flashes it. */
const showLinkedComment = (node: HTMLElement | null) =>
  node === null ? undefined : showLinked(node, ".message-comments-body");

function CommentItem({
  comment,
  viewerId,
  people,
  linked = false,
}: {
  readonly comment: MessageComment;
  readonly viewerId: string;
  readonly people: CommentPeople;
  /** A mention's link opened the panel at this comment. */
  readonly linked?: boolean;
}) {
  const ref = linked ? showLinkedComment : undefined;
  if (comment.author?.userId === viewerId)
    return (
      <article
        ref={ref}
        className="message-comment user-message"
        data-mine=""
        aria-label="Your comment"
      >
        <div className="message-content">
          <CommentText text={comment.body} people={people} />
        </div>
      </article>
    );
  return (
    <article
      ref={ref}
      className="message-comment"
      aria-label={`Comment from ${comment.author?.name ?? "a former member"}`}
    >
      <div className="message-comment-author">
        <PersonAvatar person={comment.author} />
        <strong>{comment.author?.name ?? "Former member"}</strong>
        <time dateTime={new Date(comment.createdAt).toISOString()}>
          <TimeText text={relative(comment.createdAt)} />
        </time>
      </div>
      <p className="message-comment-text">
        <CommentText text={comment.body} people={people} />
      </p>
    </article>
  );
}

/** The message as the server records it with a first comment. */
const asCommented = (
  message: CommentableMessage | undefined,
): CommentedMessage | undefined =>
  message === undefined
    ? undefined
    : {
        messageId: message.messageId,
        excerpt: message.text,
        author:
          message.author === undefined
            ? null
            : {
                userId: message.author.userId as UserId,
                name: message.author.name,
              },
        sentAt:
          message.sentAt === undefined ? null : Date.parse(message.sentAt),
      };

/** The commented messages before and after this one, in chat order. */
const neighbours = (
  items: ReadonlyArray<MessageCommentSummary>,
  messageId: string,
  sentAt: number | null,
) => {
  const index = items.findIndex((item) => item.message.messageId === messageId);
  if (index >= 0) return { previous: items[index - 1], next: items[index + 1] };
  if (sentAt === null) return { previous: undefined, next: undefined };
  return {
    previous: items.findLast(
      (item) => (item.message.sentAt ?? Number.NEGATIVE_INFINITY) < sentAt,
    ),
    next: items.find(
      (item) => (item.message.sentAt ?? Number.POSITIVE_INFINITY) > sentAt,
    ),
  };
};

/** How often typing is announced while it goes on. */
const TYPING_EVERY_MS = 2_000;

function CommentComposer({
  threadId,
  messageId,
  message,
  people,
  dictation,
  onTyping,
}: {
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly message: CommentedMessage | undefined;
  readonly people: ReturnType<typeof useMembers>;
  readonly dictation: DictationSlot | undefined;
  readonly onTyping: (scope: string) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const [body, setBody] = React.useState("");
  const [error, setError] = React.useState<string>();
  const box = React.useRef<HTMLTextAreaElement | null>(null);
  const announced = React.useRef(0);
  const add = useAddMessageComment(identity.id, threadId);
  const mentions = useCommentMentions({
    members: people.members,
    body,
    setBody,
    box,
  });
  // Judged as the comment will post: a picked person named "dx …" is that
  // person, not dx.
  const asking = asksAgent(mentions.post(body));
  const change = (value: string) => {
    setBody(value);
    const now = Date.now();
    if (value.trim() !== "" && now - announced.current > TYPING_EVERY_MS) {
      announced.current = now;
      onTyping(messageId);
    }
  };
  const submit = () => {
    const value = body.trim();
    if (value === "" || add.isPending) return;
    const posted = mentions.post(value);
    setBody("");
    setError(undefined);
    mentions.reset();
    announced.current = 0;
    add.mutate(
      {
        messageId,
        request: {
          body: posted,
          message: {
            excerpt: (message?.excerpt ?? "").slice(0, 32_000),
            ...(message?.author == null
              ? {}
              : { authorUserId: message.author.userId }),
            ...(message?.sentAt == null ? {} : { sentAt: message.sentAt }),
          },
        },
      },
      {
        onError: () => {
          setBody(value);
          setError("Couldn't post the comment. Try again.");
        },
      },
    );
  };
  return (
    <form
      className="message-comments-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {/* The `@` list opens above the banner, so both stay readable. */}
      {mentions.menu}
      {asking ? (
        <p className="message-comments-agent" role="status">
          <span aria-hidden="true" />
          dx Answers in the Main Chat
        </p>
      ) : null}
      <div className="message-comments-box">
        <Textarea
          variant="bare"
          ref={box}
          aria-label="Comment"
          placeholder="Comment"
          rows={2}
          value={body}
          onChange={(event) => {
            change(event.target.value);
            mentions.track(
              event.target.value,
              event.target.selectionStart ?? event.target.value.length,
            );
          }}
          onKeyDown={(event) => {
            if (mentions.onKeyDown(event)) return;
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="message-comments-box-actions">
          {dictation === undefined ? null : (
            <dictation.Textarea textareaRef={box} onChange={change} />
          )}
          <Button
            variant="default"
            size="icon-sm"
            type="submit"
            className="message-comments-send"
            aria-label="Send Comment"
            title="Send Comment"
            disabled={add.isPending || body.trim() === ""}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
        </div>
      </div>
      {error === undefined ? null : (
        <p className="message-comments-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

const useMembers = (threadId: ThreadId) => {
  const { identity } = useAuthenticatedIdentity();
  const members =
    useQuery(threadMembersQueryOptions(identity.id, threadId)).data ?? [];
  const people: CommentPeople = new Map<
    string,
    { readonly name: string; readonly image?: string }
  >([
    [identity.id, { name: identity.name }],
    ...members.map(
      (member) =>
        [member.userId, { name: member.name, image: member.image }] as const,
    ),
  ]);
  return { members, people };
};

/**
 * The open message's comments, over the conversation column: the message
 * quoted at the top, its comments (yours on the right), who is typing, and
 * a box to comment, with ↑ and ↓ stepping between commented messages.
 */
export function MessageCommentsPanel({
  threadId,
  findMessage,
  typing,
  onTyping,
  dictation,
}: {
  readonly threadId: ThreadId;
  /** A post the chat has loaded, by its ID. */
  readonly findMessage: (messageId: string) => CommentableMessage | undefined;
  /** Who else is typing a comment in this Thread now. */
  readonly typing: ReadonlyArray<CommentTyping>;
  /** Tells the others the viewer is typing on this message. */
  readonly onTyping: (scope: string) => void;
  readonly dictation?: DictationSlot | undefined;
}) {
  const messageId = useSearch({
    from: "/_product/threads/$threadId",
    select: (search) => search.comments,
  });
  // An old link may name a local id; there are no comments to show for it.
  if (messageId === undefined || !isCommentableId(messageId)) return null;
  return (
    <OpenComments
      key={messageId}
      threadId={threadId}
      messageId={messageId}
      findMessage={findMessage}
      typing={typing}
      onTyping={onTyping}
      dictation={dictation}
    />
  );
}

function OpenComments({
  threadId,
  messageId,
  findMessage,
  typing,
  onTyping,
  dictation,
}: {
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly findMessage: (messageId: string) => CommentableMessage | undefined;
  readonly typing: ReadonlyArray<CommentTyping>;
  readonly onTyping: (scope: string) => void;
  readonly dictation: DictationSlot | undefined;
}) {
  const { identity } = useAuthenticatedIdentity();
  const open = useOpenMessageComments(threadId);
  // `?comment=`: a mention's link opened the panel at this comment.
  const linkedCommentId = useSearch({
    from: "/_product/threads/$threadId",
    select: (search) => search.comment,
  });
  const comments = useQuery(
    messageCommentsQueryOptions(identity.id, threadId, messageId),
  );
  const summaries = useSummaries(threadId).data ?? [];
  const members = useMembers(threadId);
  const message =
    comments.data?.message ?? asCommented(findMessage(messageId)) ?? undefined;
  const { previous, next } = neighbours(
    summaries,
    messageId,
    message?.sentAt ?? null,
  );
  const typists = [
    ...new Set(
      typing.flatMap(({ scope, userId }) =>
        scope === messageId && userId !== identity.id ? [userId] : [],
      ),
    ),
  ];
  const list = comments.data?.comments ?? [];
  return (
    <section
      className="message-comments-panel"
      aria-label="Comments"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          open(undefined);
        }
      }}
    >
      <header className="message-comments-header">
        <MessagesSquare aria-hidden="true" />
        <h2>Comments</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous Comments"
          title="Previous Comments"
          disabled={previous === undefined}
          onClick={() => open(previous?.message.messageId)}
        >
          <ChevronUp aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next Comments"
          title="Next Comments"
          disabled={next === undefined}
          onClick={() => open(next?.message.messageId)}
        >
          <ChevronDown aria-hidden="true" />
        </Button>
        <span className="message-comments-divider" aria-hidden="true" />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close Comments"
          title="Close Comments"
          onClick={() => open(undefined)}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="message-comments-body">
        {message === undefined ? null : (
          <QuotedMessage
            message={message}
            viewerId={identity.id}
            people={members.people}
          />
        )}
        <div className="message-comments-list">
          {comments.isPending ? null : list.length === 0 &&
            typists.length === 0 ? (
            <p className="message-comments-empty">No comments yet.</p>
          ) : (
            list.map((comment) => (
              <CommentItem
                key={comment.id}
                comment={comment}
                viewerId={identity.id}
                people={members.people}
                linked={comment.id === linkedCommentId}
              />
            ))
          )}
          {typists.map((userId) => {
            const person = members.members.find(
              (member) => member.userId === userId,
            );
            const name = person?.name ?? "Someone";
            return (
              <div
                key={userId}
                className="message-comment message-comment-typing"
                role="status"
                aria-label={`${name} is typing`}
              >
                <div className="message-comment-author">
                  <Avatar
                    name={name}
                    seed={userId}
                    {...(person?.image === undefined
                      ? {}
                      : { image: person.image })}
                  />
                  <strong>{name}</strong>
                </div>
                <span className="message-comment-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <CommentComposer
        threadId={threadId}
        messageId={messageId}
        message={message}
        people={members}
        dictation={dictation}
        onTyping={onTyping}
      />
    </section>
  );
}
