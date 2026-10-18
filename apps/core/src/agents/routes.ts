import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { useAgentAdmission } from "./admission.js";
import { DxAgent } from "./dx-agent.js";

/**
 * DxAgent's native Flue routes behind dx's Thread admission, mounted at
 * `/v1/agents/dx` after authentication. The Thread tools send messages and
 * read history through these same routes as the Thread owner.
 */
export const dxAgentRoutes = useAgentAdmission(new Hono<AppEnv>());
dxAgentRoutes.route("/", createAgentRouter(DxAgent));
