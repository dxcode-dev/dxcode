import {
  SourceControlDeniedResponseSchema,
  SourceControlProviderFailureResponseSchema,
} from "@dx/api";
import {
  SourceControlAccessDenied,
  SourceControlProviderFailure,
} from "@dx/domain";
import { Schema } from "effect";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/types.js";
import { authorizeThreadSource } from "../source-control/admission.js";

export const enforceAgentSourceAdmission: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  // Reads, and chat between members, touch no source.
  if (
    ["GET", "HEAD", "OPTIONS"].includes(context.req.method) ||
    context.get("chatDelivery")
  ) {
    await next();
    return;
  }
  try {
    await authorizeThreadSource({
      db: context.env.DB as D1Database,
      bindings: context.env,
      threadId: context.req.param("threadId") ?? "",
      ownerUserId: context.get("principal").userId,
      waitUntil: (promise) => context.executionCtx.waitUntil(promise),
    });
  } catch (cause) {
    if (cause instanceof SourceControlAccessDenied)
      return context.json(
        Schema.encodeUnknownSync(SourceControlDeniedResponseSchema)({
          status: "error",
          data: {
            code: "SOURCE_AUTHORIZATION_DENIED",
            message:
              "Source access requires action before this operation can continue.",
            requestId: context.get("requestId"),
            reason: cause.reason,
            action: cause.action,
          },
        }),
        409,
      );
    if (cause instanceof SourceControlProviderFailure)
      return context.json(
        Schema.encodeUnknownSync(SourceControlProviderFailureResponseSchema)({
          status: "error",
          data: {
            code: "SOURCE_PROVIDER_UNAVAILABLE",
            message: "Source authorization could not be confirmed.",
            requestId: context.get("requestId"),
            retryable: cause.retryable,
          },
        }),
        503,
      );
    throw cause;
  }
  await next();
};
