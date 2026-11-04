import { Dialog } from "@base-ui/react/dialog";
import type { ThreadArtifactComment } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import * as React from "react";
import {
  ModalSurface,
  ModalSurfaceClose,
  ModalSurfaceHeader,
} from "../../../shared/ui/modal-surface.js";
import { TimeText } from "../../../shared/ui/time-text.js";
import { formatRelativeTime } from "../../../shared/utils.js";
import {
  createArtifactCommentMutation,
  resolveArtifactCommentMutation,
} from "../artifact-comments-queries.js";
import { ArtifactApiError } from "../artifacts-api.js";
import type { ArtifactSessionSnapshot } from "./artifact-session.js";
import { CommentText } from "./comment-text.js";

/** A comment being written on a quote in the current revision. */
export interface CommentDraft {
  readonly quote: string;
  readonly near: number;
}

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

/** Writes a comment or a reply; posts on the button or Mod-Enter. */
/** A new comment's box takes focus as it opens. */
const focusOnOpen = (node: HTMLTextAreaElement | null) => node?.focus();

function CommentComposer({
  label,
  placeholder,
  pending,
  error,
  onSubmit,
  onCancel,
  text,
  focus = false,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly pending: boolean;
  readonly error: string | undefined;
  /** Posts `body`; `done` clears the box once the post succeeded. */
  readonly onSubmit: (body: string, done: () => void) => void;
  readonly onCancel?: () => void;
  /** The text, when it must outlive the box (a new comment's draft). */
  readonly text?: {
    readonly value: string;
    readonly set: (value: string) => void;
  };
  readonly focus?: boolean;
}) {
  const [own, setOwn] = React.useState("");
  const body = text?.value ?? own;
  const setBody = text?.set ?? setOwn;
  const submit = () => {
    const value = body.trim();
    if (value === "" || pending) return;
    onSubmit(value, () => setBody(""));
  };
  return (
    <form
      className="artifact-comment-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={focus ? focusOnOpen : undefined}
        aria-label={label}
        placeholder={placeholder}
        value={body}
        maxLength={8_000}
        rows={2}
        onChange={(event) => setBody(event.currentTarget.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
      />
      {error === undefined ? null : (
        <p className="artifact-comment-error" role="alert">
          {error}
        </p>
      )}
      <div className="artifact-comment-actions">
        <button
          type="button"
          className="artifact-comment-mention"
          onClick={() =>
            setBody(
              body.includes("@[dx](agent)") ? body : `@[dx](agent) ${body}`,
            )
          }
        >
          Ask @dx
        </button>
        {onCancel === undefined ? null : (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="submit"
          className="artifact-comment-submit"
          disabled={pending || body.trim() === ""}
        >
          {label}
        </button>
      </div>
    </form>
  );
}

function CommentThread({
  comment,
  replies,
  active,
  anchored,
  readOnly,
  threadId,
  artifactId,
  onSelect,
}: {
  readonly comment: ThreadArtifactComment;
  readonly replies: ReadonlyArray<ThreadArtifactComment>;
  readonly active: boolean;
  readonly anchored: boolean;
  readonly readOnly: boolean;
  readonly threadId: ThreadId;
  readonly artifactId: string;
  readonly onSelect: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const reply = useMutation(
    createArtifactCommentMutation(queryClient, threadId, artifactId),
  );
  const resolve = useMutation(
    resolveArtifactCommentMutation(queryClient, threadId, artifactId),
  );
  return (
    <li
      className="artifact-comment-thread"
      data-active={active || undefined}
      data-comment={comment.id}
    >
      <button
        type="button"
        className="artifact-comment-quote"
        disabled={!anchored}
        title={anchored ? "Show in the artifact" : "This text is gone"}
        onClick={() => onSelect(comment.id)}
      >
        {shorten(comment.quote)}
      </button>
      {[comment, ...replies].map((entry) => (
        <div key={entry.id} className="artifact-comment">
          <div className="artifact-comment-meta">
            <strong>{authorName(entry.author)}</strong>
            <TimeText
              text={(now) =>
                formatRelativeTime({ epochMilliseconds: entry.createdAt }, now)
              }
            />
          </div>
          <p className="artifact-comment-body">
            <CommentText text={entry.body} />
          </p>
        </div>
      ))}
      {readOnly ? null : (
        <>
          <CommentComposer
            label="Reply"
            placeholder="Reply…"
            pending={reply.isPending}
            error={reply.isError ? failure(reply.error) : undefined}
            onSubmit={(body, done) =>
              reply.mutate({ parentId: comment.id, body }, { onSuccess: done })
            }
          />
          <button
            type="button"
            className="artifact-comment-resolve"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate(comment.id)}
          >
            <Check aria-hidden="true" />
            Resolve
          </button>
        </>
      )}
    </li>
  );
}

/**
 * The open comments, in the order their text appears, then those whose text
 * is gone; and the composer for a new comment on the selection.
 */
function CommentsList({
  snapshot,
  comments,
  loadFailed,
  draft,
  draftText,
  readOnly,
  threadId,
  artifactId,
  onSelect,
  onDraftDone,
}: {
  readonly snapshot: ArtifactSessionSnapshot;
  /** The comments query's data. */
  readonly comments: ReadonlyArray<ThreadArtifactComment>;
  readonly loadFailed: boolean;
  readonly draft: CommentDraft | undefined;
  readonly draftText: {
    readonly value: string;
    readonly set: (value: string) => void;
  };
  readonly readOnly: boolean;
  readonly threadId: ThreadId;
  readonly artifactId: string;
  readonly onSelect: (id: string) => void;
  readonly onDraftDone: () => void;
}) {
  const queryClient = useQueryClient();
  const create = useMutation(
    createArtifactCommentMutation(queryClient, threadId, artifactId),
  );
  const open = comments.filter(
    (comment) => comment.parentId === null && comment.resolvedAt === null,
  );
  const order = new Map(
    snapshot.anchors.map((anchor) => [anchor.id, anchor.from] as const),
  );
  const anchored = open
    .filter((comment) => order.has(comment.id))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const detached = open.filter((comment) => !order.has(comment.id));
  const repliesTo = (id: string) =>
    comments.filter((comment) => comment.parentId === id);
  const thread = (comment: ThreadArtifactComment, isAnchored: boolean) => (
    <CommentThread
      key={comment.id}
      comment={comment}
      replies={repliesTo(comment.id)}
      active={snapshot.activeComment === comment.id}
      anchored={isAnchored}
      readOnly={readOnly}
      threadId={threadId}
      artifactId={artifactId}
      onSelect={onSelect}
    />
  );
  return (
    <div className="artifact-comments-body">
      {draft === undefined || readOnly ? null : (
        <div className="artifact-comment-new">
          <p className="artifact-comment-quote" data-draft="true">
            {shorten(draft.quote)}
          </p>
          <CommentComposer
            label="Comment"
            placeholder="Add a comment…"
            pending={create.isPending}
            error={create.isError ? failure(create.error) : undefined}
            text={draftText}
            focus
            onSubmit={(body, done) =>
              create.mutate(
                { quote: draft.quote, near: draft.near, body },
                {
                  onSuccess: () => {
                    done();
                    onDraftDone();
                  },
                },
              )
            }
            onCancel={() => {
              draftText.set("");
              onDraftDone();
            }}
          />
        </div>
      )}
      {loadFailed ? (
        <p className="artifact-comment-error" role="alert">
          Couldn't load the comments.
        </p>
      ) : open.length === 0 && draft === undefined ? (
        <p className="artifact-comments-empty">
          {readOnly
            ? "No comments."
            : "No comments yet. Select text and choose Comment."}
        </p>
      ) : null}
      <ul className="artifact-comment-list">
        {anchored.map((comment) => thread(comment, true))}
      </ul>
      {detached.length === 0 ? null : (
        <>
          <h3 className="artifact-comments-heading">Text no longer here</h3>
          <ul className="artifact-comment-list">
            {detached.map((comment) => thread(comment, false))}
          </ul>
        </>
      )}
    </div>
  );
}

/** The comments: a column beside the artifact, or a sheet on a phone. */
export function ArtifactComments({
  phone,
  onClose,
  ...props
}: React.ComponentProps<typeof CommentsList> & {
  readonly phone: boolean;
  readonly onClose: () => void;
}) {
  if (phone)
    return (
      <Dialog.Root open onOpenChange={(next) => (next ? undefined : onClose())}>
        <ModalSurface className="artifact-comments-sheet" ariaLabel="Comments">
          <ModalSurfaceHeader>
            <strong>Comments</strong>
            <ModalSurfaceClose />
          </ModalSurfaceHeader>
          <CommentsList {...props} />
        </ModalSurface>
      </Dialog.Root>
    );
  return (
    <aside className="artifact-comments" aria-label="Comments">
      <header className="artifact-comments-header">
        <strong>Comments</strong>
        <button
          type="button"
          className="artifact-icon-button"
          aria-label="Close comments"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <CommentsList {...props} />
    </aside>
  );
}
