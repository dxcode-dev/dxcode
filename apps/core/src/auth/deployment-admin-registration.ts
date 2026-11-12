// A deployment registers its routes here: its administrators' routes, its
// routes for every signed-in person, and hooks that outside services call
// with their own signature instead of a session. Public dx registers none.
import { Hono } from "hono";
import type { AppEnv } from "../http/types.js";

export const registeredDeploymentAdminRoutes = new Hono<AppEnv>();
export const registeredDeploymentRoutes = new Hono<AppEnv>();
export const registeredDeploymentHookRoutes = new Hono<AppEnv>();
