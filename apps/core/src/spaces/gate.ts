import type { ExperimentalFeatureId } from "@dx/domain";
import { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { readOrbThreadState } from "../agents/orb-free.js";
import { notFoundHandler } from "../http/http-errors.js";
import type { AppEnv, Bindings } from "../http/types.js";

/**
 * Spaces is a personal experimental feature (`spaces`), off by default, that
 * anyone may turn on in Settings, on every deployment.
 *
 * For anyone whose flag is off, every `/v1/spaces` route and every route of
 * a Space Thread answers not found, lists and search skip Spaces, the Space
 * prompt and Space-only tool behavior never load, and the threads a Space
 * started are ordinary root Threads. Nothing is deleted: turning the flag
 * back on brings every Space back. A Space someone shares with a member
 * stays hidden from that member until they turn their own flag on.
 */

export const SPACES_FEATURE_ID = "spaces" as ExperimentalFeatureId;

/** Whether stored preferences turn `spaces` on; it is off by default. */
const turnedOn = (preferences: string | null) => {
  if (preferences === null) return false;
  try {
    const parsed: unknown = JSON.parse(preferences);
    return (
      Array.isArray(parsed) &&
      parsed.some(
        (preference) =>
          typeof preference === "object" &&
          preference !== null &&
          (preference as { id?: unknown }).id === SPACES_FEATURE_ID &&
          (preference as { enabled?: unknown }).enabled === true,
      )
    );
  } catch {
    // Unreadable preferences fail closed.
    return false;
  }
};

/**
 * Whether this person turned Spaces on: one D1 read of their experimental
 * feature preferences. `spaces` has no prerequisites or incompatibilities,
 * so the stored preference is its effective state.
 */
export const spacesEnabledFor = async (
  bindings: Pick<Bindings, "DB">,
  userId: string,
): Promise<boolean> => {
  const db = bindings.DB;
  if (db === undefined) return false;
  const preferences = await db
    .prepare(
      "SELECT preferences FROM personal_experimental_feature_preferences WHERE user_id = ?1",
    )
    .bind(userId)
    .first<string>("preferences");
  return turnedOn(preferences);
};

/**
 * SQL: whether this person's `spaces` flag is on, for queries that decide
 * in the same statement (lists read on every turn). `user` is a SQL
 * expression or placeholder holding their user ID.
 */
export const spacesOnSql = (user: string) => `EXISTS (
  SELECT 1 FROM personal_experimental_feature_preferences AS spaces_flag,
         json_each(spaces_flag.preferences) AS spaces_preference
   WHERE spaces_flag.user_id = ${user}
     AND json_extract(spaces_preference.value, '$.id') = '${SPACES_FEATURE_ID}'
     AND json_extract(spaces_preference.value, '$.enabled') = 1)`;

export const threadOwner = async (db: D1Database, threadId: string) =>
  (await db
    .prepare("SELECT owner_user_id FROM threads WHERE id = ?1")
    .bind(threadId)
    .first<string>("owner_user_id")) ?? undefined;

/**
 * `/v1/spaces` and everything under it: not found, as an unknown route is,
 * for anyone Spaces is off for.
 */
const requireSpaces: MiddlewareHandler<AppEnv> = async (context, next) =>
  (await spacesEnabledFor(context.env, context.get("principal").userId))
    ? next()
    : notFoundHandler(context);

const threadNotFound = (context: Context<AppEnv>) =>
  context.json(
    {
      status: "error",
      data: {
        code: "THREAD_NOT_FOUND",
        message: "Thread not found.",
        requestId: context.get("requestId"),
      },
    },
    404,
  );

/** The Thread a Thread or agent route names, when it names one. */
const routeThreadId = (context: Context<AppEnv>) =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(ThreadId)(context.req.param("threadId")),
  );

/**
 * Starts reading whether the route's Thread is a Space while the request
 * authenticates, so the gate's answer costs no round trip of its own. A
 * Thread's kind never changes, so an isolate reads it once per Thread
 * (`readOrbThreadState`). Register before authentication; `useSpacesGate`
 * awaits it.
 */
export const prefetchThreadKind: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  const threadId = routeThreadId(context);
  const db = context.env.DB;
  if (threadId !== undefined && db !== undefined) {
    const space = readOrbThreadState(db, threadId).then(
      ({ kind }) => kind === "space",
    );
    // A request refused before the gate never awaits it.
    space.catch(() => undefined);
    context.set("threadIsSpace", space);
  }
  return next();
};

/**
 * A Space Thread's routes: not found, as a Thread that does not exist is,
 * for anyone Spaces is off for, before the route runs, so it neither waits
 * on nor does any of the route's work. Other Threads, including the
 * threads a Space started, pass through. The kind read is the one
 * `prefetchThreadKind` started beside authentication, or the isolate's
 * cached answer; the viewer's flag is read only for a Space.
 */
const hideSpaceThreads: MiddlewareHandler<AppEnv> = async (context, next) => {
  const threadId = routeThreadId(context);
  const db = context.env.DB;
  if (threadId === undefined || db === undefined) return next();
  const space = await (context.get("threadIsSpace") ??
    readOrbThreadState(db, threadId).then(({ kind }) => kind === "space"));
  if (
    space &&
    !(await spacesEnabledFor(context.env, context.get("principal").userId))
  )
    return threadNotFound(context);
  return next();
};

/**
 * Puts the gate in front of the Spaces, Thread, and agent routes of an app
 * that mounts them: the Worker's app, and the in-process app Thread tools
 * call as the owner. Register before those routes, after authentication.
 * `/x/*` also matches `/x`.
 */
export const useSpacesGate = (app: Hono<AppEnv>) => {
  app.use("/v1/spaces/*", requireSpaces);
  app.use("/v1/threads/:threadId/*", hideSpaceThreads);
  app.use("/v1/agents/dx/:threadId/*", hideSpaceThreads);
  return app;
};

/** Which of these Thread IDs are Spaces; one read, none for no IDs. */
export const spaceThreadIds = async (
  db: D1Database,
  threadIds: Iterable<string | null | undefined>,
): Promise<ReadonlySet<string>> => {
  const ids = [
    ...new Set(
      [...threadIds].filter((id): id is string => typeof id === "string"),
    ),
  ];
  if (ids.length === 0) return new Set();
  const rows = await db
    .prepare(
      `SELECT id FROM threads
        WHERE id IN (SELECT value FROM json_each(?1)) AND kind = 'space'`,
    )
    .bind(JSON.stringify(ids))
    .all<{ id: string }>();
  return new Set(rows.results.map(({ id }) => id));
};
