import {
  ARTIFACT_LIBRARY_LIMIT,
  type ArtifactLibraryErrorCode,
  ArtifactLibraryFilterSchema,
  ArtifactLibraryItemResponseSchema,
  ArtifactLibraryResponseSchema,
  CreateStandaloneArtifactRequestSchema,
  UpdateArtifactSharingRequestSchema,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { readBoundedText } from "../http/bounded-body.js";
import type { AppEnv } from "../http/types.js";
import { scheduleRealtimeInvalidation } from "../realtime/publication.js";
import { canUseSharedThreads } from "../thread-sharing/access.js";
import { createStandaloneArtifact, shareStandaloneArtifact } from "./homes.js";
import { findLibraryItem, type LibraryReader, listLibrary } from "./library.js";

const logger = getLogger(["dx", "artifact-library"]);

/** A new artifact's body may be up to 2 MB, JSON-escaped. */
const MAX_REQUEST_BYTES = 13 * 1024 * 1024;

const STATUS = {
  INVALID_REQUEST: 400,
  ARTIFACT_NOT_FOUND: 404,
  ARTIFACT_SHARING_OWNER_ONLY: 403,
  ARTIFACT_SHARING_STANDALONE_ONLY: 409,
  ARTIFACT_SHARING_UNAVAILABLE: 409,
  ARTIFACT_PROJECT_REQUIRED: 409,
  ARTIFACTS_UNAVAILABLE: 503,
} as const satisfies Record<ArtifactLibraryErrorCode, number>;

const MESSAGES: Record<ArtifactLibraryErrorCode, string> = {
  INVALID_REQUEST: "Request validation failed.",
  ARTIFACT_NOT_FOUND: "Artifact not found.",
  ARTIFACT_SHARING_OWNER_ONLY: "Only the artifact's owner can change sharing.",
  ARTIFACT_SHARING_STANDALONE_ONLY:
    "This artifact belongs to a Thread; share the Thread instead.",
  ARTIFACT_SHARING_UNAVAILABLE: "Join or create a workspace to share.",
  ARTIFACT_PROJECT_REQUIRED: "Create a Project first, then make artifacts.",
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

/**
 * `/v1/artifacts`: the Artifacts library. Lists every artifact the person
 * may open, creates standalone artifacts, finds where one lives (what an
 * `/artifacts/<id>` link opens), and shares standalone ones. Reading and
 * saving go through `/v1/threads/:threadId/artifacts` with the item's
 * `threadId`, behind the same Thread authorization as any artifact.
 */
export const artifactLibraryRoutes = new Hono<AppEnv>()
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
          data: { items },
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
      if (result.kind === "no-project")
        return refuse(context, "ARTIFACT_PROJECT_REQUIRED");
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
        homeId: item.threadId,
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
      await scheduleRealtimeInvalidation(
        () => context.executionCtx,
        context.env,
        item.threadId,
        "thread.invalidated",
        "audience",
      );
      return answerItem(context, db, item.id, 200);
    }),
  );
