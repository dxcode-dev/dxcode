import {
  GetThreadDesktopResponseSchema,
  GetThreadDesktopWindowsResponseSchema,
  ThreadDesktopReadOnlyResponseSchema,
  type ThreadDesktopState,
  ThreadDesktopWindowsActionSchema,
  type ThreadDesktopWindowsData,
} from "@dx/api";
import { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { setBrowserSessionHeaders } from "../auth/session-sockets.js";
import { readBoundedJson } from "../http/bounded-body.js";
import type { AppEnv } from "../http/types.js";
import { selectWorkspaceRuntime } from "../runtime/workspace-composition.js";
import { mayReadOrbContents } from "../thread-sharing/access.js";

/** The guest's voxl desktop streamer listens here on loopback only. */
export const DESKTOP_GATEWAY_PORT = 5900;
/** voxl's one WebSocket carries video, input, cursor, and clipboard. */
const DESKTOP_CHANNELS = new Set(["ws"]);
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
 * Asks the Thread execution object to start the Desktop and fetch voxl's
 * `/healthz`. The object answers `desktop-unsupported` (501) when
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

const readOnly = (context: Context<AppEnv>) =>
  context.json(
    Schema.encodeUnknownSync(ThreadDesktopReadOnlyResponseSchema)({
      status: "error",
      data: {
        code: "THREAD_READ_ONLY",
        message: "Only contributors can use the Desktop in a shared Thread.",
        requestId: context.get("requestId"),
      },
    }),
    403,
  );

/**
 * The Desktop's windows through the Thread execution object, which relays
 * to a live daemon only: `GET` lists them, `POST` with a validated action
 * opens or focuses one and answers with the windows after it.
 */
const desktopWindows = async (
  context: Context<AppEnv>,
  body?: string,
): Promise<Response> => {
  const threadId = Schema.decodeUnknownOption(ThreadId)(
    context.req.param("threadId"),
  );
  if (Option.isNone(threadId)) return context.notFound();
  if (!mayReadOrbContents(context.get("threadAccess")))
    return readOnly(context);
  const stub = executionStub(context.env, threadId.value);
  let data: ThreadDesktopWindowsData = { desktop: "unsupported", windows: [] };
  if (stub !== undefined) {
    const response = await stub
      .fetch(
        new Request("https://thread-execution/desktop/windows", {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "x-dx-thread-id": threadId.value,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body }),
        }),
      )
      .catch(() => undefined);
    data = response?.ok
      ? ((await response.json()) as ThreadDesktopWindowsData)
      : { desktop: "unavailable", windows: [] };
  }
  context.header("cache-control", "no-store");
  return context.json(
    Schema.encodeUnknownSync(GetThreadDesktopWindowsResponseSchema)({
      status: "success",
      data,
    }),
    200,
  );
};

/**
 * The Desktop: a status check, its windows, and its WebSocket. voxl runs with its own
 * sign-in off (`--enable-basic-auth=false`): these routes, after Thread authorization (owner
 * or Contribute access, active Thread), are its only way in, through the
 * Thread execution object and the resident daemon's session.
 */
export const threadDesktopRoutes = new Hono<AppEnv>()
  .get("/:threadId/desktop", async (context) => {
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      context.req.param("threadId"),
    );
    if (Option.isNone(threadId)) return context.notFound();
    if (!mayReadOrbContents(context.get("threadAccess")))
      return readOnly(context);
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
  .get("/:threadId/desktop/windows", (context) => desktopWindows(context))
  .post("/:threadId/desktop/windows", async (context) => {
    const action = Schema.decodeUnknownOption(ThreadDesktopWindowsActionSchema)(
      await readBoundedJson(context.req.raw).catch(() => undefined),
      { onExcessProperty: "error" },
    );
    if (Option.isNone(action))
      return context.json(
        {
          status: "error",
          data: {
            code: "INVALID_REQUEST",
            message: "Name an app (terminal or browser) or a window ID.",
            requestId: context.get("requestId"),
          },
        },
        400,
      );
    return desktopWindows(context, JSON.stringify(action.value));
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
    setBrowserSessionHeaders(headers, context.get("browserSession"));
    return stub.fetch(
      new Request("https://thread-execution/proxy/websocket", { headers }),
    );
  });
