import type { InternalServerErrorResponse, NotFoundResponse } from "@dx/api";
import type { ErrorHandler, NotFoundHandler } from "hono";
import { httpErrorLogger } from "../logging.js";
import type { AppEnv } from "./types.js";

export const notFoundHandler: NotFoundHandler<AppEnv> = (context) =>
  context.json<NotFoundResponse>(
    {
      status: "error",
      data: {
        code: "NOT_FOUND",
        message: "Route not found.",
        requestId: context.get("requestId"),
      },
    },
    404,
  );

export const errorHandler: ErrorHandler<AppEnv> = (_error, context) => {
  httpErrorLogger.error("Unhandled request error.", {
    event: "request_failed",
    category: "internal",
    requestId: context.get("requestId"),
  });

  return context.json<InternalServerErrorResponse>(
    {
      status: "error",
      data: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
        requestId: context.get("requestId"),
      },
    },
    500,
  );
};
