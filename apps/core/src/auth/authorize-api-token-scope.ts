import type { ForbiddenResponse } from "@dx/api";
import type {
  ExternalApiApplicationScope,
  PersonalApiTokenScope,
} from "@dx/domain";
import { Effect } from "effect";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/types.js";
import { authorizationLogger } from "../logging.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import { auditExternalApiApplicationRequest } from "./authenticate-application.js";

const requiredScope = (
  path: string,
  method: string,
): PersonalApiTokenScope | undefined => {
  const read = method === "GET" || method === "HEAD";
  if (path === "/v1/projects" || path.startsWith("/v1/projects/")) {
    return read ? "projects:read" : "projects:write";
  }
  if (
    path === "/v1/threads" ||
    path.startsWith("/v1/threads/") ||
    path === "/v1/shared-threads"
  ) {
    return read ? "threads:read" : "threads:write";
  }
  if (path === "/v1/agents/dx" || path.startsWith("/v1/agents/dx/")) {
    return "agents:access";
  }
  if (path === "/v1/settings" || path.startsWith("/v1/settings/")) {
    return read ? "settings:read" : "settings:write";
  }
  return undefined;
};

const requiredApplicationScope = (
  path: string,
  method: string,
): ExternalApiApplicationScope | undefined => {
  const read = method === "GET" || method === "HEAD";
  const collection = path === "/v1/projects" || path === "/v1/threads";
  const item =
    /^\/v1\/projects\/[^/]+$/.test(path) || /^\/v1\/threads\/[^/]+$/.test(path);
  if (read && (collection || item)) {
    return path.startsWith("/v1/projects") ? "projects:read" : "threads:read";
  }
  if (method === "POST" && collection) {
    return path === "/v1/projects" ? "projects:write" : "threads:write";
  }
  return undefined;
};

export const authorizeApiTokenScope: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  const principal = context.get("principal");
  const scopes = principal.apiTokenScopes;
  const applicationScope = requiredApplicationScope(
    context.req.path,
    context.req.method,
  );
  const required =
    principal.application === undefined
      ? requiredScope(context.req.path, context.req.method)
      : applicationScope;
  const audit = async (outcome: "authorized" | "rejected") => {
    if (principal.application === undefined) return;
    const db = await Effect.runPromise(decodeD1Binding(context.env.DB));
    await Effect.runPromise(
      auditExternalApiApplicationRequest(db, {
        principal,
        requestId: context.get("requestId"),
        method: context.req.method,
        path: context.req.path,
        ...(applicationScope === undefined ? {} : { scope: applicationScope }),
        outcome,
      }),
    );
  };
  if (
    scopes !== undefined &&
    (required === undefined || !scopes.includes(required))
  ) {
    await audit("rejected");
    authorizationLogger.warn("API token scope authorization failed.", {
      event: "api_token_scope_authorization_failed",
      requiredScope: required ?? "unmapped",
      requestId: context.get("requestId"),
    });
    return context.json<ForbiddenResponse>(
      {
        status: "error",
        data: {
          code: "FORBIDDEN",
          message: "The credential does not grant access to this resource.",
          requestId: context.get("requestId"),
        },
      },
      403,
    );
  }
  await audit("authorized");
  await next();
};
