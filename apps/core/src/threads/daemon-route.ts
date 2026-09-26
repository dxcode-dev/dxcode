import { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { Hono } from "hono";
import { verifyThreadDaemonApiKey } from "../auth/daemon-api-key.js";
import type { AppEnv } from "../http/types.js";

const forwardedWebSocketHeaders = [
  "connection",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
] as const;

export const threadDaemonRoutes = new Hono<AppEnv>().get(
  "/:threadId/dxd",
  async (context) => {
    const request = context.req.raw;
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return context.notFound();
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      context.req.param("threadId"),
    );
    const namespace = context.env.THREAD_EXECUTION;
    if (Option.isNone(threadId) || namespace === undefined)
      return context.notFound();
    const verified = await verifyThreadDaemonApiKey(
      context.env,
      threadId.value,
      request.headers.get("authorization"),
    );
    if (verified === undefined) return new Response(null, { status: 401 });

    const headers = new Headers({
      upgrade: "websocket",
      "x-dx-daemon-ingress": "1",
      "x-dx-daemon-key-id": verified.keyId,
      "x-dx-thread-id": threadId.value,
    });
    for (const name of forwardedWebSocketHeaders) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    return namespace
      .get(namespace.idFromName(threadId.value))
      .fetch(new Request("https://thread.internal/daemon/socket", { headers }));
  },
);
