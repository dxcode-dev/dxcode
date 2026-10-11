import { SignInOptionsResponseSchema } from "@dx/api";
import { Effect, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { createAuth } from "./better-auth.js";
import { loadAuthenticationRequirements } from "./requirements.js";
import { loadSignInConfiguration } from "./sign-in-configuration.js";

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/sign-in-options", async (context) => {
  const value = await Effect.runPromise(
    loadAuthenticationRequirements(context.env).pipe(
      Effect.flatMap((requirements) =>
        loadSignInConfiguration(context.env, requirements),
      ),
    ),
  );
  return context.json(
    Schema.encodeUnknownSync(SignInOptionsResponseSchema)({
      providers: value.providers,
      admission: value.admission,
      allowedEmailDomains: value.allowedEmailDomains,
      emailVerification: value.emailVerification,
      ...(value.turnstile?.siteKey === undefined
        ? {}
        : { turnstileSiteKey: value.turnstile.siteKey }),
      ...(value.termsUrl === undefined ? {} : { termsUrl: value.termsUrl }),
      ...(value.privacyUrl === undefined
        ? {}
        : { privacyUrl: value.privacyUrl }),
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
    path === "/api/auth/revoke-other-sessions" ||
    // Verification emails go out on sign-up and on a password sign-in, both
    // behind their own checks; an open resend endpoint would let anyone mail
    // any unverified address.
    path === "/api/auth/send-verification-email"
  ) {
    return context.body(null, 404);
  }
  const auth = createAuth(context.env, requirements);
  return auth.handler(context.req.raw);
};

authRoutes.all("/", authRequestHandler);
authRoutes.all("/:path{.+}", authRequestHandler);
