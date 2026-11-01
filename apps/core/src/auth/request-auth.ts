import type { Context } from "hono";
import type { AppEnv } from "../http/types.js";
import { createAuth, type DxAuth } from "./better-auth.js";
import type { AuthenticationRequirements } from "./requirements.js";

/**
 * Per-request Better Auth state, shared through the Hono context so a
 * request builds Better Auth once and reads its session from D1 at most once.
 */

export type BrowserSessionLookup = Awaited<
  ReturnType<DxAuth["api"]["getSession"]>
>;

/** Better Auth for this request, built on first use. */
export const requestAuth = (
  context: Context<AppEnv>,
  requirements: AuthenticationRequirements,
): DxAuth => {
  const existing = context.get("auth");
  if (existing !== undefined) return existing;
  const auth = createAuth(context.env, requirements);
  context.set("auth", auth);
  return auth;
};

/**
 * The request's browser session read from D1, bypassing the signed cookie
 * cache, so a session ended anywhere is refused at once. The first caller
 * reads it; later callers in the same request share that read, including its
 * failure.
 */
export const authoritativeBrowserSession = (
  context: Context<AppEnv>,
  auth: DxAuth,
): Promise<BrowserSessionLookup> => {
  const existing = context.get("authoritativeSession");
  if (existing !== undefined) return existing;
  const lookup = auth.api.getSession({
    headers: context.req.raw.headers,
    query: { disableCookieCache: true },
  });
  context.set("authoritativeSession", lookup);
  return lookup;
};

/**
 * Whether the request carries Better Auth's signed session cache cookie
 * (`<prefix>.session_data`, possibly chunked). Without it Better Auth reads
 * D1 for every lookup, so the cached and authoritative lookups are the same
 * read. Any cookie name containing `session_data` counts, which only ever
 * costs an extra read.
 */
export const carriesSessionCache = (context: Context<AppEnv>) =>
  (context.req.header("cookie") ?? "").includes("session_data");
