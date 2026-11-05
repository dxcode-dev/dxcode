import {
  ARTIFACT_COMMENT_MAX_LENGTH,
  ARTIFACT_COMMENT_QUOTE_MAX_LENGTH,
  ARTIFACT_FOLDER_MAX_LENGTH,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_TITLE_MAX_LENGTH,
  type ThreadArtifact,
  type ThreadArtifactAuthor,
  type ThreadArtifactComment,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { defineTool, type ToolDefinition } from "@flue/runtime";
import { createTwoFilesPatch } from "diff";
import * as v from "valibot";
import { publishRealtimeInvalidation } from "../realtime/publication.js";
import { threadMembers } from "../thread-sharing/members.js";
import type { ThreadToolsContext } from "../threads/agent-tools.js";
import { artifactCommented, artifactSaved } from "./ask-effects.js";
import {
  addArtifactComment,
  listArtifactComments,
  resolveArtifactComment,
} from "./comments.js";
import { personMention } from "./owner-ask.js";
import { UNTRUSTED_NOTE, wrapPeopleText } from "./people-text.js";
import {
  type ArtifactWithMarkdown,
  type ArtifactWriter,
  createArtifact,
  listArtifacts,
  readArtifact,
  readArtifactRevision,
  saveArtifact,
} from "./store.js";

/**
 * `artifact`: the agent lists, reads, creates, updates, and asks to delete
 * its Thread's artifacts. It acts as the Thread, through the same store the
 * routes use, so the compare-and-swap, limits, and retention hold for it.
 * Text people wrote (their edits, comments, and names) reaches the model
 * wrapped as untrusted data, and bounded.
 */

/** Lines one `read` returns. */
export const ARTIFACT_READ_LINES = 500;
/** The most characters of people's diff, comments, or a conflict's Markdown in one result. */
const PEOPLE_DIFF_CHARS = 12_000;
const COMMENT_TEXT_CHARS = 2_000;
const COMMENTS_SHOWN = 100;
const OUTLINE_ENTRIES = 200;
const CONFLICT_MARKDOWN_CHARS = 60_000;
const NOTE_ARTIFACTS = 10;

const authorName = (author: ThreadArtifactAuthor) =>
  author.kind === "agent"
    ? "agent"
    : wrapPeopleText(author.name ?? "a former member", 200);

/**
 * Applies `edits` in order, each against the text the previous one left.
 * Every `old_str` must appear exactly once; otherwise nothing applies.
 */
export const applyArtifactEdits = (
  markdown: string,
  edits: ReadonlyArray<{ readonly old_str: string; readonly new_str: string }>,
):
  | { readonly ok: true; readonly markdown: string }
  | { readonly ok: false; readonly message: string } => {
  let text = markdown;
  for (const [index, edit] of edits.entries()) {
    if (edit.old_str.length === 0)
      return {
        ok: false,
        message: `edits[${index}].old_str is empty. Give text that appears exactly once in the artifact.`,
      };
    const first = text.indexOf(edit.old_str);
    if (first === -1)
      return {
        ok: false,
        message: `edits[${index}].old_str was not found in the artifact. Read the artifact again and copy the text exactly. Nothing was saved.`,
      };
    if (text.indexOf(edit.old_str, first + 1) !== -1)
      return {
        ok: false,
        message: `edits[${index}].old_str appears more than once in the artifact. Include more surrounding text so it matches exactly once. Nothing was saved.`,
      };
    text =
      text.slice(0, first) +
      edit.new_str +
      text.slice(first + edit.old_str.length);
  }
  return { ok: true, markdown: text };
};

const isHeading = (line: string) => /^#{1,6}\s/.test(line);

/**
 * Lines `start` to `end` (1-based, inclusive) of at most 500, and, when that
 * is not the whole artifact, an outline of its headings with line numbers.
 */
export const pageArtifact = (
  markdown: string,
  startLine?: number,
  endLine?: number,
) => {
  const lines = markdown.split("\n");
  const total = lines.length;
  const start = Math.min(Math.max(startLine ?? 1, 1), total);
  const end = Math.min(
    Math.max(endLine ?? start + ARTIFACT_READ_LINES - 1, start),
    start + ARTIFACT_READ_LINES - 1,
    total,
  );
  const partial = start > 1 || end < total;
  let fenced = false;
  const outline: Array<{ line: number; heading: string }> = [];
  if (partial)
    for (const [index, line] of lines.entries()) {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      else if (!fenced && isHeading(line) && outline.length < OUTLINE_ENTRIES)
        outline.push({ line: index + 1, heading: line });
    }
  return {
    markdown: lines.slice(start - 1, end).join("\n"),
    start_line: start,
    end_line: end,
    total_lines: total,
    ...(partial ? { outline } : {}),
  };
};

const listing = (artifact: ThreadArtifact) => ({
  artifact_id: artifact.id,
  folder: artifact.folder,
  title: artifact.title,
  revision: artifact.revision,
  last_saved_by: authorName(artifact.updatedBy),
  open_comments: artifact.openCommentCount,
  updated_at: new Date(artifact.updatedAt).toISOString(),
});

/** Open comments as the model sees them: people's text wrapped, bounded. */
const commentView = (
  comments: ReadonlyArray<ThreadArtifactComment>,
  markdown: string,
) => {
  const open = comments.filter(
    (comment) => comment.parentId === null && comment.resolvedAt === null,
  );
  const lineOf = (offset: number) =>
    markdown.slice(0, offset).split("\n").length;
  const text = (comment: ThreadArtifactComment) =>
    comment.author.kind === "agent"
      ? comment.body
      : wrapPeopleText(comment.body, COMMENT_TEXT_CHARS);
  return {
    comments: open.slice(0, COMMENTS_SHOWN).map((comment) => ({
      comment_id: comment.id,
      quote: wrapPeopleText(comment.quote, ARTIFACT_COMMENT_QUOTE_MAX_LENGTH),
      ...(comment.anchor === null
        ? { detached: true }
        : { line: lineOf(comment.anchor.start) }),
      author: authorName(comment.author),
      text: text(comment),
      replies: comments
        .filter((reply) => reply.parentId === comment.id)
        .map((reply) => ({
          comment_id: reply.id,
          author: authorName(reply.author),
          text: text(reply),
        })),
    })),
    ...(open.length > COMMENTS_SHOWN
      ? { comments_not_shown: open.length - COMMENTS_SHOWN }
      : {}),
  };
};

/**
 * What people changed since the agent's newest kept revision, as a unified
 * diff; undefined when no person saved after it or the agent never saved.
 */
export const editedByPeopleSince = async (
  context: ThreadToolsContext,
  threadId: string,
  current: ArtifactWithMarkdown,
) => {
  const row = await context.db
    .prepare(
      `SELECT MAX(revision) AS agent_revision,
              (SELECT MAX(revision) FROM thread_artifact_revision
                WHERE artifact_id = ?1 AND author_kind = 'user') AS person_revision
         FROM thread_artifact_revision
        WHERE artifact_id = ?1 AND author_kind = 'agent'`,
    )
    .bind(current.artifact.id)
    .first<{ agent_revision: number | null; person_revision: number | null }>();
  const agentRevision = row?.agent_revision ?? null;
  if (
    agentRevision === null ||
    row?.person_revision === null ||
    row?.person_revision === undefined ||
    row.person_revision <= agentRevision
  )
    return undefined;
  const before = await readArtifactRevision(
    context.bindings,
    threadId,
    current.artifact.id,
    agentRevision,
  );
  if (before === undefined) return undefined;
  const patch = createTwoFilesPatch(
    `revision ${agentRevision} (your last save)`,
    `revision ${current.artifact.revision} (current)`,
    before.markdown,
    current.markdown,
    undefined,
    undefined,
    { context: 2 },
  );
  return {
    from_revision: agentRevision,
    to_revision: current.artifact.revision,
    diff: wrapPeopleText(patch, PEOPLE_DIFF_CHARS),
  };
};

/**
 * The note the agent sees when a turn starts: artifacts people saved after
 * the agent's newest revision, so it reads them before writing. Undefined
 * when there are none.
 */
export const artifactsEditedByPeopleNote = async (
  db: D1Database,
  threadId: string,
) => {
  const { results } = await db
    .prepare(
      `SELECT artifact.id, artifact.title, artifact.current_revision
         FROM thread_artifact AS artifact
        WHERE artifact.thread_id = ?1 AND artifact.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM thread_artifact_revision AS person
             WHERE person.artifact_id = artifact.id
               AND person.author_kind = 'user'
               AND person.revision > COALESCE((
                 SELECT MAX(agent.revision) FROM thread_artifact_revision AS agent
                  WHERE agent.artifact_id = artifact.id AND agent.author_kind = 'agent'
               ), 0)
          )
        ORDER BY artifact.updated_at DESC
        LIMIT ?2`,
    )
    .bind(threadId, NOTE_ARTIFACTS + 1)
    .all<{ id: string; title: string; current_revision: number }>();
  const { results: mentioned } = await db
    .prepare(
      `SELECT DISTINCT artifact.id, artifact.title
         FROM thread_artifact_comment AS comment
         JOIN thread_artifact AS artifact ON artifact.id = comment.artifact_id
        WHERE artifact.thread_id = ?1 AND artifact.deleted_at IS NULL
          AND comment.author_kind = 'user'
          AND comment.body LIKE '%](agent)%'
          AND (SELECT resolved_at FROM thread_artifact_comment AS top
                WHERE top.id = COALESCE(comment.parent_id, comment.id)) IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM thread_artifact_comment AS reply
             WHERE reply.parent_id = COALESCE(comment.parent_id, comment.id)
               AND reply.author_kind = 'agent'
               AND reply.created_at > comment.created_at
          )
        LIMIT ?2`,
    )
    .bind(threadId, NOTE_ARTIFACTS)
    .all<{ id: string; title: string }>();
  if (results.length === 0 && mentioned.length === 0) return undefined;
  const commentLines =
    mentioned.length === 0
      ? []
      : [
          "Comments mention you and wait for your reply on these artifacts. Read each one's comments, make the change a comment asks for, and reply saying what you changed.",
          ...mentioned.map(
            (row) =>
              `- ${row.id}: ${wrapPeopleText(row.title, ARTIFACT_TITLE_MAX_LENGTH)}`,
          ),
        ];
  if (results.length === 0) return [...commentLines, UNTRUSTED_NOTE].join("\n");
  const lines = results
    .slice(0, NOTE_ARTIFACTS)
    .map(
      (row) =>
        `- ${row.id} (revision ${row.current_revision}): ${wrapPeopleText(row.title, ARTIFACT_TITLE_MAX_LENGTH)}`,
    );
  return [
    "People edited these artifacts since you last saved them. Read each one with the artifact tool before you update it, keep their wording unless asked otherwise, and work their changes in.",
    ...lines,
    ...(results.length > NOTE_ARTIFACTS
      ? ["More artifacts were edited; list them with the artifact tool."]
      : []),
    ...commentLines,
    UNTRUSTED_NOTE,
  ].join("\n");
};

export const ARTIFACTS_EDITED_SIGNAL = "artifacts_edited";

const commentOperation = v.object({
  add: v.optional(
    v.object({
      quote: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(ARTIFACT_COMMENT_QUOTE_MAX_LENGTH),
        v.description(
          "Text in the artifact the comment sits on, copied exactly; the first occurrence is used.",
        ),
      ),
      text: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(ARTIFACT_COMMENT_MAX_LENGTH),
      ),
    }),
  ),
  reply: v.optional(
    v.object({
      comment_id: v.pipe(v.string(), v.regex(/^cmt_[0-9a-f]{32}$/)),
      text: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(ARTIFACT_COMMENT_MAX_LENGTH),
      ),
    }),
  ),
  resolve: v.optional(
    v.object({
      comment_id: v.pipe(v.string(), v.regex(/^cmt_[0-9a-f]{32}$/)),
    }),
  ),
});

const DESCRIPTION = [
  "List, read, create, update, and delete artifacts: documents that belong to this Thread, which people open, edit, and comment on beside the conversation. A Thread holds any number of artifacts, grouped in folders. Write an artifact for what people will read: reports, notes, running records, plans for their review, and findings you combine from several child Threads. Keep your own working plans, scratch notes, screenshots, and data exports as files under `~/.dx/work/<topic>/` in the workspace, outside the repository, and answer one-off questions in your reply.",
  "You read and write artifacts as Markdown: GitHub-flavored Markdown plus `- [ ]`/`- [x]` checklists; `@[Name](user:USER_ID)` mentions of people and `@[dx](agent)` of yourself; `{{date:YYYY-MM-DD}}` and `{{time:ISO_INSTANT}}` chips; `{{dropdown:Todo|*Doing:blue|Done:green}}` chips, where `*` marks the selection and colors are gray, blue, green, yellow, red, and purple; and `{{toggle:key|Label}}`, a button each reader uses to show or hide the chips tagged with its key, as in `{{time#key:ISO_INSTANT}}`. A fenced `dx-view` block holding one self-contained HTML page renders as an interactive view; the creating-views skill explains how to write one. To show an image, store the file with `dxd files put <path>` in the workspace and write `![description](<printed url>)`; it stays with this Thread, so only people who can open it see it. People add images from the editor the same way. An artifact holds at most 2 MB of Markdown.",
  "Keep artifacts shallow, because people navigate them by hand. An artifact is one page: use headings for its sections, including parallel parts such as one per meeting or per option. Keep artifacts at the top level, and use a folder (one level, a single name) only to group several related artifacts. Before creating one, list the existing artifacts and extend a matching one instead of starting a parallel one.",
  "read returns at most 500 lines with the artifact's revision. When that is not the whole artifact, it adds an outline of the heading lines with their line numbers; start_line and end_line read other parts. It also returns the open comments and, when people saved changes after your last save, edited_by_people_since: a diff of what they changed.",
  "People edit artifacts while you work, so read an artifact before updating it. update names the revision you read in base_revision. When someone saved a newer revision, nothing is saved and the result returns the current Markdown: merge your change into it and update again with its revision. Keep people's wording unless they asked you to change it. Set force only when the user explicitly asks you to overwrite their newer changes. For small changes pass edits instead of the whole markdown: each old_str must appear exactly once in the whole artifact, and the edits apply together or not at all, so reading the part you change is enough.",
  "Comments sit on text and are never part of the Markdown; they stay on their text when you rewrite around it. Add, reply to, and resolve comments with comments on create or update. When a comment asks for a change, make it and reply saying what you changed. Resolving hides the comment and its replies, so resolve only when someone asks.",
  "A new artifact is visible to everyone who can open this Thread. delete never deletes by itself: it shows the user a card to confirm. Delete only when the user asks.",
  "When you need the owner's answer or approval, call request_attention: it adds the ask to the Thread's Plan artifact as an unchecked checklist item that mentions them, which notifies them. To ask someone else in the Thread, write the item yourself, such as `- [ ] @[Name](user:USER_ID) Review the pricing table`; list returns `people`: who can open this Thread, each with the exact mention to copy. A mention notifies that person. When someone ticks an ask or writes under it, this Thread wakes with a message saying so; read the artifact and carry on. When the owner answers an ask in the conversation instead, tick it yourself.",
  UNTRUSTED_NOTE,
].join("\n\n");

/**
 * Who can be mentioned in this Thread's artifacts: its owner first, then
 * its members while it is shared, each with the mention to copy. A name is
 * cut to what a mention can hold, so the mention always parses.
 */
const mentionablePeople = async (db: D1Database, threadId: string) => {
  const owner = await db
    .prepare(
      `SELECT "user".id, "user".name FROM threads
         JOIN "user" ON "user".id = threads.owner_user_id
        WHERE threads.id = ?`,
    )
    .bind(threadId)
    .first<{ id: string; name: string }>();
  const members = await threadMembers(db, threadId as ThreadId);
  const people = [
    ...(owner === null
      ? []
      : [{ id: owner.id, name: owner.name, owner: true }]),
    ...members
      .filter(({ userId }) => userId !== owner?.id)
      .map(({ userId, name }) => ({ id: userId, name, owner: false })),
  ].slice(0, 50);
  return people.map((person) => ({
    mention: personMention(person.id, person.name),
    ...(person.owner ? { owner: true } : {}),
  }));
};

/** The `artifact` tool for one Thread's agent. */
export const createArtifactTools = (
  threadId: string,
  getContext: () => ThreadToolsContext,
  submissionId?: string,
): ToolDefinition[] => [
  defineTool({
    name: "artifact",
    description: DESCRIPTION,
    input: v.object({
      action: v.pipe(
        v.picklist(["list", "read", "create", "update", "delete"]),
        v.description("What to do."),
      ),
      artifact_id: v.optional(
        v.pipe(
          v.string(),
          v.regex(/^art_[0-9a-f]{32}$/),
          v.description("The artifact, for read, update, and delete."),
        ),
      ),
      folder: v.optional(
        v.pipe(
          v.string(),
          v.maxLength(ARTIFACT_FOLDER_MAX_LENGTH),
          v.description(
            "list: only this folder ('' for the top level). create and update: the folder to put the artifact in, one name without '/'.",
          ),
        ),
      ),
      title: v.optional(
        v.pipe(
          v.string(),
          v.maxLength(ARTIFACT_TITLE_MAX_LENGTH),
          v.description("create: the title. update: a new title."),
        ),
      ),
      markdown: v.optional(
        v.pipe(
          v.string(),
          v.description(
            "create: the whole artifact. update: the whole new artifact, instead of edits.",
          ),
        ),
      ),
      start_line: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.description("read: the first line, from 1."),
        ),
      ),
      end_line: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.description("read: the last line, at most 500 after start_line."),
        ),
      ),
      base_revision: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.description("update: the revision you read."),
        ),
      ),
      edits: v.optional(
        v.pipe(
          v.array(
            v.object({
              old_str: v.pipe(
                v.string(),
                v.description(
                  "Text that appears exactly once in the artifact.",
                ),
              ),
              new_str: v.pipe(v.string(), v.description("Its replacement.")),
            }),
          ),
          v.minLength(1),
          v.maxLength(100),
          v.description(
            "update: replacements applied together, instead of markdown.",
          ),
        ),
      ),
      comments: v.optional(
        v.pipe(
          v.array(commentOperation),
          v.maxLength(50),
          v.description(
            "create and update: comment operations, each one of { add: { quote, text } }, { reply: { comment_id, text } }, or { resolve: { comment_id } }.",
          ),
        ),
      ),
      force: v.optional(
        v.pipe(
          v.boolean(),
          v.description(
            "update: save over a newer revision. Only when the user explicitly asks to overwrite their changes.",
          ),
        ),
      ),
    }),
    run: async ({ data }) => {
      const context = getContext();
      const writer: ArtifactWriter = {
        kind: "agent",
        ...(submissionId === undefined ? {} : { submissionId }),
      };
      const changed = () =>
        publishRealtimeInvalidation(
          context.bindings,
          threadId as ThreadId,
          "artifacts.invalidated",
        );
      const need = <T>(value: T | undefined, name: string): T => {
        if (value === undefined)
          throw new Error(`${data.action} needs ${name}.`);
        return value;
      };

      if (data.action === "list") {
        const artifacts = await listArtifacts(
          context.bindings,
          threadId,
          data.folder === undefined ? {} : { folder: data.folder.trim() },
        );
        return {
          output: {
            artifacts: artifacts.map(listing),
            people: await mentionablePeople(context.db, threadId),
            ...(artifacts.length === 0
              ? { note: "This Thread has no artifacts yet." }
              : { note: UNTRUSTED_NOTE }),
          },
        };
      }

      const artifactId =
        data.action === "create"
          ? undefined
          : need(data.artifact_id, "artifact_id");

      if (data.action === "read") {
        const current = await readArtifact(
          context.bindings,
          threadId,
          artifactId as string,
        );
        if (current === undefined)
          throw new Error(
            `Artifact ${artifactId} was not found in this Thread.`,
          );
        const comments =
          (await listArtifactComments(
            context.bindings,
            threadId,
            current.artifact.id,
          )) ?? [];
        const edited = await editedByPeopleSince(context, threadId, current);
        return {
          output: {
            artifact_id: current.artifact.id,
            title: current.artifact.title,
            folder: current.artifact.folder,
            revision: current.artifact.revision,
            last_saved_by: authorName(current.artifact.updatedBy),
            ...pageArtifact(current.markdown, data.start_line, data.end_line),
            ...commentView(comments, current.markdown),
            ...(edited === undefined ? {} : { edited_by_people_since: edited }),
            note: UNTRUSTED_NOTE,
          },
        };
      }

      if (data.action === "delete") {
        const current = await readArtifact(
          context.bindings,
          threadId,
          artifactId as string,
        );
        if (current === undefined)
          throw new Error(
            `Artifact ${artifactId} was not found in this Thread.`,
          );
        return {
          output: {
            pending_confirmation: true,
            artifact_id: current.artifact.id,
            title: current.artifact.title,
            revision: current.artifact.revision,
            note: "Nothing is deleted yet. The user sees a card to confirm the delete. Tell them it is waiting for their confirmation, and do not ask again.",
          },
        };
      }

      if (data.edits !== undefined && data.markdown !== undefined)
        throw new Error("Pass edits or markdown, not both.");

      let saved: ArtifactWithMarkdown;
      /** The Markdown a save replaced; unset when nothing was saved. */
      let previous: string | undefined;
      if (data.action === "create") {
        const result = await createArtifact(context.bindings, {
          threadId,
          title: need(data.title, "title"),
          markdown: need(data.markdown, "markdown"),
          ...(data.folder === undefined ? {} : { folder: data.folder }),
          writer,
        });
        saved = settle(result);
        previous = "";
      } else {
        const current = await readArtifact(
          context.bindings,
          threadId,
          artifactId as string,
        );
        if (current === undefined)
          throw new Error(
            `Artifact ${artifactId} was not found in this Thread.`,
          );
        const base = need(data.base_revision, "base_revision");
        const rewrites =
          data.edits !== undefined ||
          data.markdown !== undefined ||
          data.title !== undefined ||
          data.folder !== undefined;
        if (!rewrites && (data.comments ?? []).length === 0)
          throw new Error(
            "update needs edits, markdown, comments, title, or folder.",
          );
        // Comments alone save no revision.
        saved = current;
        if (rewrites) {
          if (data.force !== true && current.artifact.revision !== base)
            return conflictOutput(current, base);
          let markdown = data.markdown ?? current.markdown;
          if (data.edits !== undefined) {
            const applied = applyArtifactEdits(current.markdown, data.edits);
            if (!applied.ok) throw new Error(applied.message);
            markdown = applied.markdown;
          }
          const result = await saveArtifact(context.bindings, {
            threadId,
            artifactId: current.artifact.id,
            baseRevision: current.artifact.revision,
            markdown,
            ...(data.title === undefined ? {} : { title: data.title }),
            ...(data.folder === undefined ? {} : { folder: data.folder }),
            ...(data.force === true ? { force: true } : {}),
            writer,
          });
          if (result.kind === "conflict")
            return conflictOutput(result.current, base);
          saved = settle(result);
          if (result.kind === "saved") previous = result.previous;
        }
      }

      const commentResults = await applyCommentOperations(
        context,
        threadId,
        saved.artifact.id,
        data.comments ?? [],
        writer,
      );
      await changed();
      if (previous !== undefined) {
        // Mentions the agent wrote notify their people; asks it wrote are
        // indexed. An agent's own save never wakes its Thread.
        const effects = artifactSaved(
          context.bindings,
          {
            threadId,
            artifactId: saved.artifact.id,
            title: saved.artifact.title,
            revision: saved.artifact.revision,
            before: previous,
            after: saved.markdown,
            writer,
          },
          context.waitUntil === undefined
            ? {}
            : { waitUntil: context.waitUntil },
        );
        if (context.waitUntil === undefined) await effects;
        else context.waitUntil(effects);
      }
      return {
        output: {
          saved: true,
          artifact_id: saved.artifact.id,
          title: saved.artifact.title,
          folder: saved.artifact.folder,
          revision: saved.artifact.revision,
          size_bytes: saved.artifact.sizeBytes,
          ...(commentResults.length === 0 ? {} : { comments: commentResults }),
        },
      };
    },
  }),
];

const settle = (
  result: Awaited<ReturnType<typeof createArtifact>>,
): ArtifactWithMarkdown => {
  switch (result.kind) {
    case "saved":
      return result.value;
    case "not-found":
      throw new Error("That artifact is not in this Thread.");
    case "invalid":
      throw new Error(result.message);
    case "too-large":
      throw new Error(
        `The artifact would be ${result.sizeBytes} bytes; an artifact holds at most ${ARTIFACT_MAX_BYTES} bytes. Nothing was saved.`,
      );
    case "storage-full":
      throw new Error(
        "This Thread's artifacts are full. Ask the user to delete artifacts they no longer need. Nothing was saved.",
      );
    case "conflict":
      throw new Error("The artifact changed. Read it again and retry.");
  }
};

/** A refused update: the current Markdown to merge into, bounded. */
const conflictOutput = (current: ArtifactWithMarkdown, base: number) => ({
  output: {
    saved: false,
    error: "ARTIFACT_CONFLICT",
    message: `Nothing was saved: the artifact is at revision ${current.artifact.revision}, newer than base_revision ${base}. Merge your change into the current Markdown below, keeping other people's changes, and update again with base_revision ${current.artifact.revision}.`,
    artifact_id: current.artifact.id,
    revision: current.artifact.revision,
    last_saved_by: authorName(current.artifact.updatedBy),
    ...(current.markdown.length <= CONFLICT_MARKDOWN_CHARS
      ? { markdown: current.markdown }
      : {
          ...pageArtifact(current.markdown),
          note_on_length:
            "The artifact is long: this is its start. Read other parts with start_line and end_line before merging.",
        }),
    note: UNTRUSTED_NOTE,
  },
});

const applyCommentOperations = async (
  context: ThreadToolsContext,
  threadId: string,
  artifactId: string,
  operations: ReadonlyArray<v.InferOutput<typeof commentOperation>>,
  writer: ArtifactWriter,
) => {
  const results: Array<Record<string, unknown>> = [];
  for (const [index, operation] of operations.entries()) {
    const kinds = [operation.add, operation.reply, operation.resolve].filter(
      (value) => value !== undefined,
    );
    if (kinds.length !== 1) {
      results.push({
        index,
        error:
          "Each comment operation is exactly one of add, reply, or resolve.",
      });
      continue;
    }
    const result =
      operation.add !== undefined
        ? await addArtifactComment(context.bindings, {
            threadId,
            artifactId,
            quote: operation.add.quote,
            body: operation.add.text,
            writer,
          })
        : operation.reply !== undefined
          ? await addArtifactComment(context.bindings, {
              threadId,
              artifactId,
              parentId: operation.reply.comment_id,
              body: operation.reply.text,
              writer,
            })
          : await resolveArtifactComment(context.bindings, {
              threadId,
              artifactId,
              commentId: operation.resolve?.comment_id ?? "",
            });
    if (result.kind === "saved" && operation.resolve === undefined) {
      // People the agent's comment mentions are notified.
      const effects = artifactCommented(context.bindings, {
        threadId,
        artifactId,
        commentId: result.comment.id,
        quote: result.comment.quote,
        body: result.comment.body,
        writer,
      });
      if (context.waitUntil === undefined) await effects;
      else context.waitUntil(effects);
    }
    results.push(
      result.kind === "saved"
        ? {
            index,
            comment_id: result.comment.id,
            ...(operation.resolve === undefined ? {} : { resolved: true }),
          }
        : {
            index,
            error:
              result.kind === "quote-not-found"
                ? "The quote is not in the artifact's current text."
                : result.kind === "comment-not-found"
                  ? "No such comment on this artifact."
                  : result.kind === "limit"
                    ? "This artifact holds as many comments as it can."
                    : result.kind === "invalid"
                      ? result.message
                      : "The artifact was not found.",
          },
    );
  }
  return results;
};
