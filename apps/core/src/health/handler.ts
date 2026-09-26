import type { HealthResponse } from "@dx/api";
import type { Handler } from "hono";
import type { AppEnv } from "../http/types.js";

export const healthHandler: Handler<AppEnv> = (context) =>
  context.json<HealthResponse>({
    status: "success",
    data: { state: "live" },
  });
