import {
  GetOrbUsageResponseSchema,
  type OrbUsageRowData,
  OrbUsageUnavailableResponseSchema,
} from "@dx/api";
import { ThreadId } from "@dx/domain";
import { DateTime, Schema } from "effect";
import { Hono } from "hono";
import { registeredOrbBilling } from "../execution/orb-billing-registration.js";
import type { AppEnv } from "../http/types.js";
import { orbProvidersLogger } from "../logging.js";
import { ORB_USAGE_WINDOW_MS, type OrbRunSummary } from "./runs.js";

/** The Orbs Settings → Usage → Orb looks at: the person's most recent. */
const ORB_THREAD_LIMIT = 20;
const PAUSED_LIMIT = 10;

const OrbThreadRow = Schema.Struct({
  id: ThreadId,
  title: Schema.String,
  project_name: Schema.NullOr(Schema.String),
  size: Schema.NullOr(Schema.String),
});

/**
 * Every Thread of the person's that has had an Orb, most recently active
 * first. Archived Threads stay: their Orbs paused when they were archived.
 */
const orbThreadsSql = `
  SELECT
    thread.id,
    thread.title,
    project.name AS project_name,
    workspace.runner_profile_id AS size
  FROM threads AS thread
  INNER JOIN execution_workspace AS workspace ON workspace.thread_id = thread.id
  LEFT JOIN projects AS project ON project.id = thread.project_id
  WHERE thread.owner_user_id = ?
    AND thread.lifecycle_state <> 'deleted'
    AND workspace.state = 'initialized'
  ORDER BY COALESCE(thread.last_activity_at, thread.updated_at) DESC, thread.id DESC
  LIMIT ${ORB_THREAD_LIMIT}`;

/** The Thread's own run record, from its execution object; no Orb call. */
const runSummary = async (
  env: AppEnv["Bindings"],
  threadId: ThreadId,
): Promise<OrbRunSummary | undefined> => {
  const namespace = env.THREAD_EXECUTION;
  if (namespace === undefined) return undefined;
  try {
    const response = await namespace.get(namespace.idFromName(threadId)).fetch(
      new Request("https://thread-execution/orb/usage", {
        headers: { "x-dx-thread-id": threadId },
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    return (await response.json()) as OrbRunSummary;
  } catch {
    return undefined;
  }
};

const instant = (epochMs: number) => DateTime.makeUnsafe(epochMs);

type MeteredUsage = { readonly ms: number; readonly micros: number };

/** The start of `now`'s UTC month (epoch ms), as Billing counts a month. */
const monthStart = (now: number) => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

/** Threads the month's table lists at most, most credits first. */
const MONTH_THREAD_LIMIT = 50;

/**
 * This month's metered Orb time per Thread, with each Thread's title and
 * project while it is still the person's, and the totals of every Thread.
 */
const monthUsage = async (
  db: D1Database,
  userId: string,
  from: number,
  usage: ReadonlyMap<string, MeteredUsage>,
) => {
  const ranked = [...usage]
    .filter(([, { ms }]) => ms > 0)
    .toSorted(([, left], [, right]) => right.micros - left.micros);
  const listed = ranked.slice(0, MONTH_THREAD_LIMIT);
  const titles = new Map<
    string,
    { title: string; project_name: string | null }
  >();
  if (listed.length > 0) {
    const { results } = await db
      .prepare(
        `SELECT thread.id, thread.title, project.name AS project_name
           FROM threads AS thread
           LEFT JOIN projects AS project ON project.id = thread.project_id
          WHERE thread.owner_user_id = ?1
            AND thread.lifecycle_state <> 'deleted'
            AND thread.id IN (SELECT value FROM json_each(?2))`,
      )
      .bind(userId, JSON.stringify(listed.map(([threadId]) => threadId)))
      .all<{ id: string; title: string; project_name: string | null }>();
    for (const row of results) titles.set(row.id, row);
  }
  return {
    from: instant(from),
    totalMs: ranked.reduce((total, [, { ms }]) => total + ms, 0),
    totalCostMicros: ranked.reduce(
      (total, [, { micros }]) => total + micros,
      0,
    ),
    threads: listed.map(([threadId, { ms, micros }]) => ({
      threadId,
      title: titles.get(threadId)?.title ?? null,
      projectName: titles.get(threadId)?.project_name ?? null,
      ms,
      costMicros: micros,
    })),
  };
};

export const personalOrbUsageRoutes = new Hono<AppEnv>();

/**
 * Settings → Usage → Orb: the person's running Orbs and the most recently
 * paused, with each Orb's time in the last 24 hours. An Orb the deployment
 * meters shows the metered time and its cost; any other shows the time its
 * Thread's execution object saw the Orb's daemon connected. Where the
 * deployment meters Orbs, it also lists this month's charged Orb time per
 * Thread: the page Orb time shows on, since Billing lists only its total.
 */
personalOrbUsageRoutes.get("/", async (context) => {
  const db = context.env.DB;
  const userId = context.get("principal").userId;
  const now = Date.now();
  try {
    if (db === undefined) throw new Error("Orb usage needs D1.");
    const { results } = await db.prepare(orbThreadsSql).bind(userId).all();
    const threads = results.map((row) =>
      Schema.decodeUnknownSync(OrbThreadRow)(row),
    );
    const usage = registeredOrbBilling.meteredOrbUsage;
    const monthFrom = monthStart(now);
    const [summaries, metered, month] = await Promise.all([
      Promise.all(threads.map((thread) => runSummary(context.env, thread.id))),
      usage?.({ userId, from: now - ORB_USAGE_WINDOW_MS, until: now }) ??
        Promise.resolve(new Map<string, MeteredUsage>()),
      usage === undefined
        ? Promise.resolve(undefined)
        : usage({ userId, from: monthFrom, until: now }),
    ]);
    const running: Array<OrbUsageRowData & { readonly since: number }> = [];
    const paused: Array<OrbUsageRowData & { readonly at: number }> = [];
    threads.forEach((thread, index) => {
      const summary = summaries[index];
      const meteredUsage = metered.get(thread.id);
      const row = {
        threadId: thread.id,
        title: thread.title,
        projectName: thread.project_name,
        size: thread.size,
        pausedAt:
          summary?.pausedAt === null || summary?.pausedAt === undefined
            ? null
            : instant(summary.pausedAt),
        last24hMs:
          meteredUsage !== undefined
            ? meteredUsage.ms
            : summary?.recorded === true
              ? summary.last24hMs
              : null,
        last24hCostMicros: meteredUsage?.micros ?? null,
      };
      if (summary?.running === true)
        running.push({ ...row, since: summary.runningSince ?? now });
      else paused.push({ ...row, at: summary?.pausedAt ?? 0 });
    });
    running.sort((left, right) => right.since - left.since);
    paused.sort((left, right) => right.at - left.at);
    return context.json(
      Schema.encodeUnknownSync(GetOrbUsageResponseSchema)({
        status: "success",
        data: {
          refreshedAt: instant(now),
          running: running.map(({ since: _since, ...row }) => row),
          paused: paused
            .slice(0, PAUSED_LIMIT)
            .map(({ at: _at, ...row }) => row),
          month:
            month === undefined
              ? null
              : await monthUsage(db, userId, monthFrom, month),
        },
      }),
      200,
    );
  } catch (error) {
    orbProvidersLogger.warn("Orb usage could not be read.", {
      event: "orb_usage_read_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return context.json(
      Schema.encodeUnknownSync(OrbUsageUnavailableResponseSchema)({
        status: "error",
        data: {
          code: "PERSISTENCE_UNAVAILABLE",
          message: "Orb usage is temporarily unavailable.",
          requestId: context.get("requestId"),
        },
      }),
      503,
    );
  }
});
