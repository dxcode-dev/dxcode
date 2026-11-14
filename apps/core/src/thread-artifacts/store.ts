import {
  ARTIFACT_FOLDER_MAX_LENGTH,
  ARTIFACT_ID_PATTERN,
  ARTIFACT_KINDS,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_RECENT_REVISIONS_KEPT,
  ARTIFACT_TITLE_MAX_LENGTH,
  THREAD_ARTIFACT_MAX_STORED_BYTES,
  type ThreadArtifact,
  type ThreadArtifactAudience,
  type ThreadArtifactAuthor,
  type ThreadArtifactKind,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { moveQuote } from "./anchors.js";
import { artifactKind } from "./kinds.js";

/**
 * Artifacts: one D1 row per artifact, one D1 row per kept revision, and each
 * revision's Markdown as an immutable R2 object. The routes (people) and the
 * agent's tool both write through here, so the compare-and-swap, the size
 * limits, and the retention rule hold for both.
 *
 * An artifact lives in a Thread (`threadId`) or stands alone, owned by a
 * person with no Thread: every function names where with `threadId`, a
 * Thread's id or `null` for a standalone artifact. A standalone artifact is
 * found by its own id alone; who may open it is decided before these run
 * (artifact-library/access.ts).
 */

export type ArtifactBindings = Pick<Bindings, "DB" | "DX_STORAGE">;

/** Who is saving: a person (the real actor, not the owner they act as), or the agent. */
export type ArtifactWriter =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "agent"; readonly submissionId?: string };

/** A Thread's id, or `null` for a standalone artifact. */
export type ArtifactThreadId = string | null;

export interface ArtifactRow {
  readonly id: string;
  readonly thread_id: string | null;
  readonly owner_user_id: string | null;
  readonly shared_workspace_id: string | null;
  readonly workspace_access: "none" | "view" | "edit";
  readonly kind: ThreadArtifactKind;
  readonly folder: string;
  readonly title: string;
  readonly current_revision: number;
  readonly size_bytes: number;
  readonly stored_bytes: number;
  readonly created_by_kind: "user" | "agent";
  readonly created_by_user_id: string | null;
  readonly audience: ThreadArtifactAudience;
  readonly created_at: number;
  readonly updated_at: number;
  readonly deleted_at: number | null;
}

interface ArtifactListRow extends ArtifactRow {
  readonly created_by_name: string | null;
  readonly updated_by_kind: "user" | "agent" | null;
  readonly updated_by_user_id: string | null;
  readonly updated_by_name: string | null;
  readonly sha256: string | null;
  readonly open_comment_count: number;
}

export interface RevisionRow {
  readonly artifact_id: string;
  readonly revision: number;
  readonly base_revision: number | null;
  readonly author_kind: "user" | "agent";
  readonly author_user_id: string | null;
  readonly author_name?: string | null;
  readonly submission_id: string | null;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly created_at: number;
}

export interface ArtifactWithMarkdown {
  readonly artifact: ThreadArtifact;
  readonly markdown: string;
}

export class ArtifactsUnavailableError extends Error {
  override readonly name = "ArtifactsUnavailableError";
}

const bindingsOf = (bindings: ArtifactBindings) => {
  if (bindings.DB === undefined || bindings.DX_STORAGE === undefined)
    throw new ArtifactsUnavailableError("Artifacts are not configured.");
  return { db: bindings.DB, bucket: bindings.DX_STORAGE };
};

export const newArtifactId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `art_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
};

export const isArtifactId = (value: string | undefined | null) =>
  typeof value === "string" && ARTIFACT_ID_PATTERN.test(value);

export const artifactThreadPrefix = (threadId: string) =>
  `thread-artifacts/${threadId}/`;

/** Everything a standalone artifact stores: its bodies and its images. */
export const standaloneArtifactPrefix = (artifactId: string) =>
  `standalone-artifacts/${artifactId}/`;

/** Where a standalone artifact's image is stored. */
export const standaloneArtifactImageKey = (
  artifactId: string,
  imageId: string,
  name: string,
) => `${standaloneArtifactPrefix(artifactId)}images/${imageId}/${name}`;

export const artifactRevisionKey = (
  threadId: ArtifactThreadId,
  artifactId: string,
  revision: number,
  sha256: string,
) =>
  threadId === null
    ? `${standaloneArtifactPrefix(artifactId)}${revision}-${sha256}.md`
    : `${artifactThreadPrefix(threadId)}${artifactId}/${revision}-${sha256}.md`;

const encoder = new TextEncoder();

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

/** A title is one trimmed line; `undefined` when nothing is left. */
export const normalizeArtifactTitle = (title: string) => {
  const line = title.replace(/\s+/g, " ").trim();
  return line.length === 0 || line.length > ARTIFACT_TITLE_MAX_LENGTH
    ? undefined
    : line;
};

/**
 * A folder is `''` (the top level) or one trimmed name, one level deep: no
 * `/`, and not `.` or `..`. `undefined` when the input cannot be one.
 */
export const normalizeArtifactFolder = (folder: string) => {
  const name = folder.replace(/\s+/g, " ").trim();
  return name.includes("/") ||
    name === "." ||
    name === ".." ||
    name.length > ARTIFACT_FOLDER_MAX_LENGTH
    ? undefined
    : name;
};

// Revision bodies never change, so an isolate keeps the recent ones by
// (artifact, revision, sha256): a read after the agent's own save, or the
// agent reading the same revision again, skips R2.
const BODY_CACHE_BYTES = 8 * 1024 * 1024;
const bodyCache = new Map<string, { markdown: string; size: number }>();
let bodyCacheBytes = 0;

const rememberBody = (key: string, markdown: string, size: number) => {
  if (size > BODY_CACHE_BYTES / 4) return;
  const previous = bodyCache.get(key);
  if (previous !== undefined) {
    bodyCache.delete(key);
    bodyCacheBytes -= previous.size;
  }
  bodyCache.set(key, { markdown, size });
  bodyCacheBytes += size;
  for (const [oldest, body] of bodyCache) {
    if (bodyCacheBytes <= BODY_CACHE_BYTES) break;
    bodyCache.delete(oldest);
    bodyCacheBytes -= body.size;
  }
};

const readBody = async (
  bucket: R2Bucket,
  threadId: ArtifactThreadId,
  revision: Pick<
    RevisionRow,
    "artifact_id" | "revision" | "sha256" | "size_bytes"
  >,
) => {
  const key = artifactRevisionKey(
    threadId,
    revision.artifact_id,
    revision.revision,
    revision.sha256,
  );
  const cached = bodyCache.get(key);
  if (cached !== undefined) return cached.markdown;
  const object = await bucket.get(key);
  if (object === null)
    throw new ArtifactsUnavailableError(
      `Artifact revision body ${revision.artifact_id}@${revision.revision} is missing.`,
    );
  const markdown = await object.text();
  rememberBody(key, markdown, revision.size_bytes);
  return markdown;
};

const author = (
  kind: "user" | "agent" | null,
  userId: string | null,
  name: string | null | undefined,
): ThreadArtifactAuthor =>
  kind === "user"
    ? { kind: "user", userId, name: name ?? null }
    : { kind: "agent" };

const artifactData = (row: ArtifactListRow): ThreadArtifact => ({
  id: row.id,
  threadId: row.thread_id as ThreadId | null,
  kind: row.kind,
  folder: row.folder,
  title: row.title,
  revision: row.current_revision,
  sizeBytes: row.size_bytes,
  createdBy: author(
    row.created_by_kind,
    row.created_by_user_id,
    row.created_by_name,
  ),
  updatedBy: author(
    row.updated_by_kind,
    row.updated_by_user_id,
    row.updated_by_name,
  ),
  openCommentCount: row.open_comment_count,
  ...(row.audience === "agent" ? { audience: "agent" as const } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Each artifact with who created it and who saved its current revision. */
const SELECT_ARTIFACT = `
  SELECT artifact.*,
         creator.name AS created_by_name,
         current.author_kind AS updated_by_kind,
         current.author_user_id AS updated_by_user_id,
         saver.name AS updated_by_name,
         current.sha256 AS sha256,
         (SELECT count(*) FROM thread_artifact_comment AS comment
           WHERE comment.artifact_id = artifact.id
             AND comment.parent_id IS NULL
             AND comment.resolved_at IS NULL) AS open_comment_count
    FROM thread_artifact AS artifact
    LEFT JOIN thread_artifact_revision AS current
      ON current.artifact_id = artifact.id
     AND current.revision = artifact.current_revision
    LEFT JOIN "user" AS creator ON creator.id = artifact.created_by_user_id
    LEFT JOIN "user" AS saver ON saver.id = current.author_user_id`;

/**
 * The Thread's artifacts, most recently saved first; only one folder's
 * (`''` for the top level) when `folder` is given.
 */
export const listArtifacts = async (
  bindings: ArtifactBindings,
  threadId: string,
  options: { readonly folder?: string; readonly limit?: number } = {},
): Promise<ReadonlyArray<ThreadArtifact>> => {
  const { db } = bindingsOf(bindings);
  const { results } = await db
    .prepare(
      `${SELECT_ARTIFACT}
        WHERE artifact.thread_id = ?1 AND artifact.deleted_at IS NULL
          AND (?3 IS NULL OR artifact.folder = ?3)
        ORDER BY artifact.updated_at DESC, artifact.id
        LIMIT ?2`,
    )
    .bind(threadId, options.limit ?? 500, options.folder ?? null)
    .all<ArtifactListRow>();
  return results.map(artifactData);
};

const findArtifact = (
  db: D1Database,
  threadId: ArtifactThreadId,
  artifactId: string,
) =>
  db
    .prepare(
      `${SELECT_ARTIFACT}
        WHERE artifact.id = ?1 AND artifact.thread_id IS ?2
          AND artifact.deleted_at IS NULL`,
    )
    .bind(artifactId, threadId)
    .first<ArtifactListRow>();

const withMarkdown = async (
  bucket: R2Bucket,
  row: ArtifactListRow,
): Promise<ArtifactWithMarkdown> => {
  if (row.sha256 === null)
    throw new ArtifactsUnavailableError(
      `Artifact ${row.id} has no current revision row.`,
    );
  return {
    artifact: artifactData(row),
    markdown: await readBody(bucket, row.thread_id, {
      artifact_id: row.id,
      revision: row.current_revision,
      sha256: row.sha256,
      size_bytes: row.size_bytes,
    }),
  };
};

/** The artifact and its current Markdown; undefined when it is not this Thread's. */
export const readArtifact = async (
  bindings: ArtifactBindings,
  threadId: ArtifactThreadId,
  artifactId: string,
): Promise<ArtifactWithMarkdown | undefined> => {
  const { db, bucket } = bindingsOf(bindings);
  if (!isArtifactId(artifactId)) return undefined;
  const row = await findArtifact(db, threadId, artifactId);
  return row === null ? undefined : withMarkdown(bucket, row);
};

export interface ArtifactRevision {
  readonly row: RevisionRow;
  readonly markdown: string;
}

/** One kept revision of a live artifact of this Thread. */
export const readArtifactRevision = async (
  bindings: ArtifactBindings,
  threadId: ArtifactThreadId,
  artifactId: string,
  revision: number,
): Promise<ArtifactRevision | undefined> => {
  const { db, bucket } = bindingsOf(bindings);
  if (!isArtifactId(artifactId)) return undefined;
  const row = await db
    .prepare(
      `SELECT revision.*, person.name AS author_name
         FROM thread_artifact_revision AS revision
         JOIN thread_artifact AS artifact ON artifact.id = revision.artifact_id
         LEFT JOIN "user" AS person ON person.id = revision.author_user_id
        WHERE revision.artifact_id = ?1 AND revision.revision = ?2
          AND artifact.thread_id IS ?3 AND artifact.deleted_at IS NULL`,
    )
    .bind(artifactId, revision, threadId)
    .first<RevisionRow>();
  if (row === null) return undefined;
  return { row, markdown: await readBody(bucket, threadId, row) };
};

export const revisionAuthor = (row: RevisionRow): ThreadArtifactAuthor =>
  author(row.author_kind, row.author_user_id, row.author_name);

const FOLDER_MESSAGE = `A folder is one name of at most ${ARTIFACT_FOLDER_MAX_LENGTH} characters, without "/": folders are one level deep.`;

export type ArtifactWriteResult =
  | {
      readonly kind: "saved";
      readonly value: ArtifactWithMarkdown;
      /** The Markdown this save replaced; `''` for a new artifact. */
      readonly previous: string;
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "too-large"; readonly sizeBytes: number }
  | { readonly kind: "storage-full"; readonly storedBytes: number }
  | { readonly kind: "conflict"; readonly current: ArtifactWithMarkdown };

const prepareBody = async (markdown: string) => {
  const bytes = encoder.encode(markdown);
  return { bytes, sha256: await sha256Hex(bytes) };
};

/**
 * What counts against the storage limit: every artifact of the Thread, or a
 * standalone artifact's own revisions.
 */
const storedBytes = async (
  db: D1Database,
  threadId: ArtifactThreadId,
  artifactId: string,
) =>
  (await db
    .prepare(
      threadId === null
        ? "SELECT stored_bytes AS bytes FROM thread_artifact WHERE id = ?"
        : "SELECT COALESCE(SUM(stored_bytes), 0) AS bytes FROM thread_artifact WHERE thread_id = ?",
    )
    .bind(threadId ?? artifactId)
    .first<number>("bytes")) ?? 0;

const putBody = (
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  sha256: string,
  kind: ThreadArtifactKind,
) =>
  bucket.put(key, bytes, {
    httpMetadata: { contentType: artifactKind(kind).contentType },
    sha256,
  });

const writerColumns = (writer: ArtifactWriter) =>
  writer.kind === "user"
    ? { kind: "user" as const, userId: writer.userId, submissionId: null }
    : {
        kind: "agent" as const,
        userId: null,
        submissionId: writer.submissionId?.slice(0, 128) ?? null,
      };

/**
 * Creates an artifact at revision 1 in a live Thread, or, with `threadId`
 * null, a standalone artifact private to `ownerUserId`.
 */
export const createArtifact = async (
  bindings: ArtifactBindings,
  input: {
    readonly threadId: ArtifactThreadId;
    /** The owner of a standalone artifact; required when `threadId` is null. */
    readonly ownerUserId?: string;
    readonly title: string;
    readonly folder?: string;
    /** `document` when left out. */
    readonly kind?: ThreadArtifactKind;
    /** `people` when left out; `agent` for the agent's own notes. */
    readonly audience?: ThreadArtifactAudience;
    readonly markdown: string;
    readonly writer: ArtifactWriter;
    readonly now?: number;
  },
): Promise<ArtifactWriteResult> => {
  const { db, bucket } = bindingsOf(bindings);
  const kind = input.kind ?? "document";
  const handler = artifactKind(kind);
  const checked = handler.check(
    input.markdown === "" ? handler.emptyBody() : input.markdown,
  );
  if (!checked.ok) return { kind: "invalid", message: checked.message };
  const body = checked.body;
  const title = normalizeArtifactTitle(input.title);
  if (title === undefined)
    return {
      kind: "invalid",
      message: `A title is one line of 1 to ${ARTIFACT_TITLE_MAX_LENGTH} characters.`,
    };
  const folder = normalizeArtifactFolder(input.folder ?? "");
  if (folder === undefined) return { kind: "invalid", message: FOLDER_MESSAGE };
  const { bytes, sha256 } = await prepareBody(body);
  if (bytes.byteLength > ARTIFACT_MAX_BYTES)
    return { kind: "too-large", sizeBytes: bytes.byteLength };
  if (input.threadId === null && input.ownerUserId === undefined)
    return { kind: "not-found" };
  const stored =
    input.threadId === null ? 0 : await storedBytes(db, input.threadId, "");
  if (stored + bytes.byteLength > THREAD_ARTIFACT_MAX_STORED_BYTES)
    return { kind: "storage-full", storedBytes: stored };
  const id = newArtifactId();
  const now = input.now ?? Date.now();
  const key = artifactRevisionKey(input.threadId, id, 1, sha256);
  const writer = writerColumns(input.writer);
  // The body first: a row never points at a missing object.
  await putBody(bucket, key, bytes, sha256, kind);
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO thread_artifact
           (id, thread_id, owner_user_id, folder, title, current_revision,
            size_bytes, stored_bytes, created_by_kind, created_by_user_id,
            created_at, updated_at, deleted_at, kind, audience)
         SELECT ?1, ?2, ?10, ?3, ?4, 1, ?5, ?5, ?6, ?7, ?8, ?8, NULL, ?9, ?11
          WHERE ?2 IS NULL OR EXISTS (
            SELECT 1 FROM threads WHERE id = ?2 AND lifecycle_state != 'deleted'
          )`,
      )
      .bind(
        id,
        input.threadId,
        folder,
        title,
        bytes.byteLength,
        writer.kind,
        writer.userId,
        now,
        kind,
        input.threadId === null ? (input.ownerUserId ?? null) : null,
        input.audience ?? "people",
      ),
    db
      .prepare(
        `INSERT INTO thread_artifact_revision
           (artifact_id, revision, base_revision, author_kind, author_user_id,
            submission_id, sha256, size_bytes, created_at)
         SELECT ?1, 1, NULL, ?2, ?3, ?4, ?5, ?6, ?7 WHERE changes() = 1`,
      )
      .bind(
        id,
        writer.kind,
        writer.userId,
        writer.submissionId,
        sha256,
        bytes.byteLength,
        now,
      ),
  ]);
  if (inserted?.meta.changes !== 1) {
    await bucket.delete(key);
    return { kind: "not-found" };
  }
  const row = await findArtifact(db, input.threadId, id);
  if (row === null) return { kind: "not-found" };
  rememberBody(key, body, bytes.byteLength);
  return {
    kind: "saved",
    value: await withMarkdown(bucket, row),
    previous: "",
  };
};

/**
 * Saves a new revision made from `baseRevision`. When the artifact has moved
 * past it, nothing is written and the result carries the newer revision; a
 * save never overwrites a revision its writer has not seen, unless `force`
 * asks it to replace whatever is current. Open comments move to where their
 * quoted text is in the new revision, in the same transaction.
 */
export const saveArtifact = async (
  bindings: ArtifactBindings,
  input: {
    readonly threadId: ArtifactThreadId;
    readonly artifactId: string;
    readonly baseRevision: number;
    readonly markdown: string;
    readonly title?: string;
    readonly folder?: string;
    /** Moves it between people's lists and the agent's own notes. */
    readonly audience?: ThreadArtifactAudience;
    readonly force?: boolean;
    readonly writer: ArtifactWriter;
    readonly now?: number;
  },
): Promise<ArtifactWriteResult> => {
  const { db, bucket } = bindingsOf(bindings);
  if (!isArtifactId(input.artifactId)) return { kind: "not-found" };
  const title =
    input.title === undefined ? undefined : normalizeArtifactTitle(input.title);
  if (input.title !== undefined && title === undefined)
    return {
      kind: "invalid",
      message: `A title is one line of 1 to ${ARTIFACT_TITLE_MAX_LENGTH} characters.`,
    };
  const folder =
    input.folder === undefined
      ? undefined
      : normalizeArtifactFolder(input.folder);
  if (input.folder !== undefined && folder === undefined)
    return { kind: "invalid", message: FOLDER_MESSAGE };
  const existing = await findArtifact(db, input.threadId, input.artifactId);
  if (existing === null) return { kind: "not-found" };
  const handler = artifactKind(existing.kind);
  const checked = handler.check(input.markdown);
  if (!checked.ok) return { kind: "invalid", message: checked.message };
  const markdown = checked.body;
  const { bytes, sha256 } = await prepareBody(markdown);
  if (bytes.byteLength > ARTIFACT_MAX_BYTES)
    return { kind: "too-large", sizeBytes: bytes.byteLength };
  const writer = writerColumns(input.writer);
  // A forced save retries when another save lands between its read and its
  // write; an ordinary one reports that save as the conflict.
  for (let attempt = 0; ; attempt++) {
    const current =
      attempt === 0
        ? existing
        : await findArtifact(db, input.threadId, input.artifactId);
    if (current === null) return { kind: "not-found" };
    if (input.force !== true && current.current_revision !== input.baseRevision)
      return { kind: "conflict", current: await withMarkdown(bucket, current) };
    const stored = await storedBytes(db, input.threadId, input.artifactId);
    if (stored + bytes.byteLength > THREAD_ARTIFACT_MAX_STORED_BYTES)
      return { kind: "storage-full", storedBytes: stored };
    const base = current.current_revision;
    const revision = base + 1;
    const now = Math.max(input.now ?? Date.now(), current.updated_at);
    const key = artifactRevisionKey(
      input.threadId,
      input.artifactId,
      revision,
      sha256,
    );
    const previous = (await withMarkdown(bucket, current)).markdown;
    const anchors =
      handler.comments === "quote"
        ? await moveCommentAnchors(db, current, previous, markdown)
        : [];
    await putBody(bucket, key, bytes, sha256, current.kind);
    // One transaction: the artifact moves only from `base`, the revision row
    // is written only when it did, and comments move only onto that row.
    const [moved] = await db.batch([
      db
        .prepare(
          `UPDATE thread_artifact
              SET current_revision = ?3, size_bytes = ?4,
                  stored_bytes = stored_bytes + ?4,
                  title = COALESCE(?5, title), folder = COALESCE(?6, folder),
                  audience = COALESCE(?9, audience), updated_at = ?7
            WHERE id = ?1 AND thread_id IS ?2 AND current_revision = ?8
              AND deleted_at IS NULL`,
        )
        .bind(
          input.artifactId,
          input.threadId,
          revision,
          bytes.byteLength,
          title ?? null,
          folder ?? null,
          now,
          base,
          input.audience ?? null,
        ),
      db
        .prepare(
          `INSERT INTO thread_artifact_revision
             (artifact_id, revision, base_revision, author_kind, author_user_id,
              submission_id, sha256, size_bytes, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE changes() = 1`,
        )
        .bind(
          input.artifactId,
          revision,
          base,
          writer.kind,
          writer.userId,
          writer.submissionId,
          sha256,
          bytes.byteLength,
          now,
        ),
      ...(anchors.length === 0
        ? []
        : [
            db
              .prepare(
                `UPDATE thread_artifact_comment
                    SET anchor_revision = CASE
                          WHEN (SELECT json_extract(value, '$.start') FROM json_each(?2)
                                 WHERE json_extract(value, '$.id') = thread_artifact_comment.id)
                               IS NULL THEN NULL ELSE ?3 END,
                        anchor_start = (SELECT json_extract(value, '$.start') FROM json_each(?2)
                                         WHERE json_extract(value, '$.id') = thread_artifact_comment.id),
                        anchor_end = (SELECT json_extract(value, '$.end') FROM json_each(?2)
                                       WHERE json_extract(value, '$.id') = thread_artifact_comment.id)
                  WHERE artifact_id = ?1
                    AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?2))
                    AND EXISTS (
                      SELECT 1 FROM thread_artifact_revision
                       WHERE artifact_id = ?1 AND revision = ?3 AND sha256 = ?4
                         AND created_at = ?5
                    )`,
              )
              .bind(
                input.artifactId,
                JSON.stringify(anchors),
                revision,
                sha256,
                now,
              ),
          ]),
    ]);
    if (moved?.meta.changes === 1) {
      rememberBody(key, markdown, bytes.byteLength);
      await compactArtifactRevisions(
        bindings,
        input.threadId,
        input.artifactId,
      );
      const saved = await findArtifact(db, input.threadId, input.artifactId);
      if (saved === null) return { kind: "not-found" };
      return {
        kind: "saved",
        value: await withMarkdown(bucket, saved),
        previous,
      };
    }
    // Another save won. Its body has another key unless it is the same
    // Markdown, which this request must then leave in place.
    if (!(await revisionExists(db, input.artifactId, revision, sha256)))
      await bucket.delete(key);
    if (input.force === true && attempt < 3) continue;
    const latest = await findArtifact(db, input.threadId, input.artifactId);
    if (latest === null) return { kind: "not-found" };
    return { kind: "conflict", current: await withMarkdown(bucket, latest) };
  }
};

/**
 * Where each open top-level comment's quote is in `markdown`: the occurrence
 * nearest its last anchor, or null start and end when the text is gone.
 */
const moveCommentAnchors = async (
  db: D1Database,
  current: ArtifactListRow,
  before: string,
  markdown: string,
) => {
  const { results } = await db
    .prepare(
      `SELECT id, quote, anchor_revision, anchor_start
         FROM thread_artifact_comment
        WHERE artifact_id = ? AND parent_id IS NULL AND resolved_at IS NULL`,
    )
    .bind(current.id)
    .all<{
      id: string;
      quote: string;
      anchor_revision: number | null;
      anchor_start: number | null;
    }>();
  if (results.length === 0) return [];
  return results.map((comment) => {
    // An anchor into the revision being replaced maps through the edit;
    // an older one only hints where to look.
    const found = moveQuote(
      comment.anchor_revision === current.current_revision ? before : undefined,
      markdown,
      comment.quote,
      comment.anchor_start,
    );
    return {
      id: comment.id,
      start: found?.start ?? null,
      end: found?.end ?? null,
    };
  });
};

const revisionExists = async (
  db: D1Database,
  artifactId: string,
  revision: number,
  sha256: string,
) =>
  (await db
    .prepare(
      `SELECT 1 AS found FROM thread_artifact_revision
        WHERE artifact_id = ? AND revision = ? AND sha256 = ?`,
    )
    .bind(artifactId, revision, sha256)
    .first<number>("found")) === 1;

/**
 * The retention rule: keep the newest `ARTIFACT_RECENT_REVISIONS_KEPT`
 * revisions, every revision a person saved (for types that keep them; a
 * board saves after every gesture and does not), and the agent's newest;
 * remove the rest, bodies first so a failure leaves rows a later save
 * retries.
 */
export const compactArtifactRevisions = async (
  bindings: ArtifactBindings,
  threadId: ArtifactThreadId,
  artifactId: string,
) => {
  const { db, bucket } = bindingsOf(bindings);
  const { results } = await db
    .prepare(
      `SELECT revision.revision, revision.sha256
         FROM thread_artifact_revision AS revision
         JOIN thread_artifact AS artifact ON artifact.id = revision.artifact_id
        WHERE revision.artifact_id = ?1 AND artifact.thread_id IS ?2
          AND (revision.author_kind = 'agent' OR artifact.kind IN (
            SELECT value FROM json_each(?4)
          ))
          AND revision.revision <= artifact.current_revision - ?3
          AND (revision.author_kind != 'agent' OR revision.revision < (
            SELECT MAX(newest.revision) FROM thread_artifact_revision AS newest
             WHERE newest.artifact_id = ?1 AND newest.author_kind = 'agent'
          ))
        ORDER BY revision.revision
        LIMIT 100`,
    )
    .bind(
      artifactId,
      threadId,
      ARTIFACT_RECENT_REVISIONS_KEPT,
      JSON.stringify(
        ARTIFACT_KINDS.filter(
          (kind) => !artifactKind(kind).keepsEveryPersonRevision,
        ),
      ),
    )
    .all<{ revision: number; sha256: string }>();
  if (results.length === 0) return 0;
  await bucket.delete(
    results.map(({ revision, sha256 }) =>
      artifactRevisionKey(threadId, artifactId, revision, sha256),
    ),
  );
  await db.batch([
    db
      .prepare(
        `DELETE FROM thread_artifact_revision
          WHERE artifact_id = ?1 AND revision IN (SELECT value FROM json_each(?2))`,
      )
      .bind(
        artifactId,
        JSON.stringify(results.map(({ revision }) => revision)),
      ),
    restoreStoredBytes(db, artifactId),
  ]);
  return results.length;
};

const restoreStoredBytes = (db: D1Database, artifactId: string) =>
  db
    .prepare(
      `UPDATE thread_artifact
          SET stored_bytes = (
            SELECT COALESCE(SUM(size_bytes), 0) FROM thread_artifact_revision
             WHERE artifact_id = ?1
          )
        WHERE id = ?1`,
    )
    .bind(artifactId);

/**
 * Removes a deleted artifact's revisions and bodies, and a standalone one's
 * images; its row stays, marked deleted. Idempotent: bodies go first, so a
 * retry finds the rows again.
 */
const purgeArtifactBodies = async (
  bindings: ArtifactBindings,
  threadId: ArtifactThreadId,
  artifactId: string,
) => {
  const { db, bucket } = bindingsOf(bindings);
  for (;;) {
    const { results } = await db
      .prepare(
        `SELECT revision, sha256 FROM thread_artifact_revision
          WHERE artifact_id = ? LIMIT 500`,
      )
      .bind(artifactId)
      .all<{ revision: number; sha256: string }>();
    if (results.length > 0) {
      await bucket.delete(
        results.map(({ revision, sha256 }) =>
          artifactRevisionKey(threadId, artifactId, revision, sha256),
        ),
      );
      await db
        .prepare(
          `DELETE FROM thread_artifact_revision
            WHERE artifact_id = ?1 AND revision IN (SELECT value FROM json_each(?2))`,
        )
        .bind(
          artifactId,
          JSON.stringify(results.map(({ revision }) => revision)),
        )
        .run();
    }
    if (results.length < 500) break;
  }
  if (threadId === null)
    await deletePrefix(bucket, standaloneArtifactPrefix(artifactId));
  await db.batch([
    db
      .prepare("DELETE FROM thread_artifact_comment WHERE artifact_id = ?")
      .bind(artifactId),
    db
      .prepare("DELETE FROM thread_artifact_ask WHERE artifact_id = ?")
      .bind(artifactId),
    restoreStoredBytes(db, artifactId),
  ]);
};

/**
 * Deletes an artifact of this Thread: no one reads or saves it again, and
 * its revisions and bodies go. False when the Thread has no such artifact.
 */
export const deleteArtifact = async (
  bindings: ArtifactBindings,
  threadId: ArtifactThreadId,
  artifactId: string,
  now = Date.now(),
) => {
  const { db } = bindingsOf(bindings);
  if (!isArtifactId(artifactId)) return false;
  const row = await db
    .prepare(
      `UPDATE thread_artifact SET deleted_at = COALESCE(deleted_at, ?3)
        WHERE id = ?1 AND thread_id IS ?2
        RETURNING id`,
    )
    .bind(artifactId, threadId, now)
    .first<{ id: string }>();
  if (row === null) return false;
  await purgeArtifactBodies(bindings, threadId, artifactId);
  return true;
};

/**
 * The cron sweep: bodies of deleted artifacts that are still stored, such as
 * those of an account's Threads after the account was deleted, or a delete
 * whose purge failed. Returns how many artifacts it emptied.
 */
export const sweepDeletedArtifacts = async (
  bindings: ArtifactBindings,
  limit = 50,
) => {
  if (bindings.DB === undefined || bindings.DX_STORAGE === undefined) return 0;
  const { results } = await bindings.DB.prepare(
    `SELECT id, thread_id FROM thread_artifact
      WHERE deleted_at IS NOT NULL AND stored_bytes > 0
      ORDER BY deleted_at LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string; thread_id: string | null }>();
  for (const { id, thread_id } of results)
    await purgeArtifactBodies(bindings, thread_id, id);
  return results.length;
};

const DELETE_PAGE = 1_000;

/** Deletes every object under `prefix`, a page at a time. */
export const deletePrefix = async (bucket: R2Bucket, prefix: string) => {
  for (;;) {
    const page = await bucket.list({ prefix, limit: DELETE_PAGE });
    if (page.objects.length > 0)
      await bucket.delete(page.objects.map(({ key }) => key));
    if (!page.truncated) break;
  }
};

/**
 * Removes every artifact a deleted Thread had: its bodies under the
 * Thread's prefix first, so a retry after a failure still finds the rows,
 * then the rows.
 */
export const deleteThreadArtifacts = async (
  bindings: ArtifactBindings,
  threadId: string,
) => {
  const bucket = bindings.DX_STORAGE;
  if (bucket !== undefined)
    await deletePrefix(bucket, artifactThreadPrefix(threadId));
  const db = bindings.DB;
  if (db === undefined) return;
  await db.batch([
    db
      .prepare("DELETE FROM thread_artifact_ask WHERE thread_id = ?")
      .bind(threadId),
    db
      .prepare(
        `DELETE FROM thread_artifact_comment WHERE artifact_id IN (
           SELECT id FROM thread_artifact WHERE thread_id = ?
         )`,
      )
      .bind(threadId),
    db
      .prepare(
        `DELETE FROM thread_artifact_revision WHERE artifact_id IN (
           SELECT id FROM thread_artifact WHERE thread_id = ?
         )`,
      )
      .bind(threadId),
    db
      .prepare("DELETE FROM thread_artifact WHERE thread_id = ?")
      .bind(threadId),
  ]);
};
