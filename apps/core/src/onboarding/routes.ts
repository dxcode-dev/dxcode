import {
  OnboardingErrorResponseSchema,
  OnboardingResponseSchema,
  UpdateOnboardingRequestSchema,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { readBoundedJson } from "../http/bounded-body.js";
import type { AppEnv } from "../http/types.js";
import { onboardingLogger } from "../logging.js";
import { markOnboarding, readOnboarding } from "./repository.js";

const failure = (
  context: Context<AppEnv>,
  code: "INVALID_REQUEST" | "PERSISTENCE_UNAVAILABLE",
) =>
  context.json(
    Schema.encodeUnknownSync(OnboardingErrorResponseSchema)({
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
    onboardingLogger.error("Onboarding request failed.", {
      event: "onboarding_request_failed",
      requestId: context.get("requestId"),
      cause,
    });
    return failure(context, "PERSISTENCE_UNAVAILABLE");
  }
};

const progress = async (
  context: Context<AppEnv>,
  db: D1Database,
  userId: UserId,
) =>
  context.json(
    Schema.encodeUnknownSync(OnboardingResponseSchema)({
      status: "success",
      data: await readOnboarding(db, userId),
    }),
    200,
  );

/** Mounted at `/v1/onboarding`: the signed-in person's onboarding progress. */
export const onboardingRoutes = new Hono<AppEnv>()
  .get("/", (context) =>
    handle(context, (db, userId) => progress(context, db, userId)),
  )
  .put("/", (context) =>
    handle(context, async (db, userId) => {
      const update = Schema.decodeUnknownOption(UpdateOnboardingRequestSchema)(
        await readBoundedJson(context.req.raw).catch(() => undefined),
      );
      if (Option.isNone(update)) return failure(context, "INVALID_REQUEST");
      await markOnboarding(db, userId, update.value.done);
      return progress(context, db, userId);
    }),
  );
