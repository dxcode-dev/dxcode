import {
  ARTIFACT_IMAGE_MAX_BYTES,
  ARTIFACT_MAX_BYTES,
  CreateThreadArtifactCommentRequestSchema,
  CreateThreadArtifactRequestSchema,
  type DeleteThreadArtifactResponseSchema,
  GetThreadMembersResponseSchema,
  NotifyArtifactAgentResponseSchema,
  SaveThreadArtifactRequestSchema,
  sanitizeAttachmentFilename,
  type ThreadArtifactCommentListResponse,
  type ThreadArtifactCommentResponse,
  type ThreadArtifactErrorCode,
  type ThreadArtifactErrorResponse,
  type ThreadArtifactImageResponse,
  type ThreadArtifactListResponse,
  type ThreadArtifactResponse,
  type ThreadArtifactRevisionResponse,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { authorizeStandaloneArtifact } from "../artifact-library/access.js";
import { attachmentOrigin, sniffAttachmentType } from "../attachments/store.js";
import { readBoundedBody, readBoundedText } from "../http/bounded-body.js";
import type { AppEnv } from "../http/types.js";
import {
  scheduleArtifactInvalidation,
  scheduleRealtimeInvalidation,
} from "../realtime/publication.js";
import { standaloneArtifactMembers } from "../thread-sharing/members.js";
import {
  findThreadStorageFile,
  putThreadStorageFile,
  threadStorageFileData,
} from "../thread-storage/store.js";
import {
  artifactCommented,
  artifactSaved,
  notifyArtifactAgent,
} from "./ask-effects.js";
import {
  type ArtifactCommentResult,
  addArtifactComment,
  listArtifactComments,
  resolveArtifactComment,
} from "./comments.js";
import { artifactKind } from "./kinds.js";
import { threadArtifactLogger } from "./logger.js";
import {
  putStandaloneImage,
  readStandaloneImage,
  standaloneImagePath,
} from "./standalone-images.js";
import {
  ArtifactsUnavailableError,
  type ArtifactThreadId,
  type ArtifactWithMarkdown,
  type ArtifactWriteResult,
  createArtifact,
  deleteArtifact,
  listArtifacts,
  readArtifact,
  readArtifactRevision,
  revisionAuthor,
  saveArtifact,
} from "./store.js";

/** JSON escaping can grow Markdown up to six times; anything larger is refused unread. */
const MAX_REQUEST_BYTES = ARTIFACT_MAX_BYTES * 6 + 64 * 1024;

const MESSAGES: Record<ThreadArtifactErrorCode, string> = {
  INVALID_REQUEST: "Request validation failed.",
  ARTIFACT_NOT_FOUND: "Artifact not found.",
  ARTIFACT_READ_ONLY:
    "You can view this artifact. Ask its owner for edit access.",
  ARTIFACT_COMMENT_NOT_FOUND: "Comment not found.",
  ARTIFACT_QUOTE_NOT_FOUND:
    "The quoted text is not in the artifact's current revision.",
  ARTIFACT_COMMENT_LIMIT: "This artifact holds as many comments as it can.",
  ARTIFACT_IMAGE_INVALID: "An image must be a PNG, JPEG, GIF, or WebP file.",
  ARTIFACT_IMAGE_TOO_LARGE: `An image can be at most ${ARTIFACT_IMAGE_MAX_BYTES / (1024 * 1024)} MB.`,
  ARTIFACT_REVISION_NOT_FOUND: "That revision is not kept.",
  ARTIFACT_CONFLICT:
    "The artifact changed since that revision. Merge your change into the current revision and save again.",
  ARTIFACT_TOO_LARGE: `An artifact holds at most ${ARTIFACT_MAX_BYTES / (1024 * 1024)} MB of Markdown.`,
  ARTIFACT_STORAGE_FULL:
    "These artifacts are full. Delete an artifact, or old revisions, to save more.",
  ARTIFACTS_UNAVAILABLE: "Artifacts are temporarily unavailable.",
};

const STATUS = {
  INVALID_REQUEST: 400,
  ARTIFACT_NOT_FOUND: 404,
  ARTIFACT_READ_ONLY: 403,
  ARTIFACT_COMMENT_NOT_FOUND: 404,
  ARTIFACT_QUOTE_NOT_FOUND: 422,
  ARTIFACT_COMMENT_LIMIT: 409,
  ARTIFACT_IMAGE_INVALID: 415,
  ARTIFACT_IMAGE_TOO_LARGE: 413,
  ARTIFACT_REVISION_NOT_FOUND: 404,
  ARTIFACT_CONFLICT: 409,
  ARTIFACT_TOO_LARGE: 413,
  ARTIFACT_STORAGE_FULL: 413,
  ARTIFACTS_UNAVAILABLE: 503,
} as const satisfies Record<ThreadArtifactErrorCode, number>;

const refuse = (
  context: Context<AppEnv>,
  code: ThreadArtifactErrorCode,
  options: { message?: string; current?: ArtifactWithMarkdown } = {},
) => {
  context.header("Cache-Control", "no-store");
  return context.json<ThreadArtifactErrorResponse>(
    {
      status: "error",
      data: {
        code,
        message: options.message ?? MESSAGES[code],
        requestId: context.get("requestId"),
        ...(options.current === undefined ? {} : { current: options.current }),
      },
    },
    STATUS[code],
  );
};

const handle =
  (operation: string, run: (context: Context<AppEnv>) => Promise<Response>) =>
  async (context: Context<AppEnv>) => {
    try {
      return await run(context);
    } catch (cause) {
      threadArtifactLogger.error("Artifact request failed.", {
        event: "thread_artifact_request_failed",
        operation,
        requestId: context.get("requestId"),
        threadId: context.req.param("threadId") ?? null,
        artifactId: context.req.param("artifactId") ?? null,
        unavailable: cause instanceof ArtifactsUnavailableError,
        errorName: cause instanceof Error ? cause.name : "UnknownError",
        errorMessage:
          cause instanceof Error ? cause.message.slice(0, 500) : "unknown",
      });
      return refuse(context, "ARTIFACTS_UNAVAILABLE");
    }
  };

const decodeBody = async <A, I>(
  context: Context<AppEnv>,
  schema: Schema.Codec<A, I>,
): Promise<A | undefined> => {
  const text = await readBoundedText(context.req.raw, MAX_REQUEST_BYTES);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(schema as Schema.Codec<A, unknown>)(parsed),
  );
};

const param = (context: Context<AppEnv>, name: string) =>
  context.req.param(name) ?? "";

const ARTIFACT_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** A safe file name for the image, with the extension its bytes call for. */
const imageName = (requested: string | undefined, mimeType: string) => {
  const base =
    sanitizeAttachmentFilename(requested ?? "")
      .replace(/\.[A-Za-z0-9]{1,5}$/, "")
      .slice(0, 80) || "image";
  return `${base}.${EXTENSION[mimeType] ?? "img"}`;
};

/** The person acting, not the owner a Contribute member acts as. */
const writer = (context: Context<AppEnv>) => ({
  kind: "user" as const,
  userId: (context.get("actor") ?? context.get("principal")).userId,
});

/**
 * Where the request's artifact lives: the Thread in the path, or null on the
 * standalone routes, whose path names only the artifact.
 */
const whereOf = (context: Context<AppEnv>): ArtifactThreadId =>
  context.req.param("threadId") ?? null;

/** Tells the Thread's viewers, or the standalone artifact's, it changed. */
const invalidate = (context: Context<AppEnv>, artifactId: string) => {
  const threadId = whereOf(context);
  return threadId === null
    ? scheduleArtifactInvalidation(
        () => context.executionCtx,
        context.env,
        artifactId,
      )
    : scheduleRealtimeInvalidation(
        () => context.executionCtx,
        context.env,
        threadId as ThreadId,
        "artifacts.invalidated",
      );
};

/** Runs `work` after the response, or now when there is no request context. */
const afterResponse = (context: Context<AppEnv>, work: Promise<unknown>) => {
  const settled = work.catch(() => undefined);
  try {
    context.executionCtx.waitUntil(settled);
  } catch {
    // No ExecutionContext (a test, or ownerRequest): the work still runs.
  }
};

const answerWrite = async (
  context: Context<AppEnv>,
  result: ArtifactWriteResult,
  status: 200 | 201,
) => {
  switch (result.kind) {
    case "saved": {
      await invalidate(context, result.value.artifact.id);
      const text = artifactKind(result.value.artifact.kind).toText;
      afterResponse(
        context,
        artifactSaved(context.env, {
          threadId: whereOf(context),
          artifactId: result.value.artifact.id,
          title: result.value.artifact.title,
          revision: result.value.artifact.revision,
          before: text(result.previous),
          after: text(result.value.markdown),
          writer: writer(context),
        }),
      );
      context.header("Cache-Control", "no-store");
      return context.json<ThreadArtifactResponse>(
        { status: "success", data: result.value },
        status,
      );
    }
    case "not-found":
      return refuse(context, "ARTIFACT_NOT_FOUND");
    case "invalid":
      return refuse(context, "INVALID_REQUEST", { message: result.message });
    case "too-large":
      return refuse(context, "ARTIFACT_TOO_LARGE");
    case "storage-full":
      return refuse(context, "ARTIFACT_STORAGE_FULL");
    case "conflict":
      return refuse(context, "ARTIFACT_CONFLICT", { current: result.current });
  }
};

const answerComment = async (
  context: Context<AppEnv>,
  result: ArtifactCommentResult,
  status: 200 | 201,
) => {
  switch (result.kind) {
    case "saved":
      await invalidate(context, result.comment.artifactId);
      context.header("Cache-Control", "no-store");
      return context.json<ThreadArtifactCommentResponse>(
        { status: "success", data: { comment: result.comment } },
        status,
      );
    case "not-found":
      return refuse(context, "ARTIFACT_NOT_FOUND");
    case "comment-not-found":
      return refuse(context, "ARTIFACT_COMMENT_NOT_FOUND");
    case "quote-not-found":
      return refuse(context, "ARTIFACT_QUOTE_NOT_FOUND");
    case "limit":
      return refuse(context, "ARTIFACT_COMMENT_LIMIT");
    case "invalid":
      return refuse(context, "INVALID_REQUEST", { message: result.message });
  }
};

const listRoute = handle("list", async (context) => {
  const folder = context.req.query("folder");
  const artifacts = await listArtifacts(
    context.env,
    param(context, "threadId"),
    folder === undefined ? {} : { folder },
  );
  context.header("Cache-Control", "no-store");
  return context.json<ThreadArtifactListResponse>({
    status: "success",
    data: { artifacts: [...artifacts] },
  });
});

const createRoute = handle("create", async (context) => {
  const input = await decodeBody(context, CreateThreadArtifactRequestSchema);
  if (input === undefined) return refuse(context, "INVALID_REQUEST");
  return answerWrite(
    context,
    await createArtifact(context.env, {
      threadId: whereOf(context),
      title: input.title,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.folder === undefined ? {} : { folder: input.folder }),
      markdown: input.markdown,
      writer: writer(context),
    }),
    201,
  );
});

const uploadImageRoute = handle("upload-image", async (context) => {
  const bytes = await readBoundedBody(
    context.req.raw,
    ARTIFACT_IMAGE_MAX_BYTES,
  );
  if (bytes === undefined) return refuse(context, "ARTIFACT_IMAGE_TOO_LARGE");
  // The type comes from the bytes, never the name or the header.
  const mimeType = sniffAttachmentType(bytes.subarray(0, 64));
  if (
    bytes.byteLength === 0 ||
    mimeType === undefined ||
    !ARTIFACT_IMAGE_TYPES.has(mimeType)
  )
    return refuse(context, "ARTIFACT_IMAGE_INVALID");
  const threadId = whereOf(context);
  const name = imageName(context.req.query("name"), mimeType);
  if (threadId === null) {
    const bucket = context.env.DX_STORAGE;
    if (bucket === undefined) return refuse(context, "ARTIFACTS_UNAVAILABLE");
    const artifactId = param(context, "artifactId");
    const id = await putStandaloneImage(bucket, {
      artifactId,
      name,
      mimeType,
      bytes,
    });
    context.header("Cache-Control", "no-store");
    return context.json<ThreadArtifactImageResponse>(
      {
        status: "success",
        data: {
          id,
          url: `${attachmentOrigin(context.env, context.req.url)}${standaloneImagePath(artifactId, id, name)}`,
          name,
          mimeType,
          size: bytes.byteLength,
        },
      },
      201,
    );
  }
  const id = await putThreadStorageFile(context.env, {
    threadId,
    name,
    mimeType,
    bytes,
  });
  const row = await findThreadStorageFile(context.env.DB as D1Database, id);
  if (row === null) return refuse(context, "ARTIFACTS_UNAVAILABLE");
  const file = threadStorageFileData(
    row,
    attachmentOrigin(context.env, context.req.url),
  );
  context.header("Cache-Control", "no-store");
  return context.json<ThreadArtifactImageResponse>(
    {
      status: "success",
      data: {
        id: file.id,
        url: file.url,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
      },
    },
    201,
  );
});

const readImageRoute = handle("read-image", async (context) => {
  const bucket = context.env.DX_STORAGE;
  if (bucket === undefined) return refuse(context, "ARTIFACTS_UNAVAILABLE");
  const image = await readStandaloneImage(
    bucket,
    param(context, "artifactId"),
    param(context, "imageId"),
    param(context, "name"),
  );
  if (image === undefined) return refuse(context, "ARTIFACT_NOT_FOUND");
  return new Response(image.body, {
    headers: {
      "content-type": image.mimeType,
      "content-length": String(image.size),
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      // An image never changes; access can be taken away, so never shared.
      "cache-control": "private, max-age=3600, immutable",
    },
  });
});

const readRoute = handle("read", async (context) => {
  const found = await readArtifact(
    context.env,
    whereOf(context),
    param(context, "artifactId"),
  );
  if (found === undefined) return refuse(context, "ARTIFACT_NOT_FOUND");
  context.header("Cache-Control", "no-store");
  return context.json<ThreadArtifactResponse>({
    status: "success",
    data: found,
  });
});

const readRevisionRoute = handle("read-revision", async (context) => {
  const revision = Number(param(context, "revision"));
  if (!Number.isSafeInteger(revision) || revision < 1)
    return refuse(context, "INVALID_REQUEST");
  const found = await readArtifactRevision(
    context.env,
    whereOf(context),
    param(context, "artifactId"),
    revision,
  );
  if (found === undefined)
    return refuse(context, "ARTIFACT_REVISION_NOT_FOUND");
  // A revision never changes. Private: access can be taken away, and a
  // deleted artifact's revisions are gone, so shared caches never hold it.
  context.header("Cache-Control", "private, max-age=3600, immutable");
  return context.json<ThreadArtifactRevisionResponse>({
    status: "success",
    data: {
      artifactId: found.row.artifact_id,
      revision: found.row.revision,
      baseRevision: found.row.base_revision,
      author: revisionAuthor(found.row),
      createdAt: found.row.created_at,
      markdown: found.markdown,
    },
  });
});

const saveRoute = handle("save", async (context) => {
  const input = await decodeBody(context, SaveThreadArtifactRequestSchema);
  if (input === undefined) return refuse(context, "INVALID_REQUEST");
  return answerWrite(
    context,
    await saveArtifact(context.env, {
      threadId: whereOf(context),
      artifactId: param(context, "artifactId"),
      baseRevision: input.baseRevision,
      markdown: input.markdown,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.folder === undefined ? {} : { folder: input.folder }),
      ...(input.force === true ? { force: true } : {}),
      writer: writer(context),
    }),
    200,
  );
});

const deleteRoute = handle("delete", async (context) => {
  const deleted = await deleteArtifact(
    context.env,
    whereOf(context),
    param(context, "artifactId"),
  );
  if (!deleted) return refuse(context, "ARTIFACT_NOT_FOUND");
  await invalidate(context, param(context, "artifactId"));
  context.header("Cache-Control", "no-store");
  return context.json<typeof DeleteThreadArtifactResponseSchema.Type>({
    status: "success",
    data: { deleted: true },
  });
});

const listCommentsRoute = handle("list-comments", async (context) => {
  const comments = await listArtifactComments(
    context.env,
    whereOf(context),
    param(context, "artifactId"),
  );
  if (comments === undefined) return refuse(context, "ARTIFACT_NOT_FOUND");
  context.header("Cache-Control", "no-store");
  return context.json<ThreadArtifactCommentListResponse>({
    status: "success",
    data: { comments: [...comments] },
  });
});

const addCommentRoute = handle("add-comment", async (context) => {
  const input = await decodeBody(
    context,
    CreateThreadArtifactCommentRequestSchema,
  );
  if (input === undefined) return refuse(context, "INVALID_REQUEST");
  const common = {
    threadId: whereOf(context),
    artifactId: param(context, "artifactId"),
    body: input.body,
    writer: writer(context),
  };
  const added = await addArtifactComment(
    context.env,
    "parentId" in input
      ? { ...common, parentId: input.parentId }
      : "target" in input
        ? { ...common, target: input.target }
        : {
            ...common,
            quote: input.quote,
            ...(input.near === undefined ? {} : { near: input.near }),
          },
  );
  if (added.kind === "saved")
    afterResponse(
      context,
      artifactCommented(
        context.env,
        {
          threadId: common.threadId,
          artifactId: common.artifactId,
          commentId: added.comment.id,
          quote: added.comment.quote,
          body: added.comment.body,
          writer: common.writer,
        },
        { waitUntil: (promise) => afterResponse(context, promise) },
      ),
    );
  return answerComment(context, added, 201);
});

// Notify agent (#1765): one wake, now, with what people changed. A View
// member's POST never gets here (`viewerMayRequest`); a standalone
// artifact has no agent.
const notifyRoute = handle("notify", async (context) => {
  const principal = context.get("principal");
  const notified = await notifyArtifactAgent(
    context.env,
    {
      threadId: whereOf(context),
      artifactId: param(context, "artifactId"),
      userId: principal.userId,
    },
    { waitUntil: (promise) => afterResponse(context, promise) },
  );
  if (notified === undefined) return refuse(context, "ARTIFACT_NOT_FOUND");
  if (notified === "no-agent")
    return refuse(context, "INVALID_REQUEST", {
      message: "A standalone artifact has no agent to notify.",
    });
  context.header("Cache-Control", "no-store");
  return context.json(
    Schema.encodeUnknownSync(NotifyArtifactAgentResponseSchema)({
      status: "success",
      data: { notified: true, revision: notified.revision },
    }),
    200,
  );
});

const resolveCommentRoute = handle("resolve-comment", async (context) =>
  answerComment(
    context,
    await resolveArtifactComment(context.env, {
      threadId: whereOf(context),
      artifactId: param(context, "artifactId"),
      commentId: param(context, "commentId"),
    }),
    200,
  ),
);

/**
 * A Thread's artifacts, mounted at `/v1/threads` behind `authorizeThread`:
 * the owner and Contribute members read and write; View members read only
 * (`viewerMayRequest` refuses their writes). Nothing here needs the Orb, so
 * artifacts stay readable while it sleeps and while the Thread is archived.
 */
export const threadArtifactRoutes = new Hono<AppEnv>()
  .get("/:threadId/artifacts", listRoute)
  .post("/:threadId/artifacts", createRoute)
  .post("/:threadId/artifacts/images", uploadImageRoute)
  .get("/:threadId/artifacts/:artifactId", readRoute)
  .get(
    "/:threadId/artifacts/:artifactId/revisions/:revision",
    readRevisionRoute,
  )
  .put("/:threadId/artifacts/:artifactId", saveRoute)
  .delete("/:threadId/artifacts/:artifactId", deleteRoute)
  .get("/:threadId/artifacts/:artifactId/comments", listCommentsRoute)
  .post("/:threadId/artifacts/:artifactId/comments", addCommentRoute)
  .post("/:threadId/artifacts/:artifactId/notify", notifyRoute)
  .post(
    "/:threadId/artifacts/:artifactId/comments/:commentId/resolve",
    resolveCommentRoute,
  );

/** Who `@` lists on a standalone artifact: those it is shared with. */
const listMembersRoute = handle("list-members", async (context) => {
  const db = context.env.DB;
  if (db === undefined) return refuse(context, "ARTIFACTS_UNAVAILABLE");
  context.header("Cache-Control", "no-store");
  return context.json(
    Schema.encodeUnknownSync(GetThreadMembersResponseSchema)({
      status: "success",
      data: {
        members: await standaloneArtifactMembers(
          db,
          param(context, "artifactId"),
        ),
      },
    }),
    200,
  );
});

/**
 * A standalone artifact's routes, mounted at `/v1/standalone-artifacts`:
 * the same reads and writes as a Thread's artifact, found by the artifact's
 * id alone. Its owner and members it is shared with for edit read and
 * write; members it is shared with for view read only; anyone else finds
 * nothing.
 */
export const standaloneArtifactRoutes = new Hono<AppEnv>()
  .use("/:artifactId", authorizeStandaloneArtifact)
  .use("/:artifactId/*", authorizeStandaloneArtifact)
  .get("/:artifactId", readRoute)
  .put("/:artifactId", saveRoute)
  .delete("/:artifactId", deleteRoute)
  .get("/:artifactId/revisions/:revision", readRevisionRoute)
  .post("/:artifactId/images", uploadImageRoute)
  .get("/:artifactId/images/:imageId/:name", readImageRoute)
  .get("/:artifactId/comments", listCommentsRoute)
  .get("/:artifactId/members", listMembersRoute)
  .post("/:artifactId/comments", addCommentRoute)
  .post("/:artifactId/notify", notifyRoute)
  .post("/:artifactId/comments/:commentId/resolve", resolveCommentRoute);
