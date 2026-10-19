import {
  SidebarLayoutErrorResponseSchema,
  SidebarLayoutResponseSchema,
  UpdateSidebarLayoutRequestSchema,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { sidebarLayoutLogger } from "../logging.js";
import { scheduleUserInvalidation } from "../realtime/publication.js";
import { readSidebarLayout, writeSidebarLayoutEntry } from "./repository.js";

const unavailable = (context: Context<AppEnv>) =>
  context.json(
    Schema.encodeUnknownSync(SidebarLayoutErrorResponseSchema)({
      status: "error",
      data: {
        code: "PERSISTENCE_UNAVAILABLE",
        message: "Persistence is temporarily unavailable.",
        requestId: context.get("requestId"),
      },
    }),
    503,
  );

const handle = async (
  context: Context<AppEnv>,
  run: (db: D1Database, userId: UserId) => Promise<Response>,
) => {
  const db = context.env.DB;
  if (db === undefined) return unavailable(context);
  try {
    return await run(db, context.get("principal").userId as UserId);
  } catch (cause) {
    sidebarLayoutLogger.error("Sidebar layout request failed.", {
      event: "sidebar_layout_request_failed",
      requestId: context.get("requestId"),
      cause,
    });
    return unavailable(context);
  }
};

const layoutResponse = async (
  context: Context<AppEnv>,
  db: D1Database,
  userId: UserId,
) =>
  context.json(
    Schema.encodeUnknownSync(SidebarLayoutResponseSchema)({
      status: "success",
      data: { entries: await readSidebarLayout(db, userId) },
    }),
    200,
  );

/** Mounted at `/v1/sidebar-layout`: the signed-in person's sidebar layout. */
export const sidebarLayoutRoutes = new Hono<AppEnv>()
  .get("/", (context) =>
    handle(context, (db, userId) => layoutResponse(context, db, userId)),
  )
  .put("/", (context) =>
    handle(context, async (db, userId) => {
      const entry = Schema.decodeUnknownOption(
        UpdateSidebarLayoutRequestSchema,
      )(await context.req.json().catch(() => undefined));
      if (Option.isNone(entry))
        return context.json(
          Schema.encodeUnknownSync(SidebarLayoutErrorResponseSchema)({
            status: "error",
            data: {
              code: "INVALID_REQUEST",
              message: "Request validation failed.",
              requestId: context.get("requestId"),
            },
          }),
          400,
        );
      await writeSidebarLayoutEntry(db, userId, entry.value);
      // The person's other devices refetch the layout.
      await scheduleUserInvalidation(
        () => context.executionCtx,
        context.env,
        userId,
        "sidebar.invalidated",
      );
      return layoutResponse(context, db, userId);
    }),
  );
