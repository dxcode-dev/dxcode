import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import type { AppEnv } from "../http/types.js";
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
