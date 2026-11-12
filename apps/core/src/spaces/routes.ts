import {
  CreateSpaceRequestSchema,
  DiscoverSpacesQuerySchema,
  ListSpaceSuggestionsResponseSchema,
  ListSpacesResponseSchema,
  ListSpaceThreadsResponseSchema,
  SPACE_ARTIFACTS_LIMIT,
  SPACE_PROGRESS_DEFAULT_DAYS,
  SpaceArtifactsResponseSchema,
  SpaceCatchUpResponseSchema,
  type SpaceErrorCode,
  SpaceErrorResponseSchema,
  SpaceProgressQuerySchema,
  SpaceProgressResponseSchema,
  SpaceResponseSchema,
  SpaceThreadResponseSchema,
  UpdateSpaceRequestSchema,
} from "@dx/api";
import { type Principal, ThreadId, type UserId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { isTimeZone } from "../automations/recurrence.js";
import { readBoundedJson } from "../http/bounded-body.js";
import type { AppEnv } from "../http/types.js";
import { spaceLogger } from "../logging.js";
import {
  scheduleRealtimeInvalidation,
  scheduleUserInvalidation,
} from "../realtime/publication.js";
import { canUseSharedThreads } from "../thread-sharing/access.js";
import { ownerAgentInitialization } from "../thread-sharing/middleware.js";
import { userIdentity } from "../thread-sharing/service.js";
import { readSpaceProject } from "./agent/prompt-data.js";
import { buildSpaceSetupMessage } from "./agent/setup-message.js";
import { deliverToSpaceAgent } from "./agent-delivery.js";
import { resolveSpaceAgentRoute, SpacePlanRefused } from "./agent-model.js";
import { dismissCatchUp, readCatchUp } from "./catch-up.js";
import { createSpaceRootThread } from "./create-root-thread.js";
import { spacePostHandlers } from "./posts/routes.js";
import { spaceProgress } from "./progress/progress.js";
import {
  defaultSpaceColor,
  joinSpace,
  leaveSpace,
  listDiscoverableSpaceRows,
  listJoinedSpaceRows,
  listSpaceArtifactRows,
  readSpaceRow,
  recordNewSpace,
  type SpaceRow,
  spaceFamilyIds,
  updateSpaceRow,
} from "./repository-d1.js";
import {
  SpaceError,
  spaceData,
  spaceNotFound,
  spaceThreadItems,
  spaceWorkspaceId,
} from "./service.js";
import {
  readRecentThreads,
  type SpaceSuggester,
  workersAiSpaceSuggester,
} from "./suggestions.js";

const failure = (
  context: Context<AppEnv>,
  code: SpaceErrorCode,
  status: 400 | 403 | 404 | 409 | 503,
  message: string,
) =>
  context.json(
    Schema.encodeUnknownSync(SpaceErrorResponseSchema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );

const invalidRequest = () =>
  new SpaceError("INVALID_REQUEST", 400, "Request validation failed.");

const handle = async (
  context: Context<AppEnv>,
  run: (db: D1Database, principal: Principal) => Promise<Response>,
) => {
  const db = context.env.DB;
  if (db === undefined)
    return failure(
      context,
      "PERSISTENCE_UNAVAILABLE",
      503,
      "Persistence is temporarily unavailable.",
    );
  try {
    return await run(db, context.get("principal"));
  } catch (error) {
    if (error instanceof SpaceError)
      return failure(context, error.code, error.status, error.message);
    spaceLogger.error("Space request failed.", {
      event: "space_request_failed",
      requestId: context.get("requestId"),
      cause: error,
    });
    return failure(
      context,
      "PERSISTENCE_UNAVAILABLE",
      503,
      "Persistence is temporarily unavailable.",
    );
  }
};

const threadIdParam = (context: Context<AppEnv>) => {
  const decoded = Schema.decodeUnknownOption(ThreadId)(
    context.req.param("threadId"),
  );
  if (Option.isNone(decoded)) throw invalidRequest();
  return decoded.value;
};

const childIdParam = (context: Context<AppEnv>) => {
  const decoded = Schema.decodeUnknownOption(ThreadId)(
    context.req.param("childId"),
  );
  if (Option.isNone(decoded)) throw invalidRequest();
  return decoded.value;
};

const jsonBody = async <S extends Schema.Top>(
  context: Context<AppEnv>,
  schema: S,
): Promise<S["Type"]> => {
  const decoded = Schema.decodeUnknownOption(schema as never)(
    await readBoundedJson(context.req.raw).catch(() => undefined),
  );
  if (Option.isNone(decoded)) throw invalidRequest();
  return decoded.value as S["Type"];
};

/**
 * Rows the principal may see: External API Apps act for their own Threads
 * only, never ones others shared.
 */
const visibleRows = (principal: Principal, rows: ReadonlyArray<SpaceRow>) =>
  canUseSharedThreads(principal)
    ? rows
    : rows.filter(({ access }) => access === "owner");

const readSpace = async (
  db: D1Database,
  principal: Principal,
  threadId: ThreadId,
) => {
  const row = await readSpaceRow(db, threadId, principal.userId as UserId);
  const [visible] = visibleRows(principal, row === null ? [] : [row]);
  if (visible === undefined) throw spaceNotFound();
  return visible;
};

const spaceResponse = async (
  context: Context<AppEnv>,
  db: D1Database,
  principal: Principal,
  threadId: ThreadId,
  status: 200 | 201 = 200,
) => {
  const [space] = await spaceData(db, [
    await readSpace(db, principal, threadId),
  ]);
  return context.json(
    Schema.encodeUnknownSync(SpaceResponseSchema)({
      status: "success",
      data: { space },
    }),
    status,
  );
};

const listResponse = async (
  context: Context<AppEnv>,
  db: D1Database,
  principal: Principal,
  rows: ReadonlyArray<SpaceRow>,
) =>
  context.json(
    Schema.encodeUnknownSync(ListSpacesResponseSchema)({
      status: "success",
      data: { items: await spaceData(db, visibleRows(principal, rows)) },
    }),
    200,
  );

/**
 * Tells everyone who can see the Space, its sidebar rows included, that it
 * changed: its family when sharing moved, else the Space alone.
 */
const announce = async (
  context: Context<AppEnv>,
  db: D1Database,
  threadId: ThreadId,
  { family = false } = {},
) => {
  for (const id of family ? await spaceFamilyIds(db, threadId) : [threadId])
    await scheduleRealtimeInvalidation(
      () => context.executionCtx,
      context.env,
      id,
      "thread.invalidated",
      "audience",
    );
};

const creationFailure = (status: number, code: string | undefined) => {
  if (status === 404 || code === "PROJECT_NOT_FOUND")
    return new SpaceError("PROJECT_NOT_FOUND", 404, "Project not found.");
  if (status === 400)
    return new SpaceError("INVALID_REQUEST", 400, "Request validation failed.");
  return new SpaceError(
    "SPACE_CREATION_FAILED",
    status === 403 || status === 409 ? status : 503,
    code === undefined
      ? "The Space could not be created."
      : `The Space could not be created (${code}).`,
  );
};

/** Runs work after the response, or drops it where there is no context. */
const waitUntilOf = (context: Context<AppEnv>) => {
  try {
    const execution = context.executionCtx;
    return (promise: Promise<unknown>) => execution.waitUntil(promise);
  } catch {
    return undefined;
  }
};

const deliverFrom = (context: Context<AppEnv>) =>
  deliverToSpaceAgent(context.env, waitUntilOf(context));

/**
 * A new Space's hidden setup message: its agent posts the welcome itself.
 * It creates the Space's agent, as a Space, from its owner's
 * initialization. Best effort: a Space whose setup failed still opens, and
 * its first post creates the agent.
 */
const sendSetupMessage = async (
  context: Context<AppEnv>,
  db: D1Database,
  principal: Principal,
  threadId: ThreadId,
  name: string,
) => {
  try {
    const [project, creator, initialData] = await Promise.all([
      readSpaceProject(db, threadId),
      userIdentity(db, principal.userId as UserId),
      ownerAgentInitialization(
        context.env,
        db,
        threadId,
        principal.userId as UserId,
      ),
    ]);
    const delivered = await deliverFrom(context)({
      actor: principal,
      threadId,
      body: buildSpaceSetupMessage({
        spaceName: name,
        project: project ?? null,
        creatorName: creator.name,
      }),
      key: `space-setup:${threadId}`,
      variables: { spaceSetup: true },
      initialData,
    });
    if (delivered.status !== 202)
      throw new Error(
        `The agent refused the setup message (${delivered.status}).`,
      );
  } catch (cause) {
    spaceLogger.warn("A new Space's setup message was not sent.", {
      event: "space_setup_message_failed",
      threadId,
      cause,
    });
  }
};

/** Mounted at `/v1/spaces`; tests give their own suggester. */
export const createSpaceRoutes = (
  suggest: SpaceSuggester = workersAiSpaceSuggester,
) => {
  const posts = spacePostHandlers({ readSpace, deliver: deliverFrom });
  return (
    new Hono<AppEnv>()
      .post("/", (context) =>
        handle(context, async (db, principal) => {
          const body = await jsonBody(context, CreateSpaceRequestSchema);
          const ownerUserId = principal.userId as UserId;
          const goal = body.goal?.trim() === "" ? null : (body.goal ?? null);
          const workspaceId =
            body.sharing === "private"
              ? undefined
              : !canUseSharedThreads(principal)
                ? (() => {
                    throw new SpaceError(
                      "SPACE_SHARING_UNAVAILABLE",
                      403,
                      "Only people can share a Space with their workspace.",
                    );
                  })()
                : await spaceWorkspaceId(db, body.projectId, ownerUserId);
          if (body.sharing === "workspace" && workspaceId === undefined)
            throw new SpaceError(
              "SPACE_SHARING_UNAVAILABLE",
              409,
              "Join or create a workspace to share a Space.",
            );
          // The Space's route is picked once, now, and never changes.
          const agent = await resolveSpaceAgentRoute(
            context.env,
            ownerUserId,
            body.claudeConnectionId,
          ).catch((error: unknown) => {
            if (error instanceof SpacePlanRefused)
              throw new SpaceError(
                "SPACE_PLAN_UNAVAILABLE",
                409,
                error.message,
              );
            throw error;
          });
          if (agent.creation === undefined)
            throw new SpaceError(
              "SPACE_MODEL_UNAVAILABLE",
              409,
              agent.route.kind === "unavailable"
                ? agent.route.message
                : "No connection serves the model for Spaces.",
            );
          const created = await createSpaceRootThread(context, principal, {
            projectId: body.projectId,
            name: body.name,
            ...agent.creation,
          });
          if (!created.ok) throw creationFailure(created.status, created.code);
          await recordNewSpace(db, {
            threadId: created.threadId,
            ownerUserId,
            goal,
            color: body.color ?? defaultSpaceColor(created.threadId),
            workspaceId,
            now: new Date(),
          });
          spaceLogger.info("Space created.", {
            event: "space_created",
            requestId: context.get("requestId"),
            threadId: created.threadId,
            sharing: body.sharing,
          });
          await announce(context, db, created.threadId);
          await sendSetupMessage(
            context,
            db,
            principal,
            created.threadId,
            body.name,
          );
          return spaceResponse(context, db, principal, created.threadId, 201);
        }),
      )
      .get("/", (context) =>
        handle(context, async (db, principal) =>
          listResponse(
            context,
            db,
            principal,
            await listJoinedSpaceRows(db, principal.userId as UserId),
          ),
        ),
      )
      .get("/discover", (context) =>
        handle(context, async (db, principal) => {
          const query = Schema.decodeUnknownOption(DiscoverSpacesQuerySchema)(
            context.req.query(),
          );
          if (Option.isNone(query)) throw invalidRequest();
          return listResponse(
            context,
            db,
            principal,
            canUseSharedThreads(principal)
              ? await listDiscoverableSpaceRows(
                  db,
                  principal.userId as UserId,
                  query.value.q,
                )
              : [],
          );
        }),
      )
      // New Space's suggestions; a failed model call answers none.
      .get("/suggestions", (context) =>
        handle(context, async (db, principal) => {
          const threads = await readRecentThreads(
            db,
            principal.userId as UserId,
          );
          const items = await suggest({ bindings: context.env, threads });
          return context.json(
            Schema.encodeUnknownSync(ListSpaceSuggestionsResponseSchema)({
              status: "success",
              data: { items },
            }),
            200,
          );
        }),
      )
      .get("/:threadId", (context) =>
        handle(context, async (db, principal) =>
          spaceResponse(context, db, principal, threadIdParam(context)),
        ),
      )
      .patch("/:threadId", (context) =>
        handle(context, async (db, principal) => {
          const threadId = threadIdParam(context);
          const body = await jsonBody(context, UpdateSpaceRequestSchema);
          const space = await readSpace(db, principal, threadId);
          // As with renaming and sharing a Thread, only the owner edits it.
          if (space.access !== "owner")
            throw new SpaceError(
              "SPACE_OWNER_ONLY",
              403,
              "Only the Space's owner can edit it.",
            );
          if (space.lifecycle_state !== "active")
            throw new SpaceError(
              "INVALID_REQUEST",
              409,
              "Restore the Space to edit it.",
            );
          const sharing =
            body.sharing === undefined
              ? undefined
              : body.sharing === "private"
                ? { workspaceId: undefined }
                : canUseSharedThreads(principal)
                  ? {
                      workspaceId: await spaceWorkspaceId(
                        db,
                        space.project_id,
                        space.owner_user_id,
                      ),
                    }
                  : undefined;
          if (
            body.sharing === "workspace" &&
            sharing?.workspaceId === undefined
          )
            throw new SpaceError(
              "SPACE_SHARING_UNAVAILABLE",
              409,
              "Join or create a workspace to share a Space.",
            );
          await updateSpaceRow(db, {
            threadId,
            ownerUserId: space.owner_user_id,
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.goal === undefined
              ? {}
              : {
                  goal:
                    body.goal === null || body.goal.trim() === ""
                      ? null
                      : body.goal,
                }),
            ...(body.color === undefined ? {} : { color: body.color }),
            ...(sharing === undefined ? {} : { sharing }),
            now: new Date(),
          });
          await announce(context, db, threadId, {
            family: sharing !== undefined,
          });
          return spaceResponse(context, db, principal, threadId);
        }),
      )
      .post("/:threadId/join", (context) =>
        handle(context, async (db, principal) => {
          const threadId = threadIdParam(context);
          const space = await readSpace(db, principal, threadId);
          if (space.lifecycle_state !== "active")
            throw new SpaceError(
              "INVALID_REQUEST",
              409,
              "This Space is archived.",
            );
          if (await joinSpace(db, threadId, principal.userId as UserId)) {
            await announce(context, db, threadId);
            await scheduleUserInvalidation(
              () => context.executionCtx,
              context.env,
              principal.userId as UserId,
              "sidebar.invalidated",
            );
          }
          return spaceResponse(context, db, principal, threadId);
        }),
      )
      .post("/:threadId/leave", (context) =>
        handle(context, async (db, principal) => {
          const threadId = threadIdParam(context);
          const space = await readSpace(db, principal, threadId);
          // The owner stays a member: their Space lists in their sidebar until
          // they archive it, and its welcome greets them by name.
          if (space.access === "owner")
            throw new SpaceError(
              "INVALID_REQUEST",
              409,
              "Archive the Space instead of leaving it.",
            );
          if (await leaveSpace(db, threadId, principal.userId as UserId)) {
            await announce(context, db, threadId);
            await scheduleUserInvalidation(
              () => context.executionCtx,
              context.env,
              principal.userId as UserId,
              "sidebar.invalidated",
            );
          }
          return spaceResponse(context, db, principal, threadId);
        }),
      )
      .get("/:threadId/progress", (context) =>
        handle(context, async (db, principal) => {
          const threadId = threadIdParam(context);
          const query = Schema.decodeUnknownOption(SpaceProgressQuerySchema)(
            context.req.query(),
          );
          const timeZone = Option.isSome(query)
            ? (query.value.tz ?? "UTC")
            : "";
          if (Option.isNone(query) || !isTimeZone(timeZone))
            throw invalidRequest();
          await readSpace(db, principal, threadId);
          return context.json(
            Schema.encodeUnknownSync(SpaceProgressResponseSchema)({
              status: "success",
              data: await spaceProgress(db, threadId, {
                days: query.value.days ?? SPACE_PROGRESS_DEFAULT_DAYS,
                timeZone,
                now: Date.now(),
              }),
            }),
            200,
          );
        }),
      )
      .get("/:threadId/threads", (context) =>
        handle(context, async (db, principal) => {
          const threadId = threadIdParam(context);
          const space = await readSpace(db, principal, threadId);
          return context.json(
            Schema.encodeUnknownSync(ListSpaceThreadsResponseSchema)({
              status: "success",
              data: {
                items: await spaceThreadItems(
                  db,
                  threadId,
                  principal.userId as UserId,
                  space.access,
                ),
              },
            }),
            200,
          );
        }),
      )
      // The Artifacts tab: the Space's and its threads' artifacts, each
      // from a thread the viewer may open.
      .get("/:threadId/artifacts", (context) =>
        handle(context, async (db, principal) => {
          const threadId = threadIdParam(context);
          await readSpace(db, principal, threadId);
          const rows = await listSpaceArtifactRows(
            db,
            threadId,
            principal.userId as UserId,
            {
              shared: canUseSharedThreads(principal),
              limit: SPACE_ARTIFACTS_LIMIT,
            },
          );
          return context.json(
            Schema.encodeUnknownSync(SpaceArtifactsResponseSchema)({
              status: "success",
              data: {
                items: rows.map((row) => ({
                  id: row.id,
                  title: row.title,
                  folder: row.folder,
                  updatedAt: row.updated_at,
                  thread: {
                    id: row.thread_id,
                    title: row.thread_title,
                    archived: row.lifecycle_state === "archived",
                  },
                })),
              },
            }),
            200,
          );
        }),
      )
      .get("/:threadId/threads/:childId", (context) =>
        handle(context, async (db, principal) => {
          const threadId = threadIdParam(context);
          const childId = childIdParam(context);
          const space = await readSpace(db, principal, threadId);
          const [item] = await spaceThreadItems(
            db,
            threadId,
            principal.userId as UserId,
            space.access,
            childId,
          );
          if (item === undefined) throw spaceNotFound();
          return context.json(
            Schema.encodeUnknownSync(SpaceThreadResponseSchema)({
              status: "success",
              data: { item },
            }),
            200,
          );
        }),
      )
      .get("/:threadId/catch-up", (context) =>
        handle(context, async (db, principal) => {
          const threadId = threadIdParam(context);
          await readSpace(db, principal, threadId);
          const catchUp = await readCatchUp(
            context.env,
            db,
            threadId,
            principal.userId as UserId,
          );
          return context.json(
            Schema.encodeUnknownSync(SpaceCatchUpResponseSchema)({
              status: "success",
              data: { catchUp },
            }),
            200,
          );
        }),
      )
      .post("/:threadId/catch-up/dismiss", (context) =>
        handle(context, async (db, principal) => {
          const threadId = threadIdParam(context);
          await readSpace(db, principal, threadId);
          await dismissCatchUp(db, threadId, principal.userId as UserId);
          return context.json(
            Schema.encodeUnknownSync(SpaceCatchUpResponseSchema)({
              status: "success",
              data: { catchUp: null },
            }),
            200,
          );
        }),
      )
      .get("/:threadId/posts", (context) =>
        handle(context, (db, principal) =>
          posts.list(context, db, principal, threadIdParam(context)),
        ),
      )
      .post("/:threadId/posts", (context) =>
        handle(context, (db, principal) =>
          posts.create(context, db, principal, threadIdParam(context)),
        ),
      )
      .get("/:threadId/posts/:postId/revisions", (context) =>
        handle(context, (db, principal) =>
          posts.revisions(context, db, principal, threadIdParam(context)),
        ),
      )
      .patch("/:threadId/posts/:postId", (context) =>
        handle(context, (db, principal) =>
          posts.edit(context, db, principal, threadIdParam(context)),
        ),
      )
      .put("/:threadId/posts/:postId/reactions/:reaction", (context) =>
        handle(context, (db, principal) =>
          posts.react(context, db, principal, threadIdParam(context), true),
        ),
      )
      .delete("/:threadId/posts/:postId/reactions/:reaction", (context) =>
        handle(context, (db, principal) =>
          posts.react(context, db, principal, threadIdParam(context), false),
        ),
      )
  );
};

export const spaceRoutes = createSpaceRoutes();
