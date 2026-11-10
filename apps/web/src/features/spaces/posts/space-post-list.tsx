import { Popover } from "@base-ui/react/popover";
import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquare, Pencil, SmilePlus } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { useCommentMentions } from "../../../shared/comments/comment-mention-menu.js";
import { draftOf } from "../../../shared/comments/comment-mentions.js";
import {
  type CommentPeople,
  CommentText,
} from "../../../shared/comments/comment-text.js";
import { useTimeText } from "../../../shared/hooks/use-clock.js";
import { Avatar, ParticipantStack } from "../../../shared/ui/avatar.js";
import { Button } from "../../../shared/ui/button.js";
import { RichMarkdown } from "../../../shared/ui/rich-markdown.js";
import { ThreadReferenceContext } from "../../../shared/ui/thread-reference-context.js";
import { TimeText } from "../../../shared/ui/time-text.js";
import { spaceThreadReferences } from "../cards/space-thread-references.js";
import { useOpenMessageComments } from "../comments/message-comments.js";
import { compactAge, dayLabel } from "../space-format.js";
import { showLinkedPost } from "./focus-post.js";
import { useSpacePeople } from "./space-people.js";
import {
  postFailureText,
  postTime,
  REACTION_EMOJI,
  REACTION_NAME,
} from "./space-post-format.js";
import {
  SPACE_POST_REACTIONS,
  type SpacePost,
  type SpacePostReaction,
  spacePostRevisionsQueryOptions,
  useEditSpacePost,
  useSetSpacePostReaction,
} from "./space-posts-queries.js";

/** "Today" over the first post of each day, as a chat divides its days. */
function DayDivider({ at }: { readonly at: number }) {
  const label = useTimeText((now) => dayLabel(at, now));
  return (
    <div className="space-day-divider">
      <span>{label}</span>
    </div>
  );
}

/** What the viewer may do with the posts: nothing while archived. */
export interface SpacePostPermissions {
  readonly react: boolean;
  readonly comment: boolean;
}

/** One reaction's chip: its emoji and count, pressed when it is the viewer's. */
function ReactionChip({
  reaction,
  enabled,
  onToggle,
}: {
  readonly reaction: SpacePost["reactions"][number];
  readonly enabled: boolean;
  readonly onToggle: (reaction: SpacePostReaction, on: boolean) => void;
}) {
  const who = [
    ...(reaction.mine ? ["You"] : []),
    ...(reaction.agent ? ["dx"] : []),
  ];
  const others = reaction.count - who.length;
  const label = `${REACTION_NAME[reaction.reaction]}: ${[
    ...who,
    ...(others > 0 ? [`${others} more`] : []),
  ].join(", ")}`;
  return (
    <button
      type="button"
      className="space-reaction"
      data-reaction={reaction.reaction}
      data-agent={reaction.agent ? "" : undefined}
      aria-pressed={reaction.mine}
      aria-label={label}
      title={label}
      disabled={!enabled}
      onClick={() => onToggle(reaction.reaction, !reaction.mine)}
    >
      <span aria-hidden="true">{REACTION_EMOJI[reaction.reaction]}</span>
      <span className="space-reaction-count">{reaction.count}</span>
    </button>
  );
}

/** The five reactions, from the post's Add Reaction button. */
function ReactionPicker({
  post,
  onToggle,
}: {
  readonly post: SpacePost;
  readonly onToggle: (reaction: SpacePostReaction, on: boolean) => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className="space-post-action"
        aria-label="Add Reaction"
        title="Add Reaction"
      >
        <SmilePlus aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={6}>
          <Popover.Popup className="space-reaction-picker">
            {SPACE_POST_REACTIONS.map((reaction) => {
              const mine =
                post.reactions.find((item) => item.reaction === reaction)
                  ?.mine === true;
              return (
                <button
                  key={reaction}
                  type="button"
                  aria-label={REACTION_NAME[reaction]}
                  title={REACTION_NAME[reaction]}
                  aria-pressed={mine}
                  onClick={() => {
                    setOpen(false);
                    onToggle(reaction, !mine);
                  }}
                >
                  {REACTION_EMOJI[reaction]}
                </button>
              );
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The "edited" marker, which opens the post's earlier versions. */
function EditedMarker({
  spaceThreadId,
  post,
}: {
  readonly spaceThreadId: ThreadId;
  readonly post: SpacePost;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className="space-post-edited"
        aria-label="Edited, show earlier versions"
      >
        edited
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4}>
          <Popover.Popup className="space-post-revisions">
            {open ? (
              <Revisions spaceThreadId={spaceThreadId} postId={post.id} />
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Revisions({
  spaceThreadId,
  postId,
}: {
  readonly spaceThreadId: ThreadId;
  readonly postId: string;
}) {
  const { identity } = useAuthenticatedIdentity();
  const revisions = useQuery(
    spacePostRevisionsQueryOptions(identity.id, spaceThreadId, postId),
  );
  return (
    <>
      <h3>Earlier Versions</h3>
      {revisions.isError ? (
        <p role="alert">Could not load earlier versions.</p>
      ) : revisions.data === undefined ? (
        <p aria-busy="true">Loading…</p>
      ) : (
        <ol>
          {/* The last version is the post as it reads now. */}
          {revisions.data
            .slice(0, -1)
            .toReversed()
            .map((revision) => (
              <li key={revision.revision}>
                <TimeText
                  text={(now) =>
                    `${compactAge(postTime(revision.createdAt), now)} ago`
                  }
                />
                <p>{revision.text}</p>
              </li>
            ))}
        </ol>
      )}
    </>
  );
}

/** The viewer's own post, open for editing in place. */
function EditPostForm({
  spaceThreadId,
  postId,
  initialText,
  onDone,
}: {
  readonly spaceThreadId: ThreadId;
  readonly postId: string;
  /** The post's text when Edit was chosen: the draft starts from it. */
  readonly initialText: string;
  readonly onDone: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const edit = useEditSpacePost(identity.id, spaceThreadId);
  // The box shows mentions as people read them (`@Name`), and the people in
  // them stay picked, so saving writes the same mentions back.
  const [start] = React.useState(() => draftOf(initialText));
  const [text, setText] = React.useState(start.draft);
  const box = React.useRef<HTMLTextAreaElement | null>(null);
  const { members } = useSpacePeople(spaceThreadId);
  const mentions = useCommentMentions({
    members,
    body: text,
    setBody: setText,
    box,
    initialPicked: start.picked,
  });
  const posted = mentions.post(text.trim());
  const changed = text.trim() !== "" && posted !== initialText.trim();
  const save = () => {
    if (!changed || edit.isPending) return;
    edit.mutate({ postId, text: posted }, { onSuccess: () => onDone() });
  };
  return (
    <form
      className="space-post-edit"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {mentions.menu}
      <textarea
        aria-label="Edit Post"
        value={text}
        rows={Math.min(8, Math.max(2, text.split("\n").length))}
        ref={(node) => {
          box.current = node;
          if (node === null) return;
          node.focus();
          node.setSelectionRange(node.value.length, node.value.length);
        }}
        onChange={(event) => {
          setText(event.target.value);
          mentions.track(
            event.target.value,
            event.target.selectionStart ?? event.target.value.length,
          );
        }}
        onKeyDown={(event) => {
          if (mentions.onKeyDown(event)) return;
          if (event.key === "Escape") {
            event.preventDefault();
            onDone();
          } else if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            save();
          }
        }}
      />
      {edit.isError ? (
        <p className="space-post-edit-error" role="alert">
          {postFailureText(edit.error, "edit")}
        </p>
      ) : null}
      <div className="space-post-edit-actions">
        <Button variant="ghost" size="xs" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="xs"
          disabled={!changed || edit.isPending}
          aria-busy={edit.isPending || undefined}
        >
          Save
        </Button>
      </div>
    </form>
  );
}

/** Who commented and how many replies, under a commented post. */
function RepliesRow({
  spaceThreadId,
  post,
  side,
}: {
  readonly spaceThreadId: ThreadId;
  readonly post: SpacePost;
  readonly side: "left" | "right";
}) {
  const open = useOpenMessageComments(spaceThreadId);
  const { count, commenters } = post.comments;
  if (count === 0) return null;
  return (
    <div
      className="message-comment-replies space-post-replies"
      data-side={side === "left" ? "left" : undefined}
    >
      <ParticipantStack
        participants={commenters.map((person) => ({
          userId: person.userId,
          name: person.name,
          ...(person.avatarUrl === undefined
            ? {}
            : { image: person.avatarUrl }),
        }))}
      />
      <button type="button" onClick={() => open(post.id)}>
        {count === 1 ? "1 reply" : `${count} replies`}
      </button>
    </div>
  );
}

function AuthorTime({ at }: { readonly at: number }) {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={new Date(at).toLocaleString()}
    >
      <TimeText text={(now) => compactAge(at, now)} />
    </time>
  );
}

/**
 * One post: the viewer's own on the right in a bubble, another person's on
 * the left under their name, dx's as plain Markdown. Under it, "edited",
 * its reactions, and its replies.
 */
function SpacePostRow({
  spaceThreadId,
  post,
  permissions,
  people,
  focused = false,
  onFocused,
}: {
  readonly spaceThreadId: ThreadId;
  readonly post: SpacePost;
  readonly permissions: SpacePostPermissions;
  /** Names for the mention chips in people's posts. */
  readonly people: CommentPeople;
  /** A link opens the chat at this post. */
  readonly focused?: boolean;
  readonly onFocused?: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const react = useSetSpacePostReaction(identity.id, spaceThreadId);
  const openComments = useOpenMessageComments(spaceThreadId);
  const [editing, setEditing] = React.useState(false);
  const agent = post.author.kind === "agent";
  const mine = !agent && post.author.userId === identity.id;
  const side = mine ? "right" : "left";
  const toggle = (reaction: SpacePostReaction, on: boolean) =>
    react.mutate({ postId: post.id, reaction, on });
  const reactions = post.reactions.filter(({ count }) => count > 0);
  const edited = post.editedAt !== undefined || post.revisionCount > 0;
  const kind = agent ? "agent" : mine ? "mine" : "other";
  return (
    <article
      ref={
        focused
          ? (node: HTMLElement | null) =>
              node === null ? undefined : showLinkedPost(node, onFocused)
          : undefined
      }
      className={`space-post ${agent ? "agent-message" : "user-message"}`}
      data-post-id={post.id}
      data-kind={kind}
      data-author={kind === "other" ? "other" : undefined}
      aria-label={
        agent ? "dx" : mine ? "Your post" : `Post from ${post.author.name}`
      }
    >
      {kind === "other" ? (
        <div className="message-author">
          <Avatar
            name={post.author.name}
            seed={post.author.userId ?? post.author.name}
            {...(post.author.avatarUrl === undefined
              ? {}
              : { image: post.author.avatarUrl })}
          />
          <span className="message-author-name">{post.author.name}</span>
          <AuthorTime at={postTime(post.createdAt)} />
        </div>
      ) : null}
      <div className="space-post-body">
        {editing ? (
          <EditPostForm
            spaceThreadId={spaceThreadId}
            postId={post.id}
            initialText={post.text}
            onDone={() => setEditing(false)}
          />
        ) : agent ? (
          <div className="message-content">
            <ThreadReferenceContext.Provider value={spaceThreadReferences}>
              <RichMarkdown>{post.text}</RichMarkdown>
            </ThreadReferenceContext.Provider>
          </div>
        ) : (
          <div className="message-content">
            <p className="user-message-text">
              <CommentText text={post.text} people={people} />
            </p>
          </div>
        )}
        {editing || !(permissions.react || permissions.comment) ? null : (
          <div className="space-post-actions" data-side={side}>
            {permissions.react ? (
              <ReactionPicker post={post} onToggle={toggle} />
            ) : null}
            {permissions.comment ? (
              <button
                type="button"
                className="space-post-action"
                aria-label="Comment"
                title="Comment"
                onClick={() => openComments(post.id)}
              >
                <MessagesSquare aria-hidden="true" />
              </button>
            ) : null}
            {mine && permissions.react ? (
              <button
                type="button"
                className="space-post-action"
                aria-label="Edit"
                title="Edit"
                onClick={() => setEditing(true)}
              >
                <Pencil aria-hidden="true" />
              </button>
            ) : null}
          </div>
        )}
      </div>
      {edited || reactions.length > 0 ? (
        <div className="space-post-meta" data-side={side}>
          {edited ? (
            <EditedMarker spaceThreadId={spaceThreadId} post={post} />
          ) : null}
          {reactions.length > 0 ? (
            <div className="space-reactions">
              {reactions.map((reaction) => (
                <ReactionChip
                  key={reaction.reaction}
                  reaction={reaction}
                  enabled={permissions.react}
                  onToggle={toggle}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <RepliesRow spaceThreadId={spaceThreadId} post={post} side={side} />
    </article>
  );
}

/** The day a post was made, to divide the chat. */
const dayOf = (at: number) => new Date(at).toDateString();

/**
 * The Space's chat: its posts, oldest first, with a divider over each day's
 * first post. dx's text replies and tool calls are never posts, so they never
 * show here.
 */
export function SpacePostList({
  spaceThreadId,
  posts,
  permissions,
  focusPostId,
  onFocused,
}: {
  readonly spaceThreadId: ThreadId;
  readonly posts: ReadonlyArray<SpacePost>;
  readonly permissions: SpacePostPermissions;
  /** A post a link opens at: brought into view and flashed once. */
  readonly focusPostId?: string;
  readonly onFocused?: () => void;
}) {
  const { people } = useSpacePeople(spaceThreadId);
  return (
    <>
      {posts.map((post, index) => {
        const at = postTime(post.createdAt);
        const previous = posts[index - 1];
        const newDay =
          previous === undefined ||
          dayOf(postTime(previous.createdAt)) !== dayOf(at);
        return (
          <React.Fragment key={post.id}>
            {newDay ? <DayDivider at={at} /> : null}
            <SpacePostRow
              spaceThreadId={spaceThreadId}
              post={post}
              permissions={permissions}
              people={people}
              focused={post.id === focusPostId}
              onFocused={onFocused}
            />
          </React.Fragment>
        );
      })}
    </>
  );
}
