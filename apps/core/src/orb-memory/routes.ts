import {
  GetThreadOrbMemoryResponseSchema,
  isOrbMemoryPressure,
  ORB_MEMORY_PRESSURE_PERCENT,
  OrbProcessIdSchema,
  StopThreadOrbProcessResponseSchema,
  ThreadArchivedResponseSchema,
  type ThreadOrbMemoryData,
  ThreadOrbMemoryReadOnlyResponseSchema,
  type ThreadOrbProcessErrorCode,
  ThreadOrbProcessErrorResponseSchema,
} from "@dx/api";
import { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { threadDaemonLogger } from "../logging.js";
import { selectWorkspaceRuntime } from "../runtime/workspace-composition.js";
import type { OrbMemoryRelayResult } from "./execution-object.js";

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
  stub: DurableObjectStub,
  threadId: ThreadId,
  init: RequestInit & { readonly path: "/orb/memory" | "/orb/memory/stop" },
): Promise<OrbMemoryRelayResult> => {
  const response = await stub.fetch(
    new Request(`https://thread-execution${init.path}`, {
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
  return (await response.json()) as OrbMemoryRelayResult;
};

/**
 * Refuses what Orb memory refuses (read-only access, an archived Thread),
 * or answers with the Thread ID. Runs after authorizeThread.
 */
const memoryRequest = (context: Context<AppEnv>) => {
  const threadId = Schema.decodeUnknownOption(ThreadId)(
    context.req.param("threadId"),
  );
  if (Option.isNone(threadId)) return { response: context.notFound() };
  const requestId = context.get("requestId");
  if (context.get("threadAccess") === "view")
    return {
      response: context.json(
        Schema.encodeUnknownSync(ThreadOrbMemoryReadOnlyResponseSchema)({
          status: "error",
          data: {
            code: "THREAD_READ_ONLY",
            message:
              "Only contributors can see and stop Orb processes in a shared Thread.",
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

const processError = (
  context: Context<AppEnv>,
  status: 400 | 403 | 404 | 409 | 503,
  code: ThreadOrbProcessErrorCode,
  message: string,
) =>
  context.json(
    Schema.encodeUnknownSync(ThreadOrbProcessErrorResponseSchema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );

/**
 * A Thread's Orb memory: usage, the largest processes, and stopping one.
 * Every provider is served the same way, through the resident daemon, and
 * neither route wakes a paused workspace. Owner or Contribute access, active
 * Thread.
 */
export const threadOrbMemoryRoutes = new Hono<AppEnv>()
  .get("/:threadId/memory", async (context) => {
    const request = memoryRequest(context);
    if ("response" in request) return request.response;
    const stub = executionStub(context.env, request.threadId);
    const result: OrbMemoryRelayResult =
      stub === undefined
        ? { workspace: "unavailable" }
        : await relay(stub, request.threadId, {
            path: "/orb/memory",
            method: "GET",
          }).catch(() => ({ workspace: "unavailable" as const }));
    const snapshot =
      "snapshot" in result && result.snapshot !== undefined
        ? result.snapshot
        : undefined;
    const data: ThreadOrbMemoryData = {
      workspace: result.workspace,
      ...(snapshot === undefined
        ? {}
        : {
            memory: {
              usedBytes: snapshot.usedBytes,
              totalBytes: snapshot.totalBytes,
              pressure: isOrbMemoryPressure(
                snapshot.usedBytes,
                snapshot.totalBytes,
              ),
              pressurePercent: ORB_MEMORY_PRESSURE_PERCENT,
            },
          }),
      processes: snapshot?.processes ?? [],
    };
    context.header("cache-control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(GetThreadOrbMemoryResponseSchema)({
        status: "success",
        data,
      }),
      200,
    );
  })
  .post("/:threadId/memory/processes/:processId/stop", async (context) => {
    const request = memoryRequest(context);
    if ("response" in request) return request.response;
    const processId = Schema.decodeUnknownOption(OrbProcessIdSchema)(
      context.req.param("processId"),
    );
    if (Option.isNone(processId))
      return processError(
        context,
        400,
        "INVALID_REQUEST",
        "The process ID must be <pid>-<start time>.",
      );
    const stub = executionStub(context.env, request.threadId);
    const result: OrbMemoryRelayResult =
      stub === undefined
        ? { workspace: "unavailable" }
        : await relay(stub, request.threadId, {
            path: "/orb/memory/stop",
            method: "POST",
            body: JSON.stringify({ process: processId.value }),
          }).catch(() => ({ workspace: "unavailable" as const }));
    if (!("stop" in result))
      return result.workspace === "paused"
        ? processError(
            context,
            409,
            "WORKSPACE_PAUSED",
            "The Orb is paused; its processes are already stopped.",
          )
        : processError(
            context,
            503,
            "WORKSPACE_UNAVAILABLE",
            "The Orb could not be reached. Try again.",
          );
    const { stop } = result;
    threadDaemonLogger.info("Thread Orb process stop requested.", {
      event: "orb_process_stop",
      requestId: request.requestId,
      threadId: request.threadId,
      outcome: stop.kind === "stop" ? stop.state : stop.reason,
    });
    if (stop.kind === "stop")
      return context.json(
        Schema.encodeUnknownSync(StopThreadOrbProcessResponseSchema)({
          status: "success",
          data: { id: processId.value, state: stop.state },
        }),
        200,
      );
    return stop.reason === "protected"
      ? processError(
          context,
          403,
          "ORB_PROCESS_PROTECTED",
          "This process belongs to dx and keeps the Orb running.",
        )
      : processError(
          context,
          404,
          "ORB_PROCESS_NOT_FOUND",
          "The process is no longer running.",
        );
  });
