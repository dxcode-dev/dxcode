import {
  ThreadDraftErrorResponseSchema,
  ThreadDraftParamsSchema,
  type ThreadDraftResponse,
  ThreadDraftResponseSchema,
  type ThreadDraftSlot,
  UpdateThreadDraftRequestSchema,
  WorkspaceDraftErrorResponseSchema,
  WorkspaceDraftParamsSchema,
  type WorkspaceDraftSlot,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { readBoundedJson } from "../http/bounded-body.js";
import type { AppEnv } from "../http/types.js";
import { threadDraftLogger } from "../logging.js";
import { canUseSharedThreads } from "../thread-sharing/access.js";
import {
  readThreadDraft,
  readWorkspaceDraft,
  threadDraftReadable,
  workspaceDraftAllowed,
  writeThreadDraft,
  writeWorkspaceDraft,
} from "./thread-draft-store.js";

const decodeUpdate = Schema.decodeUnknownOption(UpdateThreadDraftRequestSchema);

const errorJson = (
  context: Context<AppEnv>,
  code: "INVALID_REQUEST" | "THREAD_NOT_FOUND" | "PERSISTENCE_UNAVAILABLE",
  message: string,
  status: 400 | 404 | 503,
) =>
  context.json(
    Schema.encodeUnknownSync(ThreadDraftErrorResponseSchema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );

const handle = async (
  context: Context<AppEnv>,
  run: (
    db: D1Database,
    threadId: string,
    userId: UserId,
    slot: ThreadDraftSlot | undefined,
  ) => Promise<Response>,
) => {
  const slot = context.req.query("slot");
  const params = Schema.decodeUnknownOption(ThreadDraftParamsSchema)({
    threadId: context.req.param("threadId"),
    ...(slot === undefined ? {} : { slot }),
  });
  if (Option.isNone(params))
    return errorJson(
      context,
      "INVALID_REQUEST",
      "Request validation failed.",
      400,
    );
  const db = context.env.DB;
  if (db === undefined)
    return errorJson(
      context,
      "PERSISTENCE_UNAVAILABLE",
      "Persistence is temporarily unavailable.",
      503,
    );
  const principal = context.get("principal");
  try {
    if (
      !(await threadDraftReadable(
        db,
        params.value.threadId,
        principal.userId as UserId,
        { shared: canUseSharedThreads(principal) },
      ))
    )
      return errorJson(
        context,
        "THREAD_NOT_FOUND",
        "Thread was not found.",
        404,
      );
    return await run(
      db,
      params.value.threadId,
      principal.userId as UserId,
      params.value.slot,
    );
  } catch (cause) {
    threadDraftLogger.error("Thread draft request failed.", {
      event: "thread_draft_request_failed",
      requestId: context.get("requestId"),
      cause,
    });
    return errorJson(
      context,
      "PERSISTENCE_UNAVAILABLE",
      "Persistence is temporarily unavailable.",
      503,
    );
  }
};

const draftResponse = (context: Context<AppEnv>, text: string) =>
  context.json(
    Schema.encodeUnknownSync(ThreadDraftResponseSchema)({
      status: "success",
      data: { text },
    } satisfies ThreadDraftResponse),
    200,
  );

const decodeBody = async (context: Context<AppEnv>) =>
  decodeUpdate(await readBoundedJson(context.req.raw).catch(() => null));

/**
 * `/v1/threads/:threadId/draft[?slot=]`: the signed-in person's unsent message
 * in the Thread's composer (a Space's included), or in another of its boxes
 * the slot names, kept per person so a member's draft never replaces the
 * owner's, and the same on each of their devices.
 */
export const threadDraftRoutes = new Hono<AppEnv>()
  .get("/:threadId/draft", (context) =>
    handle(context, async (db, threadId, userId, slot) =>
      draftResponse(context, await readThreadDraft(db, threadId, userId, slot)),
    ),
  )
  .put("/:threadId/draft", (context) =>
    handle(context, async (db, threadId, userId, slot) => {
      const update = await decodeBody(context);
      if (Option.isNone(update))
        return errorJson(
          context,
          "INVALID_REQUEST",
          "Request validation failed.",
          400,
        );
      await writeThreadDraft(
        db,
        threadId,
        userId,
        update.value.text,
        new Date(),
        slot,
      );
      return draftResponse(context, update.value.text);
    }),
  );

const workspaceErrorJson = (
  context: Context<AppEnv>,
  code: "INVALID_REQUEST" | "WORKSPACE_NOT_FOUND" | "PERSISTENCE_UNAVAILABLE",
  message: string,
  status: 400 | 404 | 503,
) =>
  context.json(
    Schema.encodeUnknownSync(WorkspaceDraftErrorResponseSchema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );

const handleWorkspace = async (
  context: Context<AppEnv>,
  run: (
    db: D1Database,
    workspace: string,
    userId: UserId,
    slot: WorkspaceDraftSlot,
  ) => Promise<Response>,
) => {
  const params = Schema.decodeUnknownOption(WorkspaceDraftParamsSchema)({
    workspace: context.req.param("workspace"),
    slot: context.req.param("slot"),
  });
  if (Option.isNone(params))
    return workspaceErrorJson(
      context,
      "INVALID_REQUEST",
      "Request validation failed.",
      400,
    );
  const db = context.env.DB;
  if (db === undefined)
    return workspaceErrorJson(
      context,
      "PERSISTENCE_UNAVAILABLE",
      "Persistence is temporarily unavailable.",
      503,
    );
  const userId = context.get("principal").userId as UserId;
  try {
    if (!(await workspaceDraftAllowed(db, params.value.workspace, userId)))
      return workspaceErrorJson(
        context,
        "WORKSPACE_NOT_FOUND",
        "Workspace was not found.",
        404,
      );
    return await run(db, params.value.workspace, userId, params.value.slot);
  } catch (cause) {
    threadDraftLogger.error("Workspace draft request failed.", {
      event: "workspace_draft_request_failed",
      requestId: context.get("requestId"),
      cause,
    });
    return workspaceErrorJson(
      context,
      "PERSISTENCE_UNAVAILABLE",
      "Persistence is temporarily unavailable.",
      503,
    );
  }
};

/**
 * `/v1/drafts/workspaces/:workspace/:slot`: the signed-in person's unsent New
 * Thread (`new-thread`) or New Space (`new-space`) in a workspace they belong
 * to, or `personal`; the same on each of their devices.
 */
export const workspaceDraftRoutes = new Hono<AppEnv>()
  .get("/workspaces/:workspace/:slot", (context) =>
    handleWorkspace(context, async (db, workspace, userId, slot) =>
      draftResponse(
        context,
        await readWorkspaceDraft(db, workspace, userId, slot),
      ),
    ),
  )
  .put("/workspaces/:workspace/:slot", (context) =>
    handleWorkspace(context, async (db, workspace, userId, slot) => {
      const update = await decodeBody(context);
      if (Option.isNone(update))
        return workspaceErrorJson(
          context,
          "INVALID_REQUEST",
          "Request validation failed.",
          400,
        );
      await writeWorkspaceDraft(db, workspace, userId, slot, update.value.text);
      return draftResponse(context, update.value.text);
    }),
  );
