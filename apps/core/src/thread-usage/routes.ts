import {
  GetThreadClaudePlanResponseSchema,
  GetThreadOrbMetricsResponseSchema,
  GetThreadOrbSessionsResponseSchema,
  GetThreadUsageRequestsResponseSchema,
  GetThreadUsageResponseSchema,
  type ThreadOrbMetricsData,
  ThreadUsageRequestsQuerySchema,
} from "@dx/api";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { selectWorkspaceRuntime } from "../runtime/workspace-composition.js";
import {
  lastThreadClaudeConnection,
  loadThreadClaudePlan,
} from "../settings/model-routing/connection-store-d1.js";
import {
  readThreadOrbSessions,
  readThreadUsage,
  readThreadUsageRequests,
} from "./repository-d1.js";

/**
 * A Thread's Cost & Usage. Every route runs after `authorizeThread`, so
 * whoever may open the Thread (owner, Contribute, or View) sees its costs,
 * and nobody else learns it exists. Reads are bounded: the summary is one
 * batch of primary-key reads, and requests, Orb sessions, and Orb metrics
 * load only when the dialog asks for them.
 */

const unavailable = (context: Context<AppEnv>) =>
  context.json(
    {
      status: "error",
      data: {
        code: "PERSISTENCE_UNAVAILABLE",
        message: "Usage is unavailable.",
        requestId: context.get("requestId"),
      },
    },
    503,
  );

const threadIdOf = (context: Context<AppEnv>) =>
  context.req.param("threadId") ?? "";

const NO_METRICS: Omit<ThreadOrbMetricsData, "orbId"> = {
  samples: [],
  memory: null,
};

/** The Thread execution object's samples; never wakes the Orb. */
const orbMetricSamples = async (
  env: AppEnv["Bindings"],
  threadId: string,
): Promise<Omit<ThreadOrbMetricsData, "orbId">> => {
  try {
    selectWorkspaceRuntime(env, { local: "resident", deployed: "resident" });
  } catch {
    return NO_METRICS;
  }
  const namespace = env.THREAD_EXECUTION;
  if (namespace === undefined) return NO_METRICS;
  const response = await namespace
    .get(namespace.idFromName(threadId))
    .fetch(
      new Request("https://thread-execution/orb/metrics", {
        headers: { "x-dx-thread-id": threadId },
      }),
    )
    .catch(() => undefined);
  if (response === undefined || !response.ok) {
    await response?.body?.cancel();
    return NO_METRICS;
  }
  return (await response.json()) as Omit<ThreadOrbMetricsData, "orbId">;
};

export const threadUsageRoutes = new Hono<AppEnv>()
  // The plan a Claude Code Thread runs on, as its composer names it. Plans
  // are the owner's connections, so only the owner reads it.
  .get("/:threadId/usage/claude-plan", async (context) => {
    const db = context.env.DB;
    if (db === undefined) return unavailable(context);
    if (context.get("threadAccess") !== "owner")
      return context.json(
        {
          status: "error",
          data: {
            code: "THREAD_OWNER_ONLY",
            message: "Only the Thread's owner sees its Claude plan.",
            requestId: context.get("requestId"),
          },
        },
        403,
      );
    const threadId = threadIdOf(context);
    const plan = await loadThreadClaudePlan(db, threadId);
    // Threads from before plans were bound ran on the plan of their latest
    // Claude Code turn, which their next turn binds.
    const connectionId =
      plan.connectionId ??
      (plan.boundAt === undefined
        ? await lastThreadClaudeConnection(
            db,
            context.get("threadOwnerUserId"),
            threadId,
          )
        : undefined);
    context.header("cache-control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(GetThreadClaudePlanResponseSchema)({
        status: "success",
        data:
          connectionId !== undefined
            ? { state: "bound", connectionId }
            : { state: plan.boundAt === undefined ? "none" : "removed" },
      }),
      200,
    );
  })
  .get("/:threadId/usage", async (context) => {
    const db = context.env.DB;
    if (db === undefined) return unavailable(context);
    const data = await readThreadUsage(
      db,
      threadIdOf(context),
      context.env.DX_RUNNER_PROFILE_CATALOG,
    );
    context.header("cache-control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(GetThreadUsageResponseSchema)({
        status: "success",
        data,
      }),
      200,
    );
  })
  .get("/:threadId/usage/requests", async (context) => {
    const db = context.env.DB;
    if (db === undefined) return unavailable(context);
    const query = Schema.decodeUnknownOption(ThreadUsageRequestsQuerySchema)(
      context.req.query(),
    );
    if (Option.isNone(query))
      return context.json(
        {
          status: "error",
          data: {
            code: "INVALID_QUERY",
            message: "Name the provider and model.",
            requestId: context.get("requestId"),
          },
        },
        400,
      );
    const data = await readThreadUsageRequests(
      db,
      threadIdOf(context),
      query.value,
    );
    context.header("cache-control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(GetThreadUsageRequestsResponseSchema)({
        status: "success",
        data,
      }),
      200,
    );
  })
  .get("/:threadId/usage/orb-sessions", async (context) => {
    const db = context.env.DB;
    if (db === undefined) return unavailable(context);
    const data = await readThreadOrbSessions(
      db,
      threadIdOf(context),
      context.req.query("cursor"),
      context.env.DX_RUNNER_PROFILE_CATALOG,
    );
    context.header("cache-control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(GetThreadOrbSessionsResponseSchema)({
        status: "success",
        data,
      }),
      200,
    );
  })
  .get("/:threadId/usage/orb-metrics", async (context) => {
    const db = context.env.DB;
    if (db === undefined) return unavailable(context);
    const threadId = threadIdOf(context);
    const [orb, metrics] = await Promise.all([
      db
        .prepare(
          "SELECT provider_sandbox_id FROM execution_workspace WHERE thread_id = ?",
        )
        .bind(threadId)
        .first<{ provider_sandbox_id: string | null }>(),
      orbMetricSamples(context.env, threadId),
    ]);
    context.header("cache-control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(GetThreadOrbMetricsResponseSchema)({
        status: "success",
        data: { orbId: orb?.provider_sandbox_id ?? null, ...metrics },
      }),
      200,
    );
  });
