import {
  type ThreadQuickActionsData,
  ThreadQuickActionsErrorResponseSchema,
  ThreadQuickActionsResponseSchema,
} from "@dx/api";
import { Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { clefAvailable } from "../workers-ai/clef.js";
import { storedQuickActions } from "./store.js";

type QuickActionsFailure =
  (typeof ThreadQuickActionsErrorResponseSchema.Type)["data"]["code"];

const FAILURES = {
  QUICK_ACTIONS_MODEL_UNAVAILABLE: [
    409,
    "Composer quick actions need Workers AI's Clef Flash, which this deployment does not provide.",
  ],
  QUICK_ACTIONS_READ_ONLY: [
    403,
    "People who can only view this Thread get no quick actions.",
  ],
} as const satisfies Record<QuickActionsFailure, readonly [number, string]>;

const failure = (context: Context<AppEnv>, code: QuickActionsFailure) => {
  const [status, message] = FAILURES[code];
  return context.json(
    Schema.encodeUnknownSync(ThreadQuickActionsErrorResponseSchema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );
};

const answer = (context: Context<AppEnv>, data: ThreadQuickActionsData) =>
  context.json(
    Schema.encodeUnknownSync(ThreadQuickActionsResponseSchema)({
      status: "success",
      data,
    }),
    200,
  );

/** The owner may snooze an active root Thread that is awake now. */
const ownerCanSnooze = async (db: D1Database, threadId: string) => {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM threads
        WHERE id = ?1 AND lifecycle_state = 'active'
          AND parent_thread_id IS NULL
          AND (snoozed_until IS NULL OR snoozed_until <= ?2)`,
    )
    .bind(threadId, new Date().toISOString())
    .first<{ ok: number }>();
  return row !== null;
};

/**
 * `GET /v1/threads/:threadId/quick-actions`, behind `authorizeThread`: the
 * actions to show above the composer after the agent's latest response, for
 * someone who can send in the Thread. It serves what the turn-end hook picked
 * (`turn-ended.ts`) and never asks a model itself. `?messageId=` names the
 * agent message on the person's screen: until the hook has picked for that
 * message the answer is `pending`, so the page asks again shortly.
 */
export const threadQuickActionsRoutes = new Hono<AppEnv>().get(
  "/:threadId/quick-actions",
  async (context) => {
    if (!clefAvailable(context.env))
      return failure(context, "QUICK_ACTIONS_MODEL_UNAVAILABLE");
    const access = context.get("threadAccess") ?? "owner";
    if (access === "view") return failure(context, "QUICK_ACTIONS_READ_ONLY");
    const threadId = context.req.param("threadId");
    const db = context.env.DB;
    if (db === undefined) return answer(context, { actions: [] });
    const shown = context.req.query("messageId");
    const picked = await storedQuickActions(db, threadId);
    if (
      picked === undefined ||
      (shown !== undefined && picked.messageId !== shown)
    )
      return answer(context, {
        actions: [],
        ...(shown === undefined || shown === "" ? {} : { pending: true }),
      });
    const canSnooze =
      access === "owner" &&
      picked.actions.some(({ kind }) => kind === "snooze") &&
      (await ownerCanSnooze(db, threadId));
    return answer(context, {
      messageId: picked.messageId,
      actions: canSnooze
        ? picked.actions
        : picked.actions.filter(({ kind }) => kind !== "snooze"),
    });
  },
);
