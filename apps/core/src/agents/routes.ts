import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../http/types.js";
import { answerReadsWhileFirstMessagePending } from "../threads/initial-dispatch-delivery.js";
import { useAgentAdmission } from "./admission.js";
import { DxAgent } from "./dx-agent.js";

/**
 * DxAgent's native Flue routes behind dx's Thread admission, mounted at
 * `/v1/agents/dx` after authentication. The Thread tools send messages and
 * read history through these same routes as the Thread owner.
 */
const flue = createAgentRouter(DxAgent);
export const dxAgentRoutes = useAgentAdmission(new Hono<AppEnv>());
// A new Thread's first read may come before its agent has the first
// message; it is answered once the agent has it, never with a 404.
const pendingReads = answerReadsWhileFirstMessagePending(flue);
dxAgentRoutes.use("/:threadId", pendingReads);
dxAgentRoutes.use("/:threadId/:subpath{.+}", pendingReads);
dxAgentRoutes.route("/", flue);

/**
 * Ends a Thread's running turn and every message queued behind it, as Stop
 * does. It bypasses admission: archiving calls it once the Thread is
 * archived, when admission refuses Stop, for the owner it already
 * authorized (#1668).
 */
export const stopThreadAgent = async (threadId: string, env: Bindings) => {
  const response = await flue.request(
    `/${encodeURIComponent(threadId)}/abort`,
    { method: "POST" },
    env,
  );
  await response.body?.cancel();
  if (!response.ok)
    throw new Error(`Stopping the Thread's agent failed (${response.status}).`);
};
