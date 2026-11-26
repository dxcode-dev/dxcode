import {
  GetThreadDesktopResponseSchema,
  GetThreadDesktopWindowsResponseSchema,
  type MacDesktopPermissions,
  MacDesktopPermissionsSchema,
  MacDesktopWindowSchema,
  ThreadDesktopMachineOwnerOnlyResponseSchema,
  ThreadDesktopReadOnlyResponseSchema,
  type ThreadDesktopSettingsData,
  ThreadDesktopSettingsInvalidResponseSchema,
  ThreadDesktopSettingsRequestSchema,
  ThreadDesktopSettingsResponseSchema,
  type ThreadDesktopState,
  ThreadDesktopWindowsActionInvalidResponseSchema,
  ThreadDesktopWindowsActionSchema,
  type ThreadDesktopWindowsData,
} from "@dx/api";
import { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { setBrowserSessionHeaders } from "../auth/session-sockets.js";
import { readBoundedJson } from "../http/bounded-body.js";
import type { AppEnv } from "../http/types.js";
import { DESKTOP_GATEWAY_PORT } from "../portals/host.js";
import { runnerCall } from "../runners/client.js";
import { RunnerOperationError } from "../runners/protocol.js";
import { ownsMachine, threadRunner } from "../runners/repository.js";
import { selectWorkspaceRuntime } from "../runtime/workspace-composition.js";
import { mayReadOrbContents } from "../thread-sharing/access.js";

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

/** A Mac runner's Desktop answers within a voxl download and start. */
const RUNNER_ENSURE_MS = 90_000;
const RUNNER_HEALTH_MS = 10_000;

/**
 * The machine a runner Thread runs on. Its Desktop is that whole machine's
 * screen: voxl run by the runner's supervisor, reached through the
 * machine's `RunnerSessionObject`, never the Thread's dxd. The app gate
 * (`desktopOwnerOnlyOnRunner`) admits only the Thread's owner.
 */
const runnerOf = async (context: Context<AppEnv>, threadId: ThreadId) => {
  const db = context.env.DB;
  if (db === undefined) return undefined;
  const runner = await threadRunner(db, threadId);
  if (runner === undefined) return undefined;
  // The Thread's owner is the machine's owner; checked again here, with the
  // signed-in person, because this socket drives a whole machine.
  const actor = context.get("actor")?.userId;
  const owned =
    actor !== undefined && (await ownsMachine(db, actor, runner.machineId));
  return { ...runner, owned };
};

const notMachineOwner = (context: Context<AppEnv>) => {
  context.header("cache-control", "no-store");
  return context.json(
    Schema.encodeUnknownSync(ThreadDesktopMachineOwnerOnlyResponseSchema)({
      status: "error",
      data: {
        code: "RUNNER_THREAD_OWNER_ONLY",
        message: "Only the machine's owner opens its Desktop.",
        requestId: context.get("requestId"),
      },
    }),
    403,
  );
};

const decodePermissions = Schema.decodeUnknownOption(
  MacDesktopPermissionsSchema,
);

/**
 * Starts the Mac's voxl through its runner and checks it answers. The
 * runner's macOS permissions (from voxl's log) pass on as `permissions`.
 */
const checkRunnerDesktop = async (
  env: AppEnv["Bindings"],
  machineId: string,
  threadId: ThreadId,
): Promise<{
  desktop: ThreadDesktopState;
  detail?: string;
  permissions?: MacDesktopPermissions;
}> => {
  const words = (value: unknown) =>
    typeof value === "string" && value.length > 0
      ? { detail: value.slice(0, 2000) }
      : {};
  try {
    const ensured = await runnerCall<{
      status?: unknown;
      detail?: unknown;
      permissions?: unknown;
    }>(env, machineId, "desktop.ensure", threadId, {}, RUNNER_ENSURE_MS);
    const permissions = Option.match(decodePermissions(ensured.permissions), {
      onNone: () => ({}),
      onSome: (value) => ({ permissions: value }),
    });
    if (ensured.status === "unsupported")
      return { desktop: "unsupported", ...words(ensured.detail) };
    if (ensured.status !== "running")
      return {
        desktop: "unavailable",
        ...words(ensured.detail),
        ...permissions,
      };
    const health = await runnerCall<{ ok?: unknown; detail?: unknown }>(
      env,
      machineId,
      "desktop.health",
      threadId,
      {},
      RUNNER_HEALTH_MS,
    );
    return health.ok === true
      ? { desktop: "ready", ...words(ensured.detail), ...permissions }
      : { desktop: "unavailable", ...words(health.detail), ...permissions };
  } catch (cause) {
    const error = RunnerOperationError.from(cause);
    return {
      desktop: "unavailable",
      detail:
        error.code === "offline"
          ? "This machine's runner is offline."
          : error.code === "invalid"
            ? "This machine's runner predates the Desktop; it updates itself when idle."
            : error.detail.slice(0, 2000),
    };
  }
};

/**
 * Asks the Mac's runner to open System Settings at one privacy pane
 * (`desktop.settings`), so the person allows dx there. The supervisor runs
 * it outside every sandbox; the reply says whether it opened, or why not.
 */
const openRunnerSettings = async (
  env: AppEnv["Bindings"],
  machineId: string,
  threadId: ThreadId,
  pane: string,
): Promise<ThreadDesktopSettingsData> => {
  try {
    await runnerCall(
      env,
      machineId,
      "desktop.settings",
      threadId,
      { pane },
      RUNNER_HEALTH_MS,
    );
    return { opened: true };
  } catch (cause) {
    const error = RunnerOperationError.from(cause);
    return {
      opened: false,
      detail:
        error.code === "offline"
          ? "This machine's runner is offline."
          : error.code === "invalid"
            ? "This machine's runner predates opening System Settings; it updates itself when idle."
            : error.detail.slice(0, 500),
    };
  }
};

const decodeMacWindow = Schema.decodeUnknownOption(MacDesktopWindowSchema);
/** At most this many Mac windows go to the viewer. */
const MAX_MAC_WINDOWS = 64;

/**
 * A Mac runner's app windows (voxl's `GET /windows`, through the runner's
 * `desktop.windows`), which the viewer can stream one of instead of the
 * whole screen. Listing never starts voxl: `unavailable` while it is not
 * running or the Mac is offline, `unsupported` when its voxl or runner
 * predates window mode.
 */
const runnerWindows = async (
  env: AppEnv["Bindings"],
  machineId: string,
  threadId: ThreadId,
): Promise<ThreadDesktopWindowsData> => {
  try {
    const listed = await runnerCall<{
      ok?: unknown;
      unsupported?: unknown;
      windows?: unknown;
    }>(env, machineId, "desktop.windows", threadId, {}, RUNNER_HEALTH_MS);
    if (listed.ok !== true)
      return {
        desktop: listed.unsupported === true ? "unsupported" : "unavailable",
        windows: [],
      };
    const macWindows = (Array.isArray(listed.windows) ? listed.windows : [])
      .flatMap((window) => Option.toArray(decodeMacWindow(window)))
      .slice(0, MAX_MAC_WINDOWS);
    return { desktop: "ready", windows: [], macWindows };
  } catch (cause) {
    return {
      desktop:
        RunnerOperationError.from(cause).code === "invalid"
          ? "unsupported"
          : "unavailable",
      windows: [],
    };
  }
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
 * opens or focuses one and answers with the windows after it. A runner
 * Thread lists its Mac's windows for window mode (the owner's only); the
 * viewer switches to one over its stream, so `POST` changes nothing there.
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
  const runner = await runnerOf(context, threadId.value);
  if (runner?.owned === false) return notMachineOwner(context);
  const stub =
    runner === undefined
      ? executionStub(context.env, threadId.value)
      : undefined;
  let data: ThreadDesktopWindowsData = { desktop: "unsupported", windows: [] };
  // The app row opens Linux Desktop apps; a Mac's Desktop lists its windows.
  if (runner !== undefined && body === undefined)
    data = await runnerWindows(context.env, runner.machineId, threadId.value);
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
 * The Desktop: a status check, its windows, and its WebSocket. A runner
 * Thread's Desktop is its Mac's, through the runner (see `runnerOf`). In an
 * Orb, voxl runs with its own
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
    const runner = await runnerOf(context, threadId.value);
    if (runner?.owned === false) return notMachineOwner(context);
    let data: {
      desktop: ThreadDesktopState;
      detail?: string;
      permissions?: MacDesktopPermissions;
      startsViewOnly?: boolean;
    };
    if (runner !== undefined) {
      data = await checkRunnerDesktop(
        context.env,
        runner.machineId,
        threadId.value,
      );
      // A real Mac someone may be using (maybe the one running the
      // viewer): it opens view-only until the person turns control on.
      if (data.desktop === "ready") data = { ...data, startsViewOnly: true };
    } else {
      const stub = executionStub(context.env, threadId.value);
      data = {
        desktop:
          stub === undefined
            ? "unsupported"
            : await checkDesktop(stub, threadId.value).catch(
                () => "unavailable" as const,
              ),
      };
    }
    context.header("cache-control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(GetThreadDesktopResponseSchema)({
        status: "success",
        data,
      }),
      200,
    );
  })
  .get("/:threadId/desktop/windows", (context) => desktopWindows(context))
  // A Mac runner's Desktop: open System Settings at the Screen Recording or
  // Accessibility pane on the Mac (the owner's only, like the Desktop).
  .post("/:threadId/desktop/settings", async (context) => {
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      context.req.param("threadId"),
    );
    if (Option.isNone(threadId)) return context.notFound();
    const request = Schema.decodeUnknownOption(
      ThreadDesktopSettingsRequestSchema,
    )(await readBoundedJson(context.req.raw).catch(() => undefined), {
      onExcessProperty: "error",
    });
    if (Option.isNone(request))
      return context.json(
        Schema.encodeUnknownSync(ThreadDesktopSettingsInvalidResponseSchema)({
          status: "error",
          data: {
            code: "INVALID_REQUEST",
            message: "Name a pane: screen-recording or accessibility.",
            requestId: context.get("requestId"),
          },
        }),
        400,
      );
    const runner = await runnerOf(context, threadId.value);
    if (runner === undefined) return context.notFound();
    if (!runner.owned) return notMachineOwner(context);
    const data = await openRunnerSettings(
      context.env,
      runner.machineId,
      threadId.value,
      request.value.pane,
    );
    context.header("cache-control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(ThreadDesktopSettingsResponseSchema)({
        status: "success",
        data,
      }),
      200,
    );
  })
  .post("/:threadId/desktop/windows", async (context) => {
    const action = Schema.decodeUnknownOption(ThreadDesktopWindowsActionSchema)(
      await readBoundedJson(context.req.raw).catch(() => undefined),
      { onExcessProperty: "error" },
    );
    if (Option.isNone(action))
      return context.json(
        Schema.encodeUnknownSync(
          ThreadDesktopWindowsActionInvalidResponseSchema,
        )({
          status: "error",
          data: {
            code: "INVALID_REQUEST",
            message: "Name an app (terminal or browser) or a window ID.",
            requestId: context.get("requestId"),
          },
        }),
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
    const runner = await runnerOf(context, threadId.value);
    if (runner?.owned === false) return notMachineOwner(context);
    if (runner !== undefined) {
      const namespace = context.env.RUNNER_SESSION;
      if (namespace === undefined) return context.notFound();
      // Only the handshake crosses: no cookies, origin, or other headers.
      return namespace.get(namespace.idFromName(runner.machineId)).fetch(
        new Request("https://runner-session/desktop/ws", {
          headers: { upgrade: "websocket", "x-dx-thread-id": threadId.value },
        }),
      );
    }
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
