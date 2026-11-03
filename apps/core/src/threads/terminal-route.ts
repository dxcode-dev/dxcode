import {
  CloseThreadTerminalRequestSchema,
  THREAD_TERMINAL_SUBPROTOCOL,
  ThreadTerminalIdSchema,
} from "@dx/api";
import { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { Hono } from "hono";
import { setBrowserSessionHeaders } from "../auth/session-sockets.js";
import type { AppEnv } from "../http/types.js";
import { selectWorkspaceRuntime } from "../runtime/workspace-composition.js";

export const threadTerminalRoutes = new Hono<AppEnv>()
  /**
   * The person is about to open the Terminal (they kept pointing at it):
   * start the Orb's wake now, on the same single-flight activation the
   * attach joins, without waiting for it. Authorized like the attach, so a
   * viewer cannot wake the Orb; the execution object limits how often.
   */
  .post("/:threadId/terminal/warm", async (context) => {
    const request = context.req.raw;
    if (request.headers.get("origin") !== new URL(request.url).origin)
      return context.notFound();
    try {
      selectWorkspaceRuntime(context.env, {
        local: "resident",
        deployed: "resident",
      });
    } catch {
      return context.notFound();
    }
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      context.req.param("threadId"),
    );
    if (Option.isNone(threadId)) return context.notFound();
    const namespace = context.env.THREAD_EXECUTION;
    if (namespace === undefined) return context.notFound();
    // The object answers at once and keeps the wake running itself.
    const response = await namespace
      .get(namespace.idFromName(threadId.value))
      .fetch("https://thread.internal/daemon/activate", {
        method: "POST",
        headers: {
          "x-dx-daemon-activate": "1",
          "x-dx-daemon-activate-mode": "background",
          "x-dx-terminal-warm": "1",
          "x-dx-thread-id": threadId.value,
        },
      })
      .catch(() => undefined);
    await response?.body?.cancel();
    return context.body(null, 202);
  })
  /**
   * The person closed a Terminal's tab: end that Terminal's shell session.
   * Authorized like the attach, so a viewer cannot end one. Never wakes the
   * Orb: a paused one ends it on its next registration.
   */
  .post("/:threadId/terminal/close", async (context) => {
    const request = context.req.raw;
    if (request.headers.get("origin") !== new URL(request.url).origin)
      return context.notFound();
    try {
      selectWorkspaceRuntime(context.env, {
        local: "resident",
        deployed: "resident",
      });
    } catch {
      return context.notFound();
    }
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      context.req.param("threadId"),
    );
    if (Option.isNone(threadId)) return context.notFound();
    const body = Schema.decodeUnknownOption(CloseThreadTerminalRequestSchema)(
      await request.json().catch(() => undefined),
    );
    if (Option.isNone(body)) return context.body(null, 400);
    const namespace = context.env.THREAD_EXECUTION;
    if (namespace === undefined) return context.notFound();
    const response = await namespace
      .get(namespace.idFromName(threadId.value))
      .fetch("https://thread.internal/terminal/close", {
        method: "POST",
        headers: {
          "x-dx-terminal-close": "1",
          "x-dx-thread-id": threadId.value,
          "x-dx-terminal-id": body.value.terminal,
        },
      });
    await response.body?.cancel();
    return context.body(null, response.ok ? 204 : 503);
  })
  .get("/:threadId/terminal", async (context) => {
    const routeReachedAt = Date.now();
    const startedAt = context.get("requestStartedAt") ?? routeReachedAt;
    const request = context.req.raw;
    const offeredProtocols = (
      request.headers.get("sec-websocket-protocol") ?? ""
    )
      .split(",")
      .map((protocol) => protocol.trim());
    if (
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      request.headers.get("origin") !== new URL(request.url).origin ||
      !offeredProtocols.includes(THREAD_TERMINAL_SUBPROTOCOL)
    )
      return context.notFound();
    try {
      selectWorkspaceRuntime(context.env, {
        local: "resident",
        deployed: "resident",
      });
    } catch {
      return context.notFound();
    }
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      context.req.param("threadId"),
    );
    if (Option.isNone(threadId)) return context.notFound();
    const terminalId = Schema.decodeUnknownOption(ThreadTerminalIdSchema)(
      context.req.query("terminal") ?? "default",
    );
    if (Option.isNone(terminalId)) return context.notFound();
    const namespace = context.env.THREAD_EXECUTION;
    if (namespace === undefined) return context.notFound();
    const requestId = context.get("requestId") ?? crypto.randomUUID();
    const admittedAt = Date.now();
    const authenticatedAt = Math.max(
      startedAt,
      context.get("authenticatedAt") ?? startedAt,
    );
    const threadAuthorizedAt = Math.max(
      authenticatedAt,
      context.get("threadAuthorizedAt") ?? authenticatedAt,
    );
    const stub = namespace.get(namespace.idFromName(threadId.value));
    const headers = new Headers({
      upgrade: "websocket",
      origin: request.headers.get("origin") as string,
      "x-dx-thread-id": threadId.value,
      "x-dx-request-id": requestId,
      "x-dx-started-at": String(startedAt),
      "x-dx-authenticated-duration": String(authenticatedAt - startedAt),
      "x-dx-authorized-duration": String(threadAuthorizedAt - startedAt),
      "x-dx-admitted-duration": String(admittedAt - startedAt),
      "x-dx-terminal-route": "resident",
      "x-dx-terminal-id": terminalId.value,
      "sec-websocket-protocol": THREAD_TERMINAL_SUBPROTOCOL,
    });
    for (const name of [
      "connection",
      "sec-websocket-extensions",
      "sec-websocket-key",
      "sec-websocket-version",
    ]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    setBrowserSessionHeaders(headers, context.get("browserSession"));
    return stub.fetch(new Request(request, { headers }));
  });
