import type { ReadinessResponse, ServiceNotReadyResponse } from "@dx/api";
import type { Handler } from "hono";
import type { AppEnv } from "../http/types.js";
import { readinessLogger } from "../logging.js";
import { checkReadiness } from "./check.js";

export const readinessHandler: Handler<AppEnv> = async (context) => {
  const readiness = await checkReadiness(context.env);

  if (readiness.ready) {
    return context.json<ReadinessResponse>({
      status: "success",
      data: { state: "ready" },
    });
  }

  const requestId = context.get("requestId");
  readinessLogger.warn("Runtime readiness check failed.", {
    event: "readiness_failed",
    readinessCategory: readiness.category,
    requestId,
  });

  return context.json<ServiceNotReadyResponse>(
    {
      status: "error",
      data: {
        code: "SERVICE_NOT_READY",
        message: "Required runtime configuration is missing or invalid.",
        requestId,
      },
    },
    503,
  );
};
