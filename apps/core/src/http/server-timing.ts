import type { Context } from "hono";
import type { AppEnv } from "./types.js";

/**
 * A `Server-Timing` header for one request: the authentication and Thread
 * authorization middleware's time, each phase the route marks, and the total.
 * Workers advance the clock only across I/O, so each phase is its I/O time.
 */
export const requestServerTiming = (context: Context<AppEnv>) => {
  const startedAt = context.get("requestStartedAt");
  const authenticatedAt = context.get("authenticatedAt");
  const authorizedAt = context.get("threadAuthorizedAt");
  const entries: string[] = [];
  const add = (name: string, durationMs: number) =>
    entries.push(`dx_${name};dur=${Math.max(0, durationMs)}`);
  if (startedAt !== undefined && authenticatedAt !== undefined)
    add("auth", authenticatedAt - startedAt);
  if (authenticatedAt !== undefined && authorizedAt !== undefined)
    add("authorize", authorizedAt - authenticatedAt);
  let last = authorizedAt ?? authenticatedAt ?? startedAt ?? Date.now();
  return {
    mark: (phase: string) => {
      const now = Date.now();
      add(phase, now - last);
      last = now;
    },
    header: () =>
      [
        ...entries,
        ...(startedAt === undefined
          ? []
          : [`dx_total;dur=${Math.max(0, Date.now() - startedAt)}`]),
      ].join(", "),
  };
};
