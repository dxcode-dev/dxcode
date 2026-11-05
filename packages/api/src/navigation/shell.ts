import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/**
 * The signed-in shell's first-load reads, by name. Each is one existing
 * `GET` route, with the query the web app sends for it. The account and
 * the sidebar layout are not parts: the app waits on each before it renders
 * a page, and alone each answers sooner than the shell's slowest part.
 */
export const SHELL_PARTS = {
  settings: "/v1/settings/personal",
  projects: "/v1/projects?limit=100",
  threads: "/v1/threads?limit=100&lifecycleState=active&roots=true",
  sharedThreads: "/v1/shared-threads",
  notifications: "/v1/notifications",
  composer: "/v1/settings/personal/account/composer",
  personalProjects: "/v1/settings/personal/projects",
  modelRoutingChoices: "/v1/settings/personal/model-routing/choices",
  modelRoutingGraph: "/v1/settings/personal/model-routing/graph",
} as const;

export type ShellPartName = keyof typeof SHELL_PARTS;

/**
 * One part: the route's own HTTP status and JSON body, exactly as a direct
 * request would receive them. The owning feature decodes the body with its
 * own response schema; a part that failed carries the route's error body.
 */
export const ShellPartSchema = Schema.Struct({
  status: Schema.Int,
  body: Schema.Unknown,
});

export type ShellPart = typeof ShellPartSchema.Type;

/** `GET /v1/shell`: every part, read in one request. */
export const ShellResponseSchema = successResponse(
  Schema.Struct(
    Object.fromEntries(
      Object.keys(SHELL_PARTS).map((name) => [name, ShellPartSchema]),
    ) as { readonly [Name in ShellPartName]: typeof ShellPartSchema },
  ),
);

export type ShellResponse = typeof ShellResponseSchema.Type;
