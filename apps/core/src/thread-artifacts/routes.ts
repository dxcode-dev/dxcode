import {
  ARTIFACT_IMAGE_MAX_BYTES,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_NOTIFY_AGENT_FEATURE,
  CreateThreadArtifactCommentRequestSchema,
  CreateThreadArtifactRequestSchema,
  type DeleteThreadArtifactResponseSchema,
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
import type { ExperimentalFeatureId, ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { attachmentOrigin, sniffAttachmentType } from "../attachments/store.js";
import { readBoundedBody, readBoundedText } from "../http/bounded-body.js";
import type { AppEnv } from "../http/types.js";
import { scheduleRealtimeInvalidation } from "../realtime/publication.js";
import { experimentalFeatureEnabled } from "../settings/experimental-features/routes.js";
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
import { threadArtifactLogger } from "./logger.js";
import {
  ArtifactsUnavailableError,
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
    "This Thread's artifacts are full. Delete an artifact to save more.",
  ARTIFACTS_UNAVAILABLE: "Artifacts are temporarily unavailable.",
  ARTIFACT_NOTIFY_DISABLED:
    "Notify agent is an experimental feature. Turn it on in Settings, Experimental Features.",
};

const STATUS = {
  INVALID_REQUEST: 400,
  ARTIFACT_NOT_FOUND: 404,
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
  ARTIFACT_NOTIFY_DISABLED: 404,
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
        threadId: param(context, "threadId"),
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

const invalidate = (context: Context<AppEnv>) =>
  scheduleRealtimeInvalidation(
    () => context.executionCtx,
    context.env,
    param(context, "threadId") as ThreadId,
    "artifacts.invalidated",
  );

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
    case "saved":
      await invalidate(context);
      afterResponse(
        context,
        artifactSaved(
          context.env,
          {
            threadId: param(context, "threadId"),
            artifactId: result.value.artifact.id,
            title: result.value.artifact.title,
            revision: result.value.artifact.revision,
            before: result.previous,
            after: result.value.markdown,
            writer: writer(context),
          },
          { waitUntil: (promise) => afterResponse(context, promise) },
        ),
      );
      context.header("Cache-Control", "no-store");
      return context.json<ThreadArtifactResponse>(
        { status: "success", data: result.value },
        status,
      );
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
      await invalidate(context);
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

/**
 * A Thread's artifacts, mounted at `/v1/threads` behind `authorizeThread`:
 * the owner and Contribute members read and write; View members read only
 * (`viewerMayRequest` refuses their writes). Nothing here needs the Orb, so
 * artifacts stay readable while it sleeps and while the Thread is archived.
 */
export const threadArtifactRoutes = new Hono<AppEnv>()
  .get(
    "/:threadId/artifacts",
    handle("list", async (context) => {
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
    }),
  )
  .post(
    "/:threadId/artifacts",
    handle("create", async (context) => {
      const input = await decodeBody(
        context,
        CreateThreadArtifactRequestSchema,
      );
      if (input === undefined) return refuse(context, "INVALID_REQUEST");
      return answerWrite(
        context,
        await createArtifact(context.env, {
          threadId: param(context, "threadId"),
          title: input.title,
          ...(input.folder === undefined ? {} : { folder: input.folder }),
          markdown: input.markdown,
          writer: writer(context),
        }),
        201,
      );
    }),
  )
  .post(
    "/:threadId/artifacts/images",
    handle("upload-image", async (context) => {
      const bytes = await readBoundedBody(
        context.req.raw,
        ARTIFACT_IMAGE_MAX_BYTES,
      );
      if (bytes === undefined)
        return refuse(context, "ARTIFACT_IMAGE_TOO_LARGE");
      // The type comes from the bytes, never the name or the header.
      const mimeType = sniffAttachmentType(bytes.subarray(0, 64));
      if (
        bytes.byteLength === 0 ||
        mimeType === undefined ||
        !ARTIFACT_IMAGE_TYPES.has(mimeType)
      )
        return refuse(context, "ARTIFACT_IMAGE_INVALID");
      const threadId = param(context, "threadId");
      const name = imageName(context.req.query("name"), mimeType);
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
    }),
  )
  .get(
    "/:threadId/artifacts/:artifactId",
    handle("read", async (context) => {
      const found = await readArtifact(
        context.env,
        param(context, "threadId"),
        param(context, "artifactId"),
      );
      if (found === undefined) return refuse(context, "ARTIFACT_NOT_FOUND");
      context.header("Cache-Control", "no-store");
      return context.json<ThreadArtifactResponse>({
        status: "success",
        data: found,
      });
    }),
  )
  .get(
    "/:threadId/artifacts/:artifactId/revisions/:revision",
    handle("read-revision", async (context) => {
      const revision = Number(param(context, "revision"));
      if (!Number.isSafeInteger(revision) || revision < 1)
        return refuse(context, "INVALID_REQUEST");
      const found = await readArtifactRevision(
        context.env,
        param(context, "threadId"),
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
    }),
  )
  .put(
    "/:threadId/artifacts/:artifactId",
    handle("save", async (context) => {
      const input = await decodeBody(context, SaveThreadArtifactRequestSchema);
      if (input === undefined) return refuse(context, "INVALID_REQUEST");
      return answerWrite(
        context,
        await saveArtifact(context.env, {
          threadId: param(context, "threadId"),
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
    }),
  )
  .delete(
    "/:threadId/artifacts/:artifactId",
    handle("delete", async (context) => {
      const deleted = await deleteArtifact(
        context.env,
        param(context, "threadId"),
        param(context, "artifactId"),
      );
      if (!deleted) return refuse(context, "ARTIFACT_NOT_FOUND");
      await invalidate(context);
      context.header("Cache-Control", "no-store");
      return context.json<typeof DeleteThreadArtifactResponseSchema.Type>({
        status: "success",
        data: { deleted: true },
      });
    }),
  )
  .get(
    "/:threadId/artifacts/:artifactId/comments",
    handle("list-comments", async (context) => {
      const comments = await listArtifactComments(
        context.env,
        param(context, "threadId"),
        param(context, "artifactId"),
      );
      if (comments === undefined) return refuse(context, "ARTIFACT_NOT_FOUND");
      context.header("Cache-Control", "no-store");
      return context.json<ThreadArtifactCommentListResponse>({
        status: "success",
        data: { comments: [...comments] },
      });
    }),
  )
  .post(
    "/:threadId/artifacts/:artifactId/comments",
    handle("add-comment", async (context) => {
      const input = await decodeBody(
        context,
        CreateThreadArtifactCommentRequestSchema,
      );
      if (input === undefined) return refuse(context, "INVALID_REQUEST");
      const common = {
        threadId: param(context, "threadId"),
        artifactId: param(context, "artifactId"),
        body: input.body,
        writer: writer(context),
      };
      const added = await addArtifactComment(
        context.env,
        "parentId" in input
          ? { ...common, parentId: input.parentId }
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
    }),
  )
  .post(
    "/:threadId/artifacts/:artifactId/notify",
    // Notify agent (#1765): one wake, now, with what people changed. A View
    // member's POST never gets here (`viewerMayRequest`).
    handle("notify", async (context) => {
      const principal = context.get("principal");
      const enabled = await experimentalFeatureEnabled(
        context.env,
        principal,
        ARTIFACT_NOTIFY_AGENT_FEATURE as ExperimentalFeatureId,
      ).catch(() => false);
      if (!enabled) return refuse(context, "ARTIFACT_NOTIFY_DISABLED");
      const notified = await notifyArtifactAgent(
        context.env,
        {
          threadId: param(context, "threadId"),
          artifactId: param(context, "artifactId"),
          userId: principal.userId,
        },
        { waitUntil: (promise) => afterResponse(context, promise) },
      );
      if (notified === undefined) return refuse(context, "ARTIFACT_NOT_FOUND");
      context.header("Cache-Control", "no-store");
      return context.json(
        Schema.encodeUnknownSync(NotifyArtifactAgentResponseSchema)({
          status: "success",
          data: { notified: true, revision: notified.revision },
        }),
        200,
      );
    }),
  )
  .post(
    "/:threadId/artifacts/:artifactId/comments/:commentId/resolve",
    handle("resolve-comment", async (context) =>
      answerComment(
        context,
        await resolveArtifactComment(context.env, {
          threadId: param(context, "threadId"),
          artifactId: param(context, "artifactId"),
          commentId: param(context, "commentId"),
        }),
        200,
      ),
    ),
  );
