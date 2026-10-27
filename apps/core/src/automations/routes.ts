import {
  ThreadAutomationsResponseSchema,
  TimeZoneResponseSchema,
  UpdateAutomationRequestSchema,
  UpdateTimeZoneRequestSchema,
} from "@dx/api";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { automationLogger } from "../logging.js";
import {
  type CiDetail,
  describeTarget,
  type PullSubject,
  targetUrl,
} from "./github.js";
import { isTimeZone } from "./recurrence.js";
import { deleteSchedule, patchSchedule, readSchedule } from "./schedules.js";
import {
  deleteSubscription,
  filterOf,
  listOwnerSubscriptions,
  readSubscription,
  setSubscriptionEnabled,
  threadCiResults,
} from "./subscriptions.js";

const failure = (
  context: Context<AppEnv>,
  status: 400 | 404 | 503,
  code: string,
  message: string,
) =>
  context.json(
    {
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    },
    status,
  );

const withDb = async (
  context: Context<AppEnv>,
  run: (db: D1Database, userId: string) => Promise<Response>,
) => {
  const db = context.env.DB;
  if (db === undefined)
    return failure(
      context,
      503,
      "PERSISTENCE_UNAVAILABLE",
      "Persistence is temporarily unavailable.",
    );
  try {
    return await run(db, context.get("principal").userId);
  } catch (cause) {
    automationLogger.error("Automation request failed.", {
      event: "automation_request_failed",
      requestId: context.get("requestId"),
      cause,
    });
    return failure(
      context,
      503,
      "PERSISTENCE_UNAVAILABLE",
      "Persistence is temporarily unavailable.",
    );
  }
};

const body = async <A>(context: Context<AppEnv>, schema: Schema.Codec<A>) =>
  Schema.decodeUnknownOption(schema)(
    await context.req.json().catch(() => undefined),
  );

const optional = <K extends string>(key: K, value: string | null) =>
  (value === null ? {} : { [key]: value }) as Partial<Record<K, string>>;

/**
 * `/v1/threads/:threadId/automations`: the Thread's schedule and GitHub
 * subscriptions, to show, pause, resume, or delete. Runs after
 * authorizeThread; only the Thread's owner sees or changes them, and every
 * route touches only rows on this Thread.
 */
const listed = async (
  context: Context<AppEnv>,
  db: D1Database,
  userId: string,
  threadId: string,
) => {
  const [schedule, subscriptions, ciResults] = await Promise.all([
    readSchedule(db, threadId),
    listOwnerSubscriptions(db, userId, threadId),
    threadCiResults(db, userId, threadId),
  ]);
  return context.json(
    Schema.encodeUnknownSync(ThreadAutomationsResponseSchema)({
      status: "success",
      data: {
        ...(schedule === null || schedule.owner_user_id !== userId
          ? {}
          : {
              schedule: {
                title: schedule.title,
                prompt: schedule.prompt,
                label: schedule.label,
                rrule: schedule.rrule,
                timeZone: schedule.time_zone,
                runMode: schedule.run_mode,
                enabled: schedule.enabled === 1,
                ...optional("nextRunAt", schedule.next_run_at),
                ...optional("lastRunAt", schedule.last_run_at),
                ...(schedule.last_run_status === null
                  ? {}
                  : { lastRunStatus: schedule.last_run_status }),
                ...optional("lastRunDetail", schedule.last_run_detail),
              },
            }),
        githubSubscriptions: subscriptions.map((row) => ({
          id: row.id,
          title: row.title,
          repository: row.repository,
          filterKind: row.filter_kind,
          target: describeTarget(row.filter_kind, filterOf(row)),
          url: targetUrl(row.repository, row.filter_kind, filterOf(row)),
          destination: row.destination,
          automatic: row.automatic === 1,
          enabled: row.enabled === 1,
          state: row.state,
          ...optional("stateDetail", row.state_detail),
          ...optional("expiresAt", row.expires_at),
          ...optional("lastEventAt", row.last_event_at),
          ...optional("lastEvent", row.last_event_summary),
          createdAt: row.created_at,
        })),
        pullRequests: pullRequestsOf(subscriptions),
        ciRuns: ciRunsOf(subscriptions, ciResults),
      },
    }),
  );
};

type ListedSubscription = Awaited<
  ReturnType<typeof listOwnerSubscriptions>
>[number];

const parse = <A>(json: string | null): A | undefined => {
  if (json === null) return undefined;
  try {
    return JSON.parse(json) as A;
  } catch {
    return undefined;
  }
};

/** The PRs the Thread follows, once each, as their webhooks left them. */
const pullRequestsOf = (subscriptions: ReadonlyArray<ListedSubscription>) => {
  const seen = new Set<string>();
  return subscriptions.flatMap((row) => {
    const number = filterOf(row).prNumber;
    const key = `${row.repository.toLowerCase()}#${number}`;
    if (
      row.filter_kind !== "pr-comments" ||
      number === undefined ||
      seen.has(key)
    )
      return [];
    seen.add(key);
    const subject = parse<PullSubject>(row.subject_json);
    // Before its first webhook, the last lifecycle event says the state.
    const state =
      subject?.state ??
      (row.last_lifecycle_key?.startsWith("merged:")
        ? ("merged" as const)
        : row.last_lifecycle_key?.startsWith("closed:")
          ? ("closed" as const)
          : ("open" as const));
    return [
      {
        repository: row.repository,
        number,
        url: `https://github.com/${row.repository}/pull/${number}`,
        state,
        ...(subject === undefined
          ? {}
          : {
              title: subject.title,
              ...(subject.summary === "" ? {} : { summary: subject.summary }),
              ...(subject.changedAt === undefined
                ? {}
                : { changedAt: subject.changedAt }),
            }),
      },
    ];
  });
};

/**
 * One row per commit: its newest delivered CI result, and before that a
 * running row for each commit an active CI subscription still waits on.
 */
const ciRunsOf = (
  subscriptions: ReadonlyArray<ListedSubscription>,
  results: Awaited<ReturnType<typeof threadCiResults>>,
) => {
  const delivered = results.flatMap((row) => {
    const detail = parse<CiDetail>(row.detail_json);
    return detail === undefined
      ? []
      : [
          {
            repository: row.repository,
            sha: detail.sha,
            ...(detail.branch === undefined ? {} : { branch: detail.branch }),
            result: detail.result,
            url:
              row.url ??
              `https://github.com/${row.repository}/commit/${detail.sha}/checks`,
            checks: detail.checks,
            at: row.created_at,
          },
        ];
  });
  const shas = new Set(delivered.map(({ sha }) => sha));
  const running = subscriptions.flatMap((row) => {
    const filter = filterOf(row);
    const sha = filter.commitSha;
    if (
      row.filter_kind !== "ci" ||
      row.state !== "active" ||
      row.enabled !== 1 ||
      sha === undefined ||
      shas.has(sha)
    )
      return [];
    shas.add(sha);
    return [
      {
        repository: row.repository,
        sha,
        ...(filter.branch === undefined ? {} : { branch: filter.branch }),
        result: "running" as const,
        url: `https://github.com/${row.repository}/commit/${sha}/checks`,
        checks: [],
        at: row.updated_at,
      },
    ];
  });
  // One row per commit: a running row wins over an older delivered result.
  const bySha = new Map<string, (typeof running | typeof delivered)[number]>();
  for (const run of [...running, ...delivered])
    if (!bySha.has(run.sha)) bySha.set(run.sha, run);
  return [...bySha.values()];
};

/** The owner's own Thread, or a 404 that reveals nothing. */
const ownThread = (
  context: Context<AppEnv>,
  run: (db: D1Database, userId: string, threadId: string) => Promise<Response>,
) =>
  context.get("threadAccess") === "owner"
    ? withDb(context, (db, userId) =>
        run(db, userId, context.req.param("threadId") ?? ""),
      )
    : Promise.resolve(failure(context, 404, "NOT_FOUND", "Thread not found."));

const scheduleOf = async (db: D1Database, userId: string, threadId: string) => {
  const row = await readSchedule(db, threadId);
  return row === null || row.owner_user_id !== userId ? null : row;
};

const subscriptionOf = async (
  db: D1Database,
  userId: string,
  threadId: string,
  id: string,
) => {
  const row = await readSubscription(db, id);
  return row === null ||
    row.owner_user_id !== userId ||
    row.thread_id !== threadId
    ? null
    : row;
};

export const threadAutomationRoutes = new Hono<AppEnv>()
  .get("/:threadId/automations", (context) =>
    ownThread(context, (db, userId, threadId) =>
      listed(context, db, userId, threadId),
    ),
  )
  .patch("/:threadId/automations/schedule", (context) =>
    ownThread(context, async (db, userId, threadId) => {
      const request = await body(context, UpdateAutomationRequestSchema);
      if (Option.isNone(request))
        return failure(context, 400, "INVALID_REQUEST", "Send enabled.");
      const row = await scheduleOf(db, userId, threadId);
      if (row === null)
        return failure(context, 404, "NOT_FOUND", "Schedule not found.");
      await patchSchedule(db, row, { enabled: request.value.enabled });
      return listed(context, db, userId, threadId);
    }),
  )
  .delete("/:threadId/automations/schedule", (context) =>
    ownThread(context, async (db, userId, threadId) => {
      if ((await scheduleOf(db, userId, threadId)) === null)
        return failure(context, 404, "NOT_FOUND", "Schedule not found.");
      await deleteSchedule(db, threadId);
      return listed(context, db, userId, threadId);
    }),
  )
  .patch("/:threadId/automations/github/:id", (context) =>
    ownThread(context, async (db, userId, threadId) => {
      const request = await body(context, UpdateAutomationRequestSchema);
      if (Option.isNone(request))
        return failure(context, 400, "INVALID_REQUEST", "Send enabled.");
      const row = await subscriptionOf(
        db,
        userId,
        threadId,
        context.req.param("id"),
      );
      if (row === null)
        return failure(context, 404, "NOT_FOUND", "Subscription not found.");
      await setSubscriptionEnabled(db, row.id, request.value.enabled);
      return listed(context, db, userId, threadId);
    }),
  )
  .delete("/:threadId/automations/github/:id", (context) =>
    ownThread(context, async (db, userId, threadId) => {
      const row = await subscriptionOf(
        db,
        userId,
        threadId,
        context.req.param("id"),
      );
      if (row === null)
        return failure(context, 404, "NOT_FOUND", "Subscription not found.");
      await deleteSubscription(db, row.id);
      return listed(context, db, userId, threadId);
    }),
  );

/**
 * `PUT /v1/settings/personal/time-zone`: the browser's IANA zone, where a
 * schedule without DTSTART is anchored.
 */
export const personalTimeZoneRoutes = new Hono<AppEnv>().put("/", (context) =>
  withDb(context, async (db, userId) => {
    const request = await body(context, UpdateTimeZoneRequestSchema);
    if (Option.isNone(request) || !isTimeZone(request.value.timeZone))
      return failure(context, 400, "INVALID_REQUEST", "Unknown time zone.");
    await db
      .prepare(
        `INSERT INTO user_time_zone (user_id, time_zone, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT (user_id) DO UPDATE SET
           time_zone = excluded.time_zone, updated_at = excluded.updated_at`,
      )
      .bind(userId, request.value.timeZone, new Date().toISOString())
      .run();
    return context.json(
      Schema.encodeUnknownSync(TimeZoneResponseSchema)({
        status: "success",
        data: { timeZone: request.value.timeZone },
      }),
    );
  }),
);
