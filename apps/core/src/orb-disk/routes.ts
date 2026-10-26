import {
  DeleteThreadOrbFolderRequestSchema,
  DeleteThreadOrbFolderResponseSchema,
  GetThreadOrbDiskResponseSchema,
  isOrbDiskPressure,
  isOrbDiskWarning,
  ORB_DISK_PRESSURE_PERCENT,
  ORB_DISK_WARNING_PERCENT,
  ThreadArchivedResponseSchema,
  type ThreadOrbDiskData,
  ThreadOrbDiskReadOnlyResponseSchema,
  type ThreadOrbFolderErrorCode,
  ThreadOrbFolderErrorResponseSchema,
} from "@dx/api";
import { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { threadDaemonLogger } from "../logging.js";
import { selectWorkspaceRuntime } from "../runtime/workspace-composition.js";
import type { OrbDiskRelayResult } from "./execution-object.js";

/** The Thread execution object, when this runtime relays to a resident. */
const executionStub = (env: AppEnv["Bindings"], threadId: ThreadId) => {
  try {
    selectWorkspaceRuntime(env, { local: "resident", deployed: "resident" });
  } catch {
    return undefined;
  }
  const namespace = env.THREAD_EXECUTION;
  return namespace?.get(namespace.idFromName(threadId));
};

const relay = async (
  env: AppEnv["Bindings"],
  threadId: ThreadId,
  path: string,
  init: RequestInit,
): Promise<OrbDiskRelayResult> => {
  const stub = executionStub(env, threadId);
  if (stub === undefined) return { workspace: "unavailable" };
  try {
    const response = await stub.fetch(
      new Request(`https://thread-execution${path}`, {
        ...init,
        headers: {
          "x-dx-thread-id": threadId,
          "content-type": "application/json",
        },
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      return { workspace: "unavailable" };
    }
    return (await response.json()) as OrbDiskRelayResult;
  } catch {
    return { workspace: "unavailable" };
  }
};

/**
 * Refuses what Orb disk refuses (read-only access, an archived Thread), or
 * answers with the Thread ID. Runs after authorizeThread.
 */
const diskRequest = (context: Context<AppEnv>) => {
  const threadId = Schema.decodeUnknownOption(ThreadId)(
    context.req.param("threadId"),
  );
  if (Option.isNone(threadId)) return { response: context.notFound() };
  const requestId = context.get("requestId");
  if (context.get("threadAccess") === "view")
    return {
      response: context.json(
        Schema.encodeUnknownSync(ThreadOrbDiskReadOnlyResponseSchema)({
          status: "error",
          data: {
            code: "THREAD_READ_ONLY",
            message:
              "Only contributors can see and delete Orb folders in a shared Thread.",
            requestId,
          },
        }),
        403,
      ),
    };
  if (context.get("threadLifecycleState") !== "active")
    return {
      response: context.json(
        Schema.encodeUnknownSync(ThreadArchivedResponseSchema)({
          status: "error",
          data: {
            code: "THREAD_ARCHIVED",
            message: "Thread is archived. Unarchive it before continuing.",
            requestId,
          },
        }),
        409,
      ),
    };
  return { threadId: threadId.value, requestId };
};

const folderError = (
  context: Context<AppEnv>,
  status: 400 | 403 | 404 | 409 | 503,
  code: ThreadOrbFolderErrorCode,
  message: string,
) =>
  context.json(
    Schema.encodeUnknownSync(ThreadOrbFolderErrorResponseSchema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );

/**
 * A Thread's Orb disk: usage, its largest folders (`?folders=1`, only
 * while a person looks at them), and deleting a rebuildable one. Every
 * provider is served the same way, through the resident daemon, and neither
 * route wakes a paused workspace. Owner or Contribute access, active Thread.
 */
export const threadOrbDiskRoutes = new Hono<AppEnv>()
  .get("/:threadId/disk", async (context) => {
    const request = diskRequest(context);
    if ("response" in request) return request.response;
    const folders = context.req.query("folders") === "1";
    const result = await relay(
      context.env,
      request.threadId,
      folders ? "/orb/disk?folders=1" : "/orb/disk",
      { method: "GET" },
    );
    const snapshot =
      "snapshot" in result && result.snapshot !== undefined
        ? result.snapshot
        : undefined;
    const usage =
      snapshot ?? ("usage" in result ? result.usage : undefined) ?? undefined;
    const data: ThreadOrbDiskData = {
      workspace: result.workspace,
      ...(usage === undefined
        ? {}
        : {
            disk: {
              usedBytes: usage.usedBytes,
              totalBytes: usage.totalBytes,
              pressure: isOrbDiskPressure(usage.usedBytes, usage.totalBytes),
              warning: isOrbDiskWarning(usage.usedBytes, usage.totalBytes),
              pressurePercent: ORB_DISK_PRESSURE_PERCENT,
              warningPercent: ORB_DISK_WARNING_PERCENT,
            },
          }),
      ...(snapshot === undefined
        ? {}
        : { folders: snapshot.folders, partial: snapshot.partial }),
    };
    context.header("cache-control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(GetThreadOrbDiskResponseSchema)({
        status: "success",
        data,
      }),
      200,
    );
  })
  .post("/:threadId/disk/folders/delete", async (context) => {
    const request = diskRequest(context);
    if ("response" in request) return request.response;
    const body = Schema.decodeUnknownOption(DeleteThreadOrbFolderRequestSchema)(
      await context.req.json().catch(() => undefined),
      { onExcessProperty: "error" },
    );
    if (Option.isNone(body))
      return folderError(
        context,
        400,
        "INVALID_REQUEST",
        "Name one folder from the disk notice.",
      );
    const result = await relay(
      context.env,
      request.threadId,
      "/orb/disk/delete",
      { method: "POST", body: JSON.stringify({ path: body.value.path }) },
    );
    if (!("deleted" in result))
      return result.workspace === "paused"
        ? folderError(
            context,
            409,
            "WORKSPACE_PAUSED",
            "The Orb is paused. Send a message or open the Terminal to wake it.",
          )
        : folderError(
            context,
            503,
            "WORKSPACE_UNAVAILABLE",
            "The Orb could not be reached. Try again.",
          );
    const { deleted } = result;
    threadDaemonLogger.info("Thread Orb folder delete requested.", {
      event: "orb_folder_delete",
      requestId: request.requestId,
      threadId: request.threadId,
      outcome: deleted.kind === "deleted" ? "deleted" : deleted.reason,
    });
    if (deleted.kind === "deleted")
      return context.json(
        Schema.encodeUnknownSync(DeleteThreadOrbFolderResponseSchema)({
          status: "success",
          data: { path: body.value.path },
        }),
        200,
      );
    if (deleted.kind === "unavailable")
      return folderError(
        context,
        503,
        "WORKSPACE_UNAVAILABLE",
        "The folder could not be deleted. Try again, or use the Terminal.",
      );
    return deleted.reason === "missing"
      ? folderError(
          context,
          404,
          "ORB_FOLDER_NOT_FOUND",
          "The folder is already gone.",
        )
      : folderError(
          context,
          403,
          "ORB_FOLDER_PROTECTED",
          "dx deletes only dependency, build, and cache folders it can rebuild.",
        );
  });
