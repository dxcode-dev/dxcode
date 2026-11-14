import {
  ARTIFACT_LIBRARY_LIMIT,
  ArtifactFolderRequestSchema,
  ArtifactFolderResponseSchema,
  type ArtifactLibraryErrorCode,
  ArtifactLibraryFilterSchema,
  ArtifactLibraryItemResponseSchema,
  ArtifactLibraryResponseSchema,
  CreateStandaloneArtifactRequestSchema,
  DeleteArtifactFolderResponseSchema,
  MoveArtifactToFolderRequestSchema,
  UpdateArtifactSharingRequestSchema,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { readBoundedText } from "../http/bounded-body.js";
import type { AppEnv } from "../http/types.js";
import { scheduleArtifactInvalidation } from "../realtime/publication.js";
import { canUseSharedThreads } from "../thread-sharing/access.js";
import { findLibraryItem, type LibraryReader, listLibrary } from "./library.js";
import {
  createFolder,
  deleteFolder,
  type FolderResult,
  listFolders,
  moveToFolder,
  renameFolder,
  setPinned,
} from "./personal.js";
import {
  createStandaloneArtifact,
  shareStandaloneArtifact,
} from "./standalone.js";

const logger = getLogger(["dx", "artifact-library"]);

/** A new artifact's body may be up to 2 MB, JSON-escaped. */
const MAX_REQUEST_BYTES = 13 * 1024 * 1024;

const STATUS = {
  INVALID_REQUEST: 400,
  ARTIFACT_NOT_FOUND: 404,
  ARTIFACT_SHARING_OWNER_ONLY: 403,
  ARTIFACT_SHARING_STANDALONE_ONLY: 409,
  ARTIFACT_SHARING_UNAVAILABLE: 409,
  ARTIFACT_FOLDER_NOT_FOUND: 404,
  ARTIFACT_FOLDER_EXISTS: 409,
  ARTIFACT_FOLDER_LIMIT: 409,
  ARTIFACTS_UNAVAILABLE: 503,
} as const satisfies Record<ArtifactLibraryErrorCode, number>;

const MESSAGES: Record<ArtifactLibraryErrorCode, string> = {
  INVALID_REQUEST: "Request validation failed.",
  ARTIFACT_NOT_FOUND: "Artifact not found.",
  ARTIFACT_SHARING_OWNER_ONLY: "Only the artifact's owner can change sharing.",
  ARTIFACT_SHARING_STANDALONE_ONLY:
    "This artifact belongs to a Thread; share the Thread instead.",
  ARTIFACT_SHARING_UNAVAILABLE: "Join or create a workspace to share.",
  ARTIFACT_FOLDER_NOT_FOUND: "Folder not found.",
  ARTIFACT_FOLDER_EXISTS: "You already have a folder with that name.",
  ARTIFACT_FOLDER_LIMIT: "You have as many folders as you can keep.",
  ARTIFACTS_UNAVAILABLE: "Artifacts are temporarily unavailable.",
};

const refuse = (
  context: Context<AppEnv>,
  code: ArtifactLibraryErrorCode,
  message = MESSAGES[code],
) => {
  context.header("Cache-Control", "no-store");
  return context.json(
    {
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    },
    STATUS[code],
  );
};

const readerOf = (context: Context<AppEnv>): LibraryReader => {
  const principal = context.get("principal");
  return { userId: principal.userId, shared: canUseSharedThreads(principal) };
};

const handle =
  (
    operation: string,
    run: (context: Context<AppEnv>, db: D1Database) => Promise<Response>,
  ) =>
  async (context: Context<AppEnv>) => {
    const db = context.env.DB;
    if (db === undefined || context.env.DX_STORAGE === undefined)
      return refuse(context, "ARTIFACTS_UNAVAILABLE");
    try {
      return await run(context, db);
    } catch (cause) {
      logger.error("Artifact library request failed.", {
        event: "artifact_library_request_failed",
        operation,
        requestId: context.get("requestId"),
        errorName: cause instanceof Error ? cause.name : "UnknownError",
        errorMessage:
          cause instanceof Error ? cause.message.slice(0, 500) : "unknown",
      });
      return refuse(context, "ARTIFACTS_UNAVAILABLE");
    }
  };

const decodeJson = async <A, I>(
  context: Context<AppEnv>,
  schema: Schema.Codec<A, I>,
) => {
  const text = await readBoundedText(context.req.raw, MAX_REQUEST_BYTES);
  if (text === undefined) return undefined;
  try {
    return Option.getOrUndefined(
      Schema.decodeUnknownOption(schema as Schema.Codec<A, unknown>)(
        JSON.parse(text),
      ),
    );
  } catch {
    return undefined;
  }
};

const answerItem = async (
  context: Context<AppEnv>,
  db: D1Database,
  artifactId: string,
  status: 200 | 201,
) => {
  const item = await findLibraryItem(db, readerOf(context), artifactId);
  if (item === undefined) return refuse(context, "ARTIFACT_NOT_FOUND");
  context.header("Cache-Control", "no-store");
  return context.json(
    Schema.encodeUnknownSync(ArtifactLibraryItemResponseSchema)({
      status: "success",
      data: { item },
    }),
    status,
  );
};

const answerFolder = (
  context: Context<AppEnv>,
  result: FolderResult,
  status: 200 | 201,
) => {
  switch (result.kind) {
    case "not-found":
      return refuse(context, "ARTIFACT_FOLDER_NOT_FOUND");
    case "exists":
      return refuse(context, "ARTIFACT_FOLDER_EXISTS");
    case "limit":
      return refuse(context, "ARTIFACT_FOLDER_LIMIT");
    case "saved":
      context.header("Cache-Control", "no-store");
      return context.json(
        Schema.encodeUnknownSync(ArtifactFolderResponseSchema)({
          status: "success",
          data: { folder: result.folder },
        }),
        status,
      );
  }
};

/** Pins or unpins an artifact the reader may open, for them alone. */
const pin = async (
  context: Context<AppEnv>,
  db: D1Database,
  pinned: boolean,
) => {
  const reader = readerOf(context);
  const item = await findLibraryItem(
    db,
    reader,
    context.req.param("artifactId") ?? "",
  );
  if (item === undefined) return refuse(context, "ARTIFACT_NOT_FOUND");
  await setPinned(db, reader.userId, item.id, pinned);
  return answerItem(context, db, item.id, 200);
};

/**
 * `/v1/artifacts`: the Artifacts library. Lists every artifact the person
 * may open, creates standalone artifacts, finds where one lives (what an
 * `/artifacts/<id>` link opens), and shares standalone ones. Reading and
 * saving go through `/v1/threads/:threadId/artifacts` with the item's
 * `threadId`, or `/v1/standalone-artifacts/:artifactId` when it has none.
 */
export const artifactLibraryRoutes = new Hono<AppEnv>()
  .post(
    "/folders",
    handle("create-folder", async (context, db) => {
      const body = await decodeJson(context, ArtifactFolderRequestSchema);
      if (body === undefined) return refuse(context, "INVALID_REQUEST");
      return answerFolder(
        context,
        await createFolder(db, readerOf(context).userId, body.name),
        201,
      );
    }),
  )
  .patch(
    "/folders/:folderId",
    handle("rename-folder", async (context, db) => {
      const body = await decodeJson(context, ArtifactFolderRequestSchema);
      if (body === undefined) return refuse(context, "INVALID_REQUEST");
      return answerFolder(
        context,
        await renameFolder(
          db,
          readerOf(context).userId,
          context.req.param("folderId") ?? "",
          body.name,
        ),
        200,
      );
    }),
  )
  .delete(
    "/folders/:folderId",
    handle("delete-folder", async (context, db) => {
      const deleted = await deleteFolder(
        db,
        readerOf(context).userId,
        context.req.param("folderId") ?? "",
      );
      if (!deleted) return refuse(context, "ARTIFACT_FOLDER_NOT_FOUND");
      context.header("Cache-Control", "no-store");
      return context.json(
        Schema.encodeUnknownSync(DeleteArtifactFolderResponseSchema)({
          status: "success",
          data: { deleted: true },
        }),
        200,
      );
    }),
  )
  .get(
    "/",
    handle("list", async (context, db) => {
      const filter = Schema.decodeUnknownOption(ArtifactLibraryFilterSchema)(
        context.req.query("filter") ?? "all",
      );
      const query = context.req.query("q") ?? "";
      if (Option.isNone(filter) || query.length > 200)
        return refuse(context, "INVALID_REQUEST");
      const items = await listLibrary(db, readerOf(context), {
        query,
        filter: filter.value,
        limit: ARTIFACT_LIBRARY_LIMIT,
      });
      context.header("Cache-Control", "no-store");
      return context.json(
        Schema.encodeUnknownSync(ArtifactLibraryResponseSchema)({
          status: "success",
          data: {
            items,
            folders: await listFolders(db, readerOf(context).userId),
          },
        }),
        200,
      );
    }),
  )
  .post(
    "/",
    handle("create", async (context, db) => {
      const body = await decodeJson(
        context,
        CreateStandaloneArtifactRequestSchema,
      );
      if (body === undefined) return refuse(context, "INVALID_REQUEST");
      const principal = context.get("principal");
      const result = await createStandaloneArtifact(
        { DB: db, DX_STORAGE: context.env.DX_STORAGE },
        {
          ownerUserId: principal.userId,
          title: body.title,
          ...(body.kind === undefined ? {} : { kind: body.kind }),
          ...(body.markdown === undefined ? {} : { markdown: body.markdown }),
          writer: { kind: "user", userId: principal.userId },
        },
      );
      if (result.kind === "invalid")
        return refuse(context, "INVALID_REQUEST", result.message);
      logger.info("Standalone artifact created.", {
        event: "standalone_artifact_created",
        requestId: context.get("requestId"),
        artifactId: result.artifactId,
      });
      return answerItem(context, db, result.artifactId, 201);
    }),
  )
  .get(
    "/:artifactId",
    handle("find", (context, db) =>
      answerItem(context, db, context.req.param("artifactId") ?? "", 200),
    ),
  )
  .put(
    "/:artifactId/pin",
    handle("pin", (context, db) => pin(context, db, true)),
  )
  .delete(
    "/:artifactId/pin",
    handle("unpin", (context, db) => pin(context, db, false)),
  )
  .put(
    "/:artifactId/folder",
    handle("file", async (context, db) => {
      const body = await decodeJson(context, MoveArtifactToFolderRequestSchema);
      if (body === undefined) return refuse(context, "INVALID_REQUEST");
      const reader = readerOf(context);
      const item = await findLibraryItem(
        db,
        reader,
        context.req.param("artifactId") ?? "",
      );
      if (item === undefined) return refuse(context, "ARTIFACT_NOT_FOUND");
      if (!(await moveToFolder(db, reader.userId, item.id, body.folderId)))
        return refuse(context, "ARTIFACT_FOLDER_NOT_FOUND");
      return answerItem(context, db, item.id, 200);
    }),
  )
  .put(
    "/:artifactId/sharing",
    handle("share", async (context, db) => {
      const body = await decodeJson(
        context,
        UpdateArtifactSharingRequestSchema,
      );
      if (body === undefined) return refuse(context, "INVALID_REQUEST");
      const reader = readerOf(context);
      const item = await findLibraryItem(
        db,
        reader,
        context.req.param("artifactId") ?? "",
      );
      if (item === undefined) return refuse(context, "ARTIFACT_NOT_FOUND");
      if (item.access !== "owner")
        return refuse(context, "ARTIFACT_SHARING_OWNER_ONLY");
      if (item.source.kind !== "standalone")
        return refuse(context, "ARTIFACT_SHARING_STANDALONE_ONLY");
      const result = await shareStandaloneArtifact(db, {
        artifactId: item.id,
        ownerUserId: reader.userId as UserId,
        sharing: body.sharing,
      });
      if (result.kind === "no-workspace")
        return refuse(context, "ARTIFACT_SHARING_UNAVAILABLE");
      logger.info("Standalone artifact sharing changed.", {
        event: "standalone_artifact_shared",
        requestId: context.get("requestId"),
        artifactId: item.id,
        sharing: body.sharing,
      });
      // Every member's library may gain or lose it.
      await scheduleArtifactInvalidation(
        () => context.executionCtx,
        context.env,
        item.id,
        "audience",
      );
      return answerItem(context, db, item.id, 200);
    }),
  );
