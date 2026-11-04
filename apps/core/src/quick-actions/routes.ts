import {
  COMPOSER_QUICK_ACTIONS_FEATURE,
  type ThreadQuickActionsData,
  ThreadQuickActionsErrorResponseSchema,
  ThreadQuickActionsResponseSchema,
} from "@dx/api";
import type { ExperimentalFeatureId, UserId } from "@dx/domain";
import { Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { experimentalFeatureEnabled } from "../settings/experimental-features/routes.js";
import { readHistory } from "../thread-search/history.js";
import { clefAvailable } from "../workers-ai/clef.js";
import {
  chooseQuickActions,
  endedTurn,
  type QuickActionsCaller,
  workersAiQuickActions,
} from "./actions.js";
import { cachedQuickActions, cacheQuickActions } from "./cache.js";

type QuickActionsFailure =
  (typeof ThreadQuickActionsErrorResponseSchema.Type)["data"]["code"];

const FAILURES = {
  QUICK_ACTIONS_DISABLED: [
    404,
    "Composer quick actions are off. Turn them on in Settings, Experimental Features.",
  ],
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
 * someone who can send in the Thread and has the personal
 * `composer-quick-actions` flag on. `?messageId=` names the agent message
 * on the person's screen, so a cached pick answers without reading Flue's
 * history. `call` is the Clef call and
 * `readTurnHistory` Flue's history read; tests replace both.
 */
export const createThreadQuickActionsRoutes = (
  call: QuickActionsCaller = workersAiQuickActions,
  readTurnHistory: typeof readHistory = readHistory,
) =>
  new Hono<AppEnv>().get("/:threadId/quick-actions", async (context) => {
    const actor = context.get("actor") ?? context.get("principal");
    if (
      !(await experimentalFeatureEnabled(
        context.env,
        actor,
        COMPOSER_QUICK_ACTIONS_FEATURE as ExperimentalFeatureId,
      ))
    )
      return failure(context, "QUICK_ACTIONS_DISABLED");
    if (!clefAvailable(context.env))
      return failure(context, "QUICK_ACTIONS_MODEL_UNAVAILABLE");
    const access = context.get("threadAccess") ?? "owner";
    if (access === "view") return failure(context, "QUICK_ACTIONS_READ_ONLY");
    const threadId = context.req.param("threadId");
    const db = context.env.DB;
    const canSnooze =
      access === "owner" &&
      db !== undefined &&
      (await ownerCanSnooze(db, threadId));
    // The message the person sees: its pick may be cached already.
    const shown = context.req.query("messageId");
    if (shown !== undefined && shown !== "" && shown.length <= 200) {
      const cached = await cachedQuickActions(threadId, shown, canSnooze);
      if (cached !== undefined)
        return answer(context, { messageId: shown, actions: cached });
    }
    const ownerUserId = (context.get("threadOwnerUserId") ??
      actor.userId) as UserId;
    const history = await readTurnHistory(
      context.env,
      ownerUserId,
      threadId,
      1,
    );
    const turn = history.kind === "page" ? endedTurn(history.page) : undefined;
    if (turn === undefined) return answer(context, { actions: [] });
    const cached =
      turn.messageId === shown
        ? undefined
        : await cachedQuickActions(threadId, turn.messageId, canSnooze);
    if (cached !== undefined)
      return answer(context, { messageId: turn.messageId, actions: cached });
    const chosen = await chooseQuickActions(call, context.env, turn, canSnooze);
    if (chosen !== undefined)
      await cacheQuickActions(threadId, turn.messageId, canSnooze, chosen);
    return answer(context, {
      messageId: turn.messageId,
      actions: chosen ?? [],
    });
  });

export const threadQuickActionsRoutes = createThreadQuickActionsRoutes();
