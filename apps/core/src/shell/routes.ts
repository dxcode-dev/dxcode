import {
  type ForbiddenResponse,
  SHELL_PARTS,
  type ShellPart,
  type ShellPartName,
  ShellResponseSchema,
} from "@dx/api";
import { Schema } from "effect";
import { type Context, Hono } from "hono";
import { errorHandler, notFoundHandler } from "../http/http-errors.js";
import type { AppEnv } from "../http/types.js";
import { notificationRoutes } from "../notifications/routes.js";
import { projectRoutes } from "../projects/routes.js";
import { settingsRoutes } from "../settings/routes.js";
import { sharedThreadRoutes } from "../thread-sharing/routes.js";
import { threadRoutes } from "../threads/routes.js";

/**
 * The browser request each part runs inside. Keyed by the part's own Request,
 * which only this module creates, so nothing outside can claim a parent.
 */
const parents = new WeakMap<Request, Context<AppEnv>>();

/**
 * The routes the parts read, mounted as app.ts mounts them. Each part runs
 * as the browser request that asked for the shell: the same principal,
 * browser session, Better Auth instance, and its one D1 session read.
 */
const parts = new Hono<AppEnv>();
parts.use(async (context, next) => {
  const parent = parents.get(context.req.raw);
  if (parent === undefined) return context.notFound();
  context.set("requestId", `${parent.get("requestId")}.${context.req.path}`);
  context.set("requestStartedAt", parent.get("requestStartedAt"));
  context.set("authenticatedAt", parent.get("authenticatedAt"));
  context.set("principal", parent.get("principal"));
  const browserSession = parent.get("browserSession");
  if (browserSession !== undefined)
    context.set("browserSession", browserSession);
  const auth = parent.get("auth");
  if (auth !== undefined) context.set("auth", auth);
  const session = parent.get("authoritativeSession");
  if (session !== undefined) context.set("authoritativeSession", session);
  await next();
});
parts.route("/v1/notifications", notificationRoutes);
parts.route("/v1/projects", projectRoutes);
parts.route("/v1/settings", settingsRoutes);
parts.route("/v1/shared-threads", sharedThreadRoutes);
parts.route("/v1/threads", threadRoutes);
// A part that throws answers as app.ts would, and the other parts still do.
parts.notFound(notFoundHandler);
parts.onError(errorHandler);

/** The request's execution context; absent when a test calls the app. */
const executionOf = (context: Context<AppEnv>) => {
  try {
    return context.executionCtx;
  } catch {
    return undefined;
  }
};

const readPart = async (
  context: Context<AppEnv>,
  path: string,
): Promise<ShellPart & { readonly cookies: ReadonlyArray<string> }> => {
  const request = new Request(new URL(path, context.req.url), {
    headers: context.req.raw.headers,
  });
  parents.set(request, context);
  const response = await parts.fetch(
    request,
    context.env,
    executionOf(context),
  );
  const body: unknown = await response.json().catch(() => null);
  return {
    status: response.status,
    body,
    cookies: response.headers.getSetCookie(),
  };
};

/**
 * `GET /v1/shell`: everything the signed-in shell and its sidebar show on
 * first load, in one request. The parts run at once, so the response waits
 * for the slowest part instead of each read in turn.
 */
export const shellRoutes = new Hono<AppEnv>().get("/", async (context) => {
  // A browser's first load only: API tokens read the routes themselves.
  if (context.get("browserSession") === undefined)
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
  const names = Object.keys(SHELL_PARTS) as ShellPartName[];
  const read = await Promise.all(
    names.map((name) => readPart(context, SHELL_PARTS[name])),
  );
  const data = Object.fromEntries(
    names.map((name, index) => {
      const part = read[index];
      return [name, part && { status: part.status, body: part.body }];
    }),
  ) as Record<ShellPartName, ShellPart>;
  // A cookie a part sets, such as a refreshed session, reaches the browser
  // as it would from the part's own request.
  for (const cookie of new Set(read.flatMap((part) => part.cookies)))
    context.header("set-cookie", cookie, { append: true });
  context.header("cache-control", "no-store");
  return context.json(
    Schema.encodeUnknownSync(ShellResponseSchema)({ status: "success", data }),
  );
});
