import {
  SearchThreadsInvalidRequestResponseSchema,
  type SearchThreadsItem,
  SearchThreadsQuerySchema,
  SearchThreadsResponseSchema,
  SearchThreadsUnavailableResponseSchema,
} from "@dx/api";
import { ThreadSearchQueryError } from "@dx/domain";
import { Result, Schema } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import {
  searchThreads,
  type ThreadSearchHit,
  ThreadSearchUnavailable,
} from "./service.js";

/** One search result as clients receive it. */
export const searchThreadsItem = (hit: ThreadSearchHit): SearchThreadsItem => ({
  id: hit.id,
  title: hit.title,
  projectId: hit.project_id,
  projectName: hit.project_name,
  ownerUserId: hit.owner_user_id,
  ownerName: hit.owner_name,
  ...(hit.parent_thread_id === null
    ? {}
    : { parentThreadId: hit.parent_thread_id }),
  color: hit.color ?? "auto",
  archived: hit.lifecycle_state !== "active",
  pinned: hit.pinned_at !== null,
  ...(hit.snoozed_until !== null &&
  hit.lifecycle_state === "active" &&
  Date.parse(hit.snoozed_until) > Date.now()
    ? { snoozedUntil: hit.snoozed_until }
    : {}),
  visibility:
    hit.workspace_access === "view" || hit.workspace_access === "contribute"
      ? "workspace"
      : "private",
  state: hit.activity_status,
  lastActivityAt: hit.activity_at,
  createdAt: hit.created_at,
  ...(hit.matchedSearchText === undefined
    ? {}
    : { matchedSearchText: hit.matchedSearchText }),
});

/**
 * `GET /v1/thread-search?q=…`: the signed-in person's own reachable Threads
 * and Threads shared with them, newest activity first.
 */
export const threadSearchRoutes = new Hono<AppEnv>().get(
  "/",
  async (context) => {
    const requestId = context.get("requestId");
    const invalid = (message: string) =>
      context.json(
        Schema.encodeUnknownSync(SearchThreadsInvalidRequestResponseSchema)({
          status: "error",
          data: { code: "INVALID_REQUEST", message, requestId },
        }),
        400,
      );
    const decoded = Schema.decodeUnknownResult(SearchThreadsQuerySchema)(
      context.req.query(),
    );
    if (Result.isFailure(decoded)) return invalid("Request validation failed.");
    const db = context.env.DB;
    if (db === undefined) throw new Error("D1 binding DB is unavailable.");
    try {
      const result = await searchThreads({
        db,
        bindings: context.env,
        scope: { userId: context.get("principal").userId },
        query: decoded.success.q,
        ...(decoded.success.limit === undefined
          ? {}
          : { limit: decoded.success.limit }),
        ...(decoded.success.cursor === undefined
          ? {}
          : { cursor: decoded.success.cursor }),
      });
      return context.json(
        Schema.encodeUnknownSync(SearchThreadsResponseSchema)({
          status: "success",
          data: {
            items: result.items.map(searchThreadsItem),
            ...(result.nextCursor === undefined
              ? {}
              : { nextCursor: result.nextCursor }),
          },
        }),
        200,
      );
    } catch (error) {
      if (error instanceof ThreadSearchQueryError)
        return invalid(error.message);
      if (error instanceof ThreadSearchUnavailable)
        return context.json(
          Schema.encodeUnknownSync(SearchThreadsUnavailableResponseSchema)({
            status: "error",
            data: {
              code: "THREAD_SEARCH_UNAVAILABLE",
              message: "Thread search is unavailable.",
              requestId,
            },
          }),
          503,
        );
      throw error;
    }
  },
);
