import { BrowserAuthenticationModeResponseSchema } from "@dx/api";
import { Effect, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import {
  browserAuthenticationMode,
  createAuth,
  reviewerPasswordEnabled,
  selfhostSignupEnabled,
} from "./better-auth.js";
import { loadAuthenticationRequirements } from "./requirements.js";

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/mode", async (context) => {
  const requirements = await Effect.runPromise(
    loadAuthenticationRequirements(context.env),
  );
  const mode = browserAuthenticationMode(requirements, context.env);
  return context.json(
    Schema.encodeUnknownSync(BrowserAuthenticationModeResponseSchema)({
      mode,
      ...(mode === "email-password"
        ? {
            signupEnabled:
              requirements.environment !== "selfhost" ||
              selfhostSignupEnabled(context.env),
          }
        : {}),
      ...(reviewerPasswordEnabled(context.env, requirements)
        ? { emailPasswordEnabled: true as const }
        : {}),
      ...(mode === "magic-link" && context.env.DX_TURNSTILE_SITE_KEY
        ? { turnstileSiteKey: context.env.DX_TURNSTILE_SITE_KEY }
        : {}),
    }),
  );
});

const authRequestHandler = async (context: Context<AppEnv>) => {
  const requirements = await Effect.runPromise(
    loadAuthenticationRequirements(context.env),
  );
  const path = context.req.path.startsWith("/api/auth")
    ? context.req.path
    : context.req.path === "/"
      ? "/api/auth/"
      : `/api/auth${context.req.path}`;
  if (path === "/api/auth/update-user" || path === "/api/auth/change-email") {
    return context.body(null, 403);
  }
  if (path.startsWith("/api/auth/organization/")) {
    return context.body(null, 404);
  }
  if (
    path.startsWith("/api/auth/api-key/") ||
    path === "/api/auth/verify-password" ||
    path === "/api/auth/list-sessions" ||
    path === "/api/auth/revoke-session" ||
    path === "/api/auth/revoke-sessions" ||
    path === "/api/auth/revoke-other-sessions"
  ) {
    return context.body(null, 404);
  }
  const auth = createAuth(context.env, requirements);
  return auth.handler(context.req.raw);
};

authRoutes.all("/", authRequestHandler);
authRoutes.all("/:path{.+}", authRequestHandler);
