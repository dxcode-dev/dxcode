import {
  ExternalApiApplicationRateLimitedResponseSchema,
  type ForbiddenResponse,
  type UnauthenticatedResponse,
} from "@dx/api";
import {
  ExternalApiApplicationRateLimited,
  PersonalApiTokenScopes,
  type Principal,
} from "@dx/domain";
import { Effect, Option, Result, Schema } from "effect";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/types.js";
import { authenticationLogger } from "../logging.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import {
  authenticateExternalApiApplication,
  decodeExternalApplicationBasicCredentials,
} from "./authenticate-application.js";
import { createAuth, sessionPrincipal } from "./better-auth.js";
import { loadAuthenticationRequirements } from "./requirements.js";

const unauthorized = (
  context: Parameters<MiddlewareHandler<AppEnv>>[0],
  challenge = "Bearer",
) => {
  context.header("WWW-Authenticate", challenge);
  return context.json<UnauthenticatedResponse>(
    {
      status: "error",
      data: {
        code: "UNAUTHENTICATED",
        message: "Authentication required.",
        requestId: context.get("requestId"),
      },
    },
    401,
  );
};

const forbidden = (context: Parameters<MiddlewareHandler<AppEnv>>[0]) =>
  context.json<ForbiddenResponse>(
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

const bearer = (header: string): string | undefined => {
  const match = /^Bearer ([A-Za-z0-9._~-]{16,1024})$/.exec(header);
  return match?.[1];
};

export const authenticate: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  const startedAt = performance.now();
  const authorization = context.req.header("authorization");
  if (
    authorization === undefined &&
    context.req.header("cookie") === undefined
  ) {
    return unauthorized(context);
  }
  let principal: Principal | undefined;
  let outcome: "session" | "api_key" | "application";

  if (authorization?.startsWith("Basic ")) {
    const credentials =
      decodeExternalApplicationBasicCredentials(authorization);
    if (credentials === undefined) {
      return unauthorized(context, 'Basic realm="dx external API"');
    }
    const db = await Effect.runPromise(decodeD1Binding(context.env.DB));
    const authentication = await Effect.runPromise(
      Effect.result(
        authenticateExternalApiApplication(db, {
          ...credentials,
          requestId: context.get("requestId"),
          method: context.req.method,
          path: context.req.path,
        }),
      ),
    );
    if (Result.isFailure(authentication)) {
      if (authentication.failure instanceof ExternalApiApplicationRateLimited) {
        context.header(
          "Retry-After",
          String(authentication.failure.retryAfterSeconds),
        );
        return context.json(
          Schema.encodeUnknownSync(
            ExternalApiApplicationRateLimitedResponseSchema,
          )({
            status: "error",
            data: {
              code: "RATE_LIMITED",
              message: "The application rate limit has been exceeded.",
              requestId: context.get("requestId"),
            },
          }),
          429,
        );
      }
      throw authentication.failure;
    }
    if (Option.isNone(authentication.success)) {
      return unauthorized(context, 'Basic realm="dx external API"');
    }
    principal = authentication.success.value;
    outcome = "application";
  } else {
    const requirements = await Effect.runPromise(
      loadAuthenticationRequirements(context.env),
    );
    const auth = createAuth(context.env, requirements);
    if (authorization !== undefined) {
      const key = bearer(authorization);
      if (key === undefined) return unauthorized(context);
      const configId = key.startsWith("dxu_")
        ? "user-keys"
        : key.startsWith("dxo_")
          ? "org-keys"
          : undefined;
      if (configId === undefined) return unauthorized(context);
      const result = await auth.api.verifyApiKey({
        body: { configId, key },
      });
      if (!result.valid || result.key === null) return unauthorized(context);
      if (result.key.configId !== "user-keys") {
        return forbidden(context);
      }
      const tokenScopes = Schema.decodeUnknownOption(PersonalApiTokenScopes)(
        result.key.permissions?.dx,
      );
      if (Option.isNone(tokenScopes)) {
        return forbidden(context);
      }
      principal = {
        userId: result.key.referenceId as Principal["userId"],
        credentialScopes: ["personal"],
        apiTokenScopes: tokenScopes.value,
      };
      outcome = "api_key";
    } else {
      const session = await auth.api.getSession({
        headers: context.req.raw.headers,
      });
      if (session === null) return unauthorized(context);
      const unsafe = !["GET", "HEAD", "OPTIONS"].includes(context.req.method);
      if (
        unsafe &&
        !requirements.trustedOrigins.includes(
          context.req.header("origin") ?? "missing-origin",
        )
      ) {
        return unauthorized(context);
      }
      principal = sessionPrincipal(session);
      outcome = "session";
    }
  }

  context.set("principal", principal);
  context.set("authenticatedAt", Date.now());
  authenticationLogger.info("Request authentication succeeded.", {
    event: "authentication_completed",
    outcome,
    requestId: context.get("requestId"),
    durationMs: Math.round(performance.now() - startedAt),
  });
  await next();
};
