import {
  GetThreadDesktopResponseSchema,
  ThreadDesktopReadOnlyResponseSchema,
  type ThreadDesktopState,
} from "@dx/api";
import { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { selectWorkspaceRuntime } from "../runtime/workspace-composition.js";

/** The guest's Waymote gateway listens here on loopback only. */
export const DESKTOP_GATEWAY_PORT = 5900;
const DESKTOP_CHANNELS = new Set(["stream", "audio", "control"]);
const GATEWAY_HOST = `127.0.0.1:${String(DESKTOP_GATEWAY_PORT)}`;

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

/**
 * Asks the Thread execution object to start the Desktop and fetch the
 * gateway's `/healthz`. The object answers `desktop-unsupported` (501) when
 * the workspace has no Desktop, and `desktop-unavailable` or
 * `workspace-unavailable` (503) when it could not start one.
 */
const checkDesktop = async (
  stub: DurableObjectStub,
  threadId: ThreadId,
): Promise<ThreadDesktopState> => {
  const response = await stub.fetch(
    new Request("https://thread-execution/proxy/http", {
      headers: {
        "x-dx-thread-id": threadId,
        "x-dx-proxy-port": String(DESKTOP_GATEWAY_PORT),
        "x-dx-proxy-target": "/healthz",
        "x-dx-proxy-host": GATEWAY_HOST,
        "x-dx-proxy-wake": "1",
        "x-dx-proxy-prepare": "desktop",
      },
    }),
  );
  await response.body?.cancel();
  if (response.ok) return "ready";
  return response.headers.get("x-dx-proxy-error") === "desktop-unsupported"
    ? "unsupported"
    : "unavailable";
};

/**
 * The Desktop: a status check and its three WebSockets. The gateway has no
 * authentication of its own: these routes, after Thread authorization (owner
 * or Contribute access, active Thread), are its only way in, through the
 * Thread execution object and the resident daemon's session.
 */
export const threadDesktopRoutes = new Hono<AppEnv>()
  .get("/:threadId/desktop", async (context) => {
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      context.req.param("threadId"),
    );
    if (Option.isNone(threadId)) return context.notFound();
    if (context.get("threadAccess") === "view")
      return context.json(
        Schema.encodeUnknownSync(ThreadDesktopReadOnlyResponseSchema)({
          status: "error",
          data: {
            code: "THREAD_READ_ONLY",
            message:
              "Only contributors can use the Desktop in a shared Thread.",
            requestId: context.get("requestId"),
          },
        }),
        403,
      );
    const stub = executionStub(context.env, threadId.value);
    const desktop =
      stub === undefined
        ? "unsupported"
        : await checkDesktop(stub, threadId.value).catch(
            () => "unavailable" as const,
          );
    context.header("cache-control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(GetThreadDesktopResponseSchema)({
        status: "success",
        data: { desktop },
      }),
      200,
    );
  })
  .get("/:threadId/desktop/:channel", async (context) => {
    const request = context.req.raw;
    const channel = context.req.param("channel");
    if (
      !DESKTOP_CHANNELS.has(channel) ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      request.headers.get("origin") !== new URL(request.url).origin
    )
      return context.notFound();
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      context.req.param("threadId"),
    );
    if (Option.isNone(threadId)) return context.notFound();
    const stub = executionStub(context.env, threadId.value);
    if (stub === undefined) return context.notFound();
    // Only the WebSocket handshake crosses: the browser's cookies, origin,
    // and other headers never reach the guest.
    const headers = new Headers({
      upgrade: "websocket",
      "x-dx-thread-id": threadId.value,
      "x-dx-proxy-port": String(DESKTOP_GATEWAY_PORT),
      "x-dx-proxy-target": `/${channel}`,
      "x-dx-proxy-host": GATEWAY_HOST,
      "x-dx-proxy-wake": "1",
      "x-dx-proxy-prepare": "desktop",
    });
    for (const name of [
      "connection",
      "sec-websocket-key",
      "sec-websocket-version",
      "sec-websocket-protocol",
    ]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    return stub.fetch(
      new Request("https://thread-execution/proxy/websocket", { headers }),
    );
  });
