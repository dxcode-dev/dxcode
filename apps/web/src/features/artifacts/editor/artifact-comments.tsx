import type { ThreadArtifactComment } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, AtSign, Check, MessageSquare } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { DxWordmark } from "../../../shared/brand/dx-wordmark.js";
import { useCommentMentions } from "../../../shared/comments/comment-mention-menu.js";
import {
  asksAgent,
  toggleAgent,
} from "../../../shared/comments/comment-mentions.js";
import {
  type CommentPeople,
  CommentText,
} from "../../../shared/comments/comment-text.js";
import type { DictationSlot } from "../../../shared/dictation/dictation-slot.js";
import { Avatar } from "../../../shared/ui/avatar.js";
import { Button } from "../../../shared/ui/button.js";
import { buttonVariants } from "../../../shared/ui/button-variants.js";
import {
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../../shared/ui/menu.js";
import { PopoverContent, PopoverRoot } from "../../../shared/ui/popover.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import { TimeText } from "../../../shared/ui/time-text.js";
import { cn, formatRelativeTime } from "../../../shared/utils.js";
import { threadMembersQueryOptions } from "../../threads/sharing/thread-chat-queries.js";
import {
  createArtifactCommentMutation,
  resolveArtifactCommentMutation,
} from "../artifact-comments-queries.js";
import { ArtifactApiError } from "../artifacts-api.js";
import { useArtifactHost } from "./artifact-host.js";

/**
 * A comment being written: on a quote in the current revision, or on a part
 * of an artifact by id (a board's shape), with what that part is called.
 */
export type CommentDraft =
  | { readonly quote: string; readonly near: number }
  | { readonly target: string; readonly label: string };

const authorName = (author: ThreadArtifactComment["author"]) =>
  author.kind === "agent" ? "dx" : (author.name ?? "Someone");

const failure = (error: unknown) =>
  error instanceof ArtifactApiError && error.code === "ARTIFACT_QUOTE_NOT_FOUND"
    ? "That text changed before the comment was saved. Select it again."
    : error instanceof ArtifactApiError &&
        error.code === "ARTIFACT_COMMENT_LIMIT"
      ? "This artifact has as many comments as it can hold."
      : "Couldn't save the comment. Try again.";

const shorten = (text: string, length = 140) =>
  text.length > length ? `${text.slice(0, length)}…` : text;

/** A new comment's box takes focus as it opens. */
const focusOnOpen = (node: HTMLTextAreaElement | null) => node?.focus();

/**
 * Writes a comment or a reply, as the reference editor's card does: one box,
 * then `@` (mention someone), the mic, and a round send button. Enter posts;
 * Shift+Enter starts a new line.
 */
function CommentComposer({
  label,
  placeholder,
  pending,
  error,
  onSubmit,
  text,
  focus = false,
  dictation,
  threadId,
}: {
  readonly threadId: ThreadId;
  readonly label: string;
  readonly placeholder: string;
  readonly pending: boolean;
  readonly error: string | undefined;
  /**
   * Posts `body`. The box empties at once, so what is typed next is kept
   * whenever the post lands; `failed` puts the text back if it did not.
   */
  readonly onSubmit: (body: string, failed: () => void) => void;
  /** The text, when it must outlive the box (a new comment's draft). */
  readonly text?: {
    readonly value: string;
    readonly set: (value: string) => void;
  };
  readonly focus?: boolean;
  /** The composer's mic, when dictation is available and the person may edit. */
  readonly dictation?: DictationSlot | undefined;
}) {
  const [own, setOwn] = React.useState("");
  const body = text?.value ?? own;
  const setBody = text?.set ?? setOwn;
  const box = React.useRef<HTMLTextAreaElement | null>(null);
  // The mic's words show on their own line under the buttons.
  const [noticeHost, setNoticeHost] = React.useState<HTMLElement | null>(null);
  // `@` lists the Thread's people, dx, and @here (#1808).
  const { identity } = useAuthenticatedIdentity();
  const members =
    useQuery(threadMembersQueryOptions(identity.id, threadId)).data ?? [];
  // A standalone artifact's home has no agent: no dx to ask or mention.
  const { agent } = useArtifactHost();
  const mentions = useCommentMentions({ members, body, setBody, box, agent });
  // The box shows `@dx` as people read it; it posts as the mention. Judged
  // as it will post: a picked person named "dx …" is that person, not dx.
  const asking = agent && asksAgent(mentions.post(body));
  const submit = () => {
    const value = body.trim();
    if (value === "" || pending) return;
    const posted = mentions.post(value);
    setBody("");
    mentions.reset();
    onSubmit(posted, () => setBody(value));
  };
  /** The `@` button: starts a mention at the caret, as typing `@` does. */
  const mention = () => {
    const node = box.current;
    const caret = node?.selectionStart ?? body.length;
    const before = body.slice(0, caret);
    const lead = before === "" || /\s$/u.test(before) ? "@" : " @";
    const next = before + lead + body.slice(caret);
    setBody(next);
    mentions.track(next, caret + lead.length);
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(caret + lead.length, caret + lead.length);
    });
  };
  return (
    <form
      className="artifact-comment-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {mentions.menu}
      <Textarea
        variant="bare"
        ref={(node) => {
          box.current = node;
          if (focus) focusOnOpen(node);
        }}
        aria-label={label}
        placeholder={placeholder}
        value={body}
        maxLength={8_000}
        rows={1}
        onChange={(event) => {
          setBody(event.currentTarget.value);
          mentions.track(
            event.currentTarget.value,
            event.currentTarget.selectionStart,
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
      {asking ? (
        <p className="artifact-comment-asking">
          <DxWordmark size="small" /> will reply
        </p>
      ) : null}
      <div className="artifact-comment-actions">
        <Button
          variant="subtle"
          size="icon-xs"
          className="artifact-comment-icon"
          aria-label="Mention someone"
          title="Mention someone"
          onMouseDown={(event) => event.preventDefault()}
          onClick={mention}
        >
          <AtSign aria-hidden="true" />
        </Button>
        {agent ? (
          <Button
            variant="subtle"
            size="icon-xs"
            className="artifact-comment-icon artifact-comment-ask"
            aria-label="Ask @dx"
            title={asking ? "Don't ask dx" : "Ask dx to reply"}
            aria-pressed={asking}
            onClick={() => setBody(toggleAgent(body))}
          >
            <DxWordmark size="small" />
          </Button>
        ) : null}
        {dictation === undefined ? null : (
          <dictation.Textarea
            textareaRef={box}
            onChange={setBody}
            noticeHost={noticeHost}
          />
        )}
        <Button
          variant="default"
          size="icon-xs"
          type="submit"
          className="artifact-comment-submit"
          aria-label={label}
          title={label}
          disabled={pending || body.trim() === ""}
        >
          <ArrowUp aria-hidden="true" />
        </Button>
      </div>
      {error === undefined ? null : (
        <p className="artifact-comment-error" role="alert">
          {error}
        </p>
      )}
      {dictation === undefined ? null : (
        <div className="artifact-comment-dictation" ref={setNoticeHost} />
      )}
    </form>
  );
}

/** dx's mark for the agent; a person's picture, or their initials. */
function CommentAvatar({
  author,
  people,
}: {
  readonly author: ThreadArtifactComment["author"];
  readonly people: CommentPeople;
}) {
  if (author.kind === "agent")
    return (
      <span className="artifact-comment-avatar" aria-hidden="true">
        <DxWordmark size="small" />
      </span>
    );
  const person = author.userId === null ? undefined : people.get(author.userId);
  const name = author.name ?? person?.name ?? "Someone";
  return (
    <span className="artifact-comment-avatar" aria-hidden="true">
      <Avatar
        name={name}
        seed={author.userId ?? name}
        {...(person?.image === undefined ? {} : { image: person.image })}
      />
    </span>
  );
}

/** A comment and its replies: picture, name, when, and what they said. */
function CommentEntries({
  entries,
  people,
  onResolve,
  resolving,
}: {
  readonly entries: ReadonlyArray<ThreadArtifactComment>;
  readonly people: CommentPeople;
  /** Resolves the comment; absent for a reader who cannot edit. */
  readonly onResolve: (() => void) | undefined;
  readonly resolving: boolean;
}) {
  return (
    <ol className="artifact-comment-entries">
      {entries.map((entry, index) => (
        <li key={entry.id} className="artifact-comment">
          <div className="artifact-comment-meta">
            <CommentAvatar author={entry.author} people={people} />
            <strong>{authorName(entry.author)}</strong>
            <TimeText
              text={(now) =>
                formatRelativeTime({ epochMilliseconds: entry.createdAt }, now)
              }
            />
            {index === 0 && onResolve !== undefined ? (
              <Button
                variant="subtle"
                size="icon-xs"
                className="artifact-comment-resolve"
                aria-label="Resolve"
                title="Resolve"
                disabled={resolving}
                onClick={onResolve}
              >
                <Check aria-hidden="true" />
              </Button>
            ) : null}
          </div>
          <p className="artifact-comment-body">
            <CommentText text={entry.body} people={people} />
          </p>
        </li>
      ))}
    </ol>
  );
}

/** What the card is open on: a comment, or the selection being commented on. */
export type CommentCardTarget =
  | { readonly kind: "comment"; readonly id: string }
  | { readonly kind: "draft"; readonly draft: CommentDraft };

/**
 * A comment's card, at its text (owner direction, 2026-11-06, as the
 * reference editor has it on a wide pane and on a phone): the comment and
 * its replies with Resolve, and a box to reply; or, for the selection, a
 * box for the new comment. Escape or a click elsewhere closes it.
 */
export function CommentCard({
  target,
  anchor,
  comments,
  draftText,
  readOnly,
  people,
  dictation,
  threadId,
  artifactId,
  onPosted,
  onClose,
}: {
  readonly target: CommentCardTarget;
  /** The text the card sits against. */
  readonly anchor: () => Element | null;
  readonly comments: ReadonlyArray<ThreadArtifactComment>;
  /** A new comment's text, kept while the card closes and opens again. */
  readonly draftText: {
    readonly value: string;
    readonly set: (value: string) => void;
  };
  readonly readOnly: boolean;
  readonly people: CommentPeople;
  readonly dictation: DictationSlot | undefined;
  readonly threadId: ThreadId;
  readonly artifactId: string;
  /** A new comment saved: its card opens in place of the draft's. */
  readonly onPosted: (id: string) => void;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const create = useMutation(
    createArtifactCommentMutation(queryClient, threadId, artifactId),
  );
  const resolve = useMutation(
    resolveArtifactCommentMutation(queryClient, threadId, artifactId),
  );
  const comment =
    target.kind === "comment"
      ? comments.find((entry) => entry.id === target.id)
      : undefined;
  if (target.kind === "comment" && comment === undefined) return null;
  const entries =
    comment === undefined
      ? []
      : [comment, ...comments.filter((entry) => entry.parentId === comment.id)];
  return (
    <PopoverRoot
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <PopoverContent
        positionerClassName="artifact-comment-positioner"
        anchor={anchor}
        side="bottom"
        align="center"
        sideOffset={6}
        collisionPadding={8}
        className="artifact-comment-card"
        aria-label="Comment"
        initialFocus={target.kind === "draft"}
        finalFocus={false}
      >
        {comment === undefined ? null : (
          <CommentEntries
            entries={entries}
            people={people}
            resolving={resolve.isPending}
            onResolve={
              readOnly
                ? undefined
                : () => resolve.mutate(comment.id, { onSuccess: onClose })
            }
          />
        )}
        {readOnly ? null : comment === undefined && target.kind === "draft" ? (
          <CommentComposer
            key="draft"
            threadId={threadId}
            dictation={dictation}
            label="Comment"
            placeholder="Comment, or @mention dx"
            pending={create.isPending}
            error={create.isError ? failure(create.error) : undefined}
            text={draftText}
            focus
            onSubmit={(body, failed) =>
              create.mutate(
                "target" in target.draft
                  ? { target: target.draft.target, body }
                  : {
                      quote: target.draft.quote,
                      near: target.draft.near,
                      body,
                    },
                {
                  onSuccess: (posted) => onPosted(posted.id),
                  onError: failed,
                },
              )
            }
          />
        ) : comment === undefined ? null : (
          <CommentComposer
            key={comment.id}
            threadId={threadId}
            dictation={dictation}
            label="Reply"
            placeholder="Reply, or @mention dx"
            pending={create.isPending}
            error={create.isError ? failure(create.error) : undefined}
            onSubmit={(body, failed) =>
              create.mutate({ parentId: comment.id, body }, { onError: failed })
            }
          />
        )}
      </PopoverContent>
    </PopoverRoot>
  );
}

/**
 * The header's Comments button: the open comments, in the order their text
 * appears, then those whose text is gone. Choosing one opens its card.
 */
export function CommentsMenu({
  comments,
  anchors,
  loadFailed,
  onSelect,
  emptyText = "No comments yet. Select text and choose Comment.",
  detachedHeading = "Text no longer here",
}: {
  /** What the menu says when there are no open comments. */
  readonly emptyText?: string;
  /** The heading over comments whose text or shape is gone. */
  readonly detachedHeading?: string;
  readonly comments: ReadonlyArray<ThreadArtifactComment>;
  /** Open comments whose text the editor holds, in document order. */
  readonly anchors: ReadonlyArray<{
    readonly id: string;
    readonly from: number;
  }>;
  readonly loadFailed: boolean;
  readonly onSelect: (id: string) => void;
}) {
  const open = comments.filter(
    (comment) => comment.parentId === null && comment.resolvedAt === null,
  );
  const order = new Map(anchors.map((anchor) => [anchor.id, anchor.from]));
  const anchored = open
    .filter((comment) => order.has(comment.id))
    .toSorted((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const detached = open.filter((comment) => !order.has(comment.id));
  const replies = (id: string) =>
    comments.filter((comment) => comment.parentId === id).length;
  const item = (comment: ThreadArtifactComment) => (
    <MenuItem
      key={comment.id}
      className="artifact-comments-item"
      onClick={() => onSelect(comment.id)}
    >
      <span className="artifact-comments-item-quote">
        {shorten(comment.quote, 60)}
      </span>
      <span className="artifact-comments-item-body">
        <strong>{authorName(comment.author)}</strong>{" "}
        {shorten(comment.body, 90)}
      </span>
      {replies(comment.id) === 0 ? null : (
        <span className="artifact-comments-item-replies">
          {replies(comment.id) === 1
            ? "1 reply"
            : `${replies(comment.id)} replies`}
        </span>
      )}
    </MenuItem>
  );
  return (
    <MenuRoot>
      <MenuTrigger
        className={cn(
          buttonVariants({ variant: "subtle", size: "xs" }),
          "artifact-tool artifact-comments-toggle",
        )}
        aria-label={`Comments (${open.length})`}
        title="Comments"
      >
        <MessageSquare aria-hidden="true" />
        {open.length === 0 ? null : <span>{open.length}</span>}
      </MenuTrigger>
      <MenuPopup
        side="bottom"
        align="end"
        collisionPadding={8}
        className="artifact-comments-menu"
        aria-label="Comments"
      >
        {loadFailed ? (
          <p className="artifact-comments-empty" role="alert">
            Couldn't load the comments.
          </p>
        ) : open.length === 0 ? (
          <p className="artifact-comments-empty">{emptyText}</p>
        ) : null}
        {anchored.map(item)}
        {detached.length === 0 ? null : (
          <MenuGroup>
            <MenuLabel>{detachedHeading}</MenuLabel>
            {detached.map(item)}
          </MenuGroup>
        )}
      </MenuPopup>
    </MenuRoot>
  );
}
