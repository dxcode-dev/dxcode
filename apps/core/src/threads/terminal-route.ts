import { THREAD_TERMINAL_SUBPROTOCOL } from "@dx/api";
import { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { selectWorkspaceRuntime } from "../runtime/workspace-composition.js";

export const threadTerminalRoutes = new Hono<AppEnv>().get(
  "/:threadId/terminal",
  async (context) => {
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
    return stub.fetch(new Request(request, { headers }));
  },
);
