import { type Context, Hono } from "hono";
import { isolateRequestOrdinal } from "../http/request-logging.js";
import type { AppEnv } from "../http/types.js";
import { threadDaemonLogger } from "../logging.js";
import { forwardDaemonUpgrade } from "./daemon-ingress.js";

/**
 * Daemon ingress on the Core Worker. Deployed stages route `/v1/dxd/*` to the
 * dedicated ingress Worker instead; this serves local mode and guests whose
 * static configuration names the older `/v1/threads/:threadId/dxd` endpoint.
 * Neither path touches D1: the Thread execution object checks the key.
 */
const ingress = async (context: Context<AppEnv>) => {
  const startedAt = performance.now();
  const isolateRequest = isolateRequestOrdinal();
  const threadId = context.req.param("threadId") as string | undefined;
  const response = await forwardDaemonUpgrade(
    context.req.raw,
    context.env.THREAD_EXECUTION,
    threadId,
  );
  if (response.status !== 404)
    threadDaemonLogger.info("Thread daemon ingress.", {
      event: "thread_daemon_ingress",
      threadId,
      status: response.status,
      isolateRequest,
      colo: (context.req.raw as { cf?: { colo?: unknown } }).cf?.colo,
      acceptMs: Math.round(performance.now() - startedAt),
    });
  return response;
};

export const threadDaemonRoutes = new Hono<AppEnv>()
  .get("/dxd/:threadId", ingress)
  .get("/threads/:threadId/dxd", ingress);
