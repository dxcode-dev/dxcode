import {
  ARTIFACT_COMMENT_ID_PATTERN,
  ARTIFACT_COMMENT_LIMIT,
  ARTIFACT_COMMENT_MAX_LENGTH,
  ARTIFACT_COMMENT_QUOTE_MAX_LENGTH,
  type ThreadArtifactComment,
} from "@dx/api";
import type { Bindings } from "../http/types.js";
import { findQuote } from "./anchors.js";
import { type ArtifactWriter, readArtifact } from "./store.js";

/**
 * Comments on an artifact, stored in D1 beside its revisions, never in its
 * Markdown. A top-level comment sits on quoted text; each save moves it to
 * that text in the new revision (`saveArtifact`), and a read moves one still
 * anchored to an older revision, so callers always see anchors into the
 * current Markdown. Replies follow their parent, and resolving the parent
 * hides them with it.
 */

type ArtifactBindings = Pick<Bindings, "DB" | "DX_STORAGE">;

interface CommentRow {
  readonly id: string;
  readonly artifact_id: string;
  readonly parent_id: string | null;
  readonly quote: string;
  readonly anchor_revision: number | null;
  readonly anchor_start: number | null;
  readonly anchor_end: number | null;
  readonly author_kind: "user" | "agent";
  readonly author_user_id: string | null;
  readonly author_name: string | null;
  readonly body: string;
  readonly created_at: number;
  readonly resolved_at: number | null;
}

export const newArtifactCommentId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `cmt_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
};

export const isArtifactCommentId = (value: string | undefined | null) =>
  typeof value === "string" && ARTIFACT_COMMENT_ID_PATTERN.test(value);

const SELECT_COMMENT = `
  SELECT comment.*, person.name AS author_name
    FROM thread_artifact_comment AS comment
    LEFT JOIN "user" AS person ON person.id = comment.author_user_id`;

/** The comment as the API shows it, anchored into `markdown` at `revision`. */
const commentData = (
  row: CommentRow,
  revision: number,
  markdown: string,
): ThreadArtifactComment => {
  const anchor =
    row.parent_id !== null
      ? undefined
      : row.anchor_revision === revision && row.anchor_start !== null
        ? { start: row.anchor_start, end: row.anchor_end ?? row.anchor_start }
        : // Saved after an older revision: find the quote in this one.
          findQuote(markdown, row.quote, row.anchor_start ?? 0);
  return {
    id: row.id,
    artifactId: row.artifact_id,
    parentId: row.parent_id,
    quote: row.quote,
    anchor: anchor === undefined ? null : { revision, ...anchor },
    author:
      row.author_kind === "user"
        ? { kind: "user", userId: row.author_user_id, name: row.author_name }
        : { kind: "agent" },
    body: row.body,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
};

/**
 * Every comment and reply on a live artifact of this Thread, oldest first,
 * resolved ones included; undefined when the Thread has no such artifact.
 */
export const listArtifactComments = async (
  bindings: ArtifactBindings,
  threadId: string,
  artifactId: string,
): Promise<ReadonlyArray<ThreadArtifactComment> | undefined> => {
  const current = await readArtifact(bindings, threadId, artifactId);
  if (current === undefined || bindings.DB === undefined) return undefined;
  const { results } = await bindings.DB.prepare(
    `${SELECT_COMMENT}
      WHERE comment.artifact_id = ?
      ORDER BY comment.created_at, comment.id`,
  )
    .bind(artifactId)
    .all<CommentRow>();
  return results.map((row) =>
    commentData(row, current.artifact.revision, current.markdown),
  );
};

export type ArtifactCommentResult =
  | { readonly kind: "saved"; readonly comment: ThreadArtifactComment }
  | { readonly kind: "not-found" }
  | { readonly kind: "comment-not-found" }
  | { readonly kind: "quote-not-found" }
  | { readonly kind: "limit" }
  | { readonly kind: "invalid"; readonly message: string };

const findComment = (db: D1Database, artifactId: string, commentId: string) =>
  db
    .prepare(
      `${SELECT_COMMENT} WHERE comment.id = ? AND comment.artifact_id = ?`,
    )
    .bind(commentId, artifactId)
    .first<CommentRow>();

/**
 * Adds a top-level comment on `quote`, found in the current revision (the
 * occurrence nearest `near`), or a reply to `parentId`. A reply always goes
 * on the top-level comment, so a thread of replies stays one level deep.
 */
export const addArtifactComment = async (
  bindings: ArtifactBindings,
  input: {
    readonly threadId: string;
    readonly artifactId: string;
    readonly body: string;
    readonly writer: ArtifactWriter;
    readonly now?: number;
  } & (
    | { readonly quote: string; readonly near?: number }
    | { readonly parentId: string }
  ),
): Promise<ArtifactCommentResult> => {
  const body = input.body.trim();
  if (body.length === 0 || body.length > ARTIFACT_COMMENT_MAX_LENGTH)
    return {
      kind: "invalid",
      message: `A comment is 1 to ${ARTIFACT_COMMENT_MAX_LENGTH} characters.`,
    };
  const current = await readArtifact(
    bindings,
    input.threadId,
    input.artifactId,
  );
  if (current === undefined || bindings.DB === undefined)
    return { kind: "not-found" };
  const db = bindings.DB;
  const count =
    (await db
      .prepare(
        "SELECT count(*) AS n FROM thread_artifact_comment WHERE artifact_id = ?",
      )
      .bind(input.artifactId)
      .first<number>("n")) ?? 0;
  if (count >= ARTIFACT_COMMENT_LIMIT) return { kind: "limit" };
  let parentId: string | null = null;
  let quote = "";
  let anchor: { start: number; end: number } | undefined;
  if ("parentId" in input) {
    if (!isArtifactCommentId(input.parentId))
      return { kind: "comment-not-found" };
    const parent = await findComment(db, input.artifactId, input.parentId);
    if (parent === null) return { kind: "comment-not-found" };
    parentId = parent.parent_id ?? parent.id;
  } else {
    quote = input.quote;
    if (quote.length === 0 || quote.length > ARTIFACT_COMMENT_QUOTE_MAX_LENGTH)
      return {
        kind: "invalid",
        message: `A quote is 1 to ${ARTIFACT_COMMENT_QUOTE_MAX_LENGTH} characters of the artifact's text.`,
      };
    anchor = findQuote(current.markdown, quote, input.near ?? 0);
    if (anchor === undefined) return { kind: "quote-not-found" };
  }
  const id = newArtifactCommentId();
  const writer = input.writer;
  await db
    .prepare(
      `INSERT INTO thread_artifact_comment
         (id, artifact_id, parent_id, quote, anchor_revision, anchor_start,
          anchor_end, author_kind, author_user_id, submission_id, body,
          created_at, resolved_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL)`,
    )
    .bind(
      id,
      input.artifactId,
      parentId,
      quote,
      anchor === undefined ? null : current.artifact.revision,
      anchor?.start ?? null,
      anchor?.end ?? null,
      writer.kind,
      writer.kind === "user" ? writer.userId : null,
      writer.kind === "agent"
        ? (writer.submissionId?.slice(0, 128) ?? null)
        : null,
      body,
      input.now ?? Date.now(),
    )
    .run();
  const row = await findComment(db, input.artifactId, id);
  if (row === null) return { kind: "not-found" };
  return {
    kind: "saved",
    comment: commentData(row, current.artifact.revision, current.markdown),
  };
};

/**
 * Resolves a comment: its top-level comment, so the whole thread of replies
 * is hidden with it. Resolving again keeps the first time.
 */
export const resolveArtifactComment = async (
  bindings: ArtifactBindings,
  input: {
    readonly threadId: string;
    readonly artifactId: string;
    readonly commentId: string;
    readonly now?: number;
  },
): Promise<ArtifactCommentResult> => {
  const current = await readArtifact(
    bindings,
    input.threadId,
    input.artifactId,
  );
  if (current === undefined || bindings.DB === undefined)
    return { kind: "not-found" };
  if (!isArtifactCommentId(input.commentId))
    return { kind: "comment-not-found" };
  const db = bindings.DB;
  const comment = await findComment(db, input.artifactId, input.commentId);
  if (comment === null) return { kind: "comment-not-found" };
  const topId = comment.parent_id ?? comment.id;
  await db
    .prepare(
      `UPDATE thread_artifact_comment SET resolved_at = COALESCE(resolved_at, ?3)
        WHERE id = ?1 AND artifact_id = ?2`,
    )
    .bind(topId, input.artifactId, input.now ?? Date.now())
    .run();
  const row = await findComment(db, input.artifactId, topId);
  if (row === null) return { kind: "comment-not-found" };
  return {
    kind: "saved",
    comment: commentData(row, current.artifact.revision, current.markdown),
  };
};
