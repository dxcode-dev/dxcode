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

/**
 * What threw, for the Worker log only: the response stays generic. The message
 * and stack are cut short so one log line cannot carry a large payload.
 */
const errorDetails = (error: unknown) =>
  error instanceof Error
    ? {
        errorName: error.name,
        errorMessage: error.message.slice(0, 300),
        errorStack: error.stack?.split("\n").slice(1, 6).join("\n"),
      }
    : { errorName: typeof error };

export const errorHandler: ErrorHandler<AppEnv> = (error, context) => {
  httpErrorLogger.error("Unhandled request error.", {
    event: "request_failed",
    category: "internal",
    requestId: context.get("requestId"),
    // The path asked for: Hono's matched route can name another route when
    // routing itself failed.
    method: context.req.method,
    path: context.req.path,
    ...errorDetails(error),
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
