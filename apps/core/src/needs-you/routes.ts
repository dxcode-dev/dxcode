import {
  NeedsYouAskErrorResponseSchema,
  NeedsYouAsksResponseSchema,
  NeedsYouErrorResponseSchema,
  NeedsYouRankingErrorResponseSchema,
  NeedsYouRankingResponseSchema,
  NeedsYouRankRequestSchema,
  NeedsYouResponseSchema,
  TickNeedsYouAskRequestSchema,
  TickNeedsYouAskResponseSchema,
} from "@dx/api";
import { type ExperimentalFeatureId, ThreadId, type UserId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { notificationLogger } from "../logging.js";
import { scheduleUserInvalidation } from "../realtime/publication.js";
import { experimentalFeatureEnabled } from "../settings/experimental-features/routes.js";
import type { DeliverArtifactWake } from "../thread-artifacts/ask-effects.js";
import { listArtifactAsks, tickArtifactAsk } from "./asks.js";
import {
  defaultRankingModel,
  loadRanking,
  RANKING_MODELS,
  type RankingCaller,
  rankingModels,
  rankNeedsYou,
  saveRanking,
  workersAiRanking,
} from "./ranking.js";
import { dismissNeedsYou, listNeedsYou } from "./repository.js";

const failure = (
  context: Context<AppEnv>,
  code: "INVALID_REQUEST" | "PERSISTENCE_UNAVAILABLE",
) =>
  context.json(
    Schema.encodeUnknownSync(NeedsYouErrorResponseSchema)({
      status: "error",
      data:
        code === "INVALID_REQUEST"
          ? {
              code,
              message: "Request validation failed.",
              requestId: context.get("requestId"),
            }
          : {
              code,
              message: "Persistence is temporarily unavailable.",
              requestId: context.get("requestId"),
            },
    }),
    code === "INVALID_REQUEST" ? 400 : 503,
  );

const handle = async (
  context: Context<AppEnv>,
  run: (db: D1Database, userId: UserId) => Promise<Response>,
) => {
  const db = context.env.DB;
  if (db === undefined) return failure(context, "PERSISTENCE_UNAVAILABLE");
  try {
    return await run(db, context.get("principal").userId as UserId);
  } catch (cause) {
    notificationLogger.error("Needs-you request failed.", {
      event: "needs_you_request_failed",
      requestId: context.get("requestId"),
      cause,
    });
    return failure(context, "PERSISTENCE_UNAVAILABLE");
  }
};

const listResponse = async (
  context: Context<AppEnv>,
  db: D1Database,
  userId: UserId,
) =>
  context.json(
    Schema.encodeUnknownSync(NeedsYouResponseSchema)({
      status: "success",
      data: {
        items: await listNeedsYou(db, userId, new Date().toISOString()),
      },
    }),
    200,
  );

const PRIORITIZE_FEATURE = "needs-you-prioritize" as ExperimentalFeatureId;

type RankingFailure =
  (typeof NeedsYouRankingErrorResponseSchema.Type)["data"]["code"];

const RANKING_FAILURES = {
  INVALID_REQUEST: [400, "Request validation failed."],
  PERSISTENCE_UNAVAILABLE: [503, "Persistence is temporarily unavailable."],
  RANKING_DISABLED: [
    404,
    "Prioritize is off. Turn it on in Settings, Experimental Features.",
  ],
  NOTHING_TO_RANK: [409, "Nothing waits on you, so there is nothing to rank."],
  RANKING_MODEL_UNAVAILABLE: [
    409,
    "Prioritize needs Workers AI's Clef models, which this deployment does not provide.",
  ],
  RANKING_FAILED: [502, "Clef did not return a usable ranking. Try again."],
} as const satisfies Record<RankingFailure, readonly [number, string]>;

const rankingFailure = (context: Context<AppEnv>, code: RankingFailure) => {
  const [status, message] = RANKING_FAILURES[code];
  return context.json(
    Schema.encodeUnknownSync(NeedsYouRankingErrorResponseSchema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );
};

/**
 * Prioritize's routes run only for the signed-in person with the flag on,
 * and read and write only their own inbox and ranking.
 */
const handleRanking = async (
  context: Context<AppEnv>,
  run: (db: D1Database, userId: UserId) => Promise<Response>,
) => {
  const db = context.env.DB;
  if (db === undefined)
    return rankingFailure(context, "PERSISTENCE_UNAVAILABLE");
  const principal = context.get("principal");
  try {
    if (
      !(await experimentalFeatureEnabled(
        context.env,
        principal,
        PRIORITIZE_FEATURE,
      ))
    )
      return rankingFailure(context, "RANKING_DISABLED");
    return await run(db, principal.userId as UserId);
  } catch (cause) {
    notificationLogger.error("Needs-you ranking request failed.", {
      event: "needs_you_ranking_request_failed",
      requestId: context.get("requestId"),
      cause,
    });
    return rankingFailure(context, "PERSISTENCE_UNAVAILABLE");
  }
};

const rankingResponse = async (
  context: Context<AppEnv>,
  db: D1Database,
  userId: UserId,
) => {
  const [ranking, models] = await Promise.all([
    loadRanking(db, userId),
    Promise.resolve(rankingModels(context.env)),
  ]);
  const defaultModel = defaultRankingModel(models, ranking?.model);
  return context.json(
    Schema.encodeUnknownSync(NeedsYouRankingResponseSchema)({
      status: "success",
      data: {
        ...(ranking === undefined ? {} : { ranking }),
        models,
        ...(defaultModel === undefined ? {} : { defaultModel }),
      },
    }),
    200,
  );
};

const ASKS_FEATURE = "artifact-asks" as ExperimentalFeatureId;

type AskFailure = (typeof NeedsYouAskErrorResponseSchema.Type)["data"]["code"];

const ASK_FAILURES = {
  INVALID_REQUEST: [400, "Request validation failed."],
  ASKS_DISABLED: [
    404,
    "Asks in artifacts are off. Turn them on in Settings, Experimental Features.",
  ],
  ASK_NOT_FOUND: [404, "That ask is not open anymore."],
  THREAD_READ_ONLY: [
    403,
    "You can view this Thread. Ask its owner for Contribute access.",
  ],
  PERSISTENCE_UNAVAILABLE: [503, "Persistence is temporarily unavailable."],
} as const satisfies Record<AskFailure, readonly [number, string]>;

const askFailure = (context: Context<AppEnv>, code: AskFailure) => {
  const [status, message] = ASK_FAILURES[code];
  return context.json(
    Schema.encodeUnknownSync(NeedsYouAskErrorResponseSchema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );
};

/** The asks routes run only with the `artifact-asks` flag on, as the person. */
const handleAsks = async (
  context: Context<AppEnv>,
  run: (db: D1Database, userId: UserId) => Promise<Response>,
) => {
  const db = context.env.DB;
  if (db === undefined) return askFailure(context, "PERSISTENCE_UNAVAILABLE");
  const principal = context.get("principal");
  try {
    if (
      !(await experimentalFeatureEnabled(context.env, principal, ASKS_FEATURE))
    )
      return askFailure(context, "ASKS_DISABLED");
    return await run(db, principal.userId as UserId);
  } catch (cause) {
    notificationLogger.error("Needs-you asks request failed.", {
      event: "needs_you_asks_request_failed",
      requestId: context.get("requestId"),
      cause,
    });
    return askFailure(context, "PERSISTENCE_UNAVAILABLE");
  }
};

/**
 * Mounted at `/v1/needs-you`: the signed-in person's Threads that wait on
 * them, across every Project they reach, and behind the
 * `needs-you-prioritize` flag, their saved ranking of what to unblock first.
 * `callRanking` is the Clef call; tests replace it.
 */
export const createNeedsYouRoutes = (
  callRanking: RankingCaller = workersAiRanking,
  deliverWake?: DeliverArtifactWake,
) =>
  new Hono<AppEnv>()
    .get("/", (context) =>
      handle(context, (db, userId) => listResponse(context, db, userId)),
    )
    .get("/asks", (context) =>
      handleAsks(context, async (db, userId) =>
        context.json(
          Schema.encodeUnknownSync(NeedsYouAsksResponseSchema)({
            status: "success",
            data: { asks: [...(await listArtifactAsks(db, userId))] },
          }),
          200,
        ),
      ),
    )
    .post("/asks/tick", (context) =>
      handleAsks(context, async (_db, userId) => {
        const body = Schema.decodeUnknownOption(TickNeedsYouAskRequestSchema)(
          await context.req.json().catch(() => undefined),
        );
        if (Option.isNone(body)) return askFailure(context, "INVALID_REQUEST");
        const result = await tickArtifactAsk(
          context.env,
          { userId, ...body.value },
          {
            ...(deliverWake === undefined ? {} : { deliver: deliverWake }),
            waitUntil: (promise) => {
              try {
                context.executionCtx.waitUntil(promise);
              } catch {
                // No ExecutionContext in tests: the work still runs.
              }
            },
          },
        );
        if (result.kind === "not-found")
          return askFailure(context, "ASK_NOT_FOUND");
        if (result.kind === "read-only")
          return askFailure(context, "THREAD_READ_ONLY");
        return context.json(
          Schema.encodeUnknownSync(TickNeedsYouAskResponseSchema)({
            status: "success",
            data: { ticked: true, revision: result.revision },
          }),
          200,
        );
      }),
    )
    .get("/ranking", (context) =>
      handleRanking(context, (db, userId) =>
        rankingResponse(context, db, userId),
      ),
    )
    .post("/ranking", (context) =>
      handleRanking(context, async (db, userId) => {
        const body = Schema.decodeUnknownOption(NeedsYouRankRequestSchema)(
          await context.req.json().catch(() => undefined),
        );
        if (Option.isNone(body))
          return rankingFailure(context, "INVALID_REQUEST");
        const now = new Date();
        const [items, saved] = await Promise.all([
          listNeedsYou(db, userId, now.toISOString()),
          loadRanking(db, userId),
        ]);
        if (items.length === 0)
          return rankingFailure(context, "NOTHING_TO_RANK");
        const models = rankingModels(context.env);
        const picked =
          body.value.model ?? defaultRankingModel(models, saved?.model);
        // Only a Clef model this deployment serves.
        const model = RANKING_MODELS.find(
          (entry) =>
            entry.model === picked &&
            models.some(({ model: served }) => served === entry.model),
        );
        if (model === undefined)
          return rankingFailure(context, "RANKING_MODEL_UNAVAILABLE");
        const started = Date.now();
        const ranked = await rankNeedsYou(
          callRanking,
          context.env,
          model.model,
          items,
          now.getTime(),
        );
        if (ranked === undefined) {
          notificationLogger.warn("Needs-you ranking was unusable.", {
            event: "needs_you_ranking_unusable",
            model: model.model,
          });
          return rankingFailure(context, "RANKING_FAILED");
        }
        await saveRanking(db, userId, {
          rankedAt: new Date().toISOString(),
          model: model.model,
          modelName: model.name,
          items: ranked,
        });
        notificationLogger.info("Needs-you ranking saved.", {
          event: "needs_you_ranking_saved",
          model: model.model,
          asks: items.length,
          durationMs: Date.now() - started,
        });
        return rankingResponse(context, db, userId);
      }),
    )
    .delete("/:threadId", (context) =>
      handle(context, async (db, userId) => {
        const threadId = Schema.decodeUnknownOption(ThreadId)(
          context.req.param("threadId"),
        );
        if (Option.isNone(threadId)) return failure(context, "INVALID_REQUEST");
        // Dismissing one already gone is the same outcome: the list without it.
        if (await dismissNeedsYou(db, userId, threadId.value))
          await scheduleUserInvalidation(
            () => context.executionCtx,
            context.env,
            userId,
            "needs-you.invalidated",
          );
        return listResponse(context, db, userId);
      }),
    );

export const needsYouRoutes = createNeedsYouRoutes();
