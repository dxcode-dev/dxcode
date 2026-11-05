import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../http/types.js";
import { requestLogger } from "../logging.js";

/**
 * One D1 session per request (#1386). With read replication on, D1 serves a
 * session's reads from a nearby replica, and every query after the first sees
 * at least the state the previous one saw, so a request always sees its own
 * writes. Without replication every session runs on the primary, unchanged.
 *
 * - A read (GET, HEAD) starts at a replica that has applied a bookmark: the
 *   `x-dx-d1-bookmark` header's (a write the caller learned of, such as a
 *   realtime hint after a Durable Object's write), else the cookie's (the
 *   browser's own last write). Without one, a browser's read starts at any
 *   replica. A client that sends no cookies (an API token, dxd, a script)
 *   cannot carry its writes' bookmarks, so its reads start at the primary.
 * - Anything else starts at the primary, so its precondition reads are
 *   current, and answers with its session's bookmark in a cookie: the
 *   browser's next read sees the write wherever it is served. Reads never set
 *   the cookie, so parallel reads cannot move it back.
 *
 * Only `c.env.DB` is sessioned. Durable Objects and code reading the
 * module-level `env` keep the bare binding, which always reaches the primary.
 *
 * Credential checks read the primary (`primaryDatabase`), so an ended session
 * or revoked API token stops the next request from any client at once.
 * Other authorization reads, such as workspace membership and Thread
 * sharing, follow the request's session: a client without a bookmark can see
 * a removal up to the replica lag late (#1386). The reverse never stands: a
 * read a replica answered "not found" is answered again at the primary
 * (`confirmMissesAtPrimary`, #1784).
 */

export const D1_BOOKMARK_COOKIE = "dx-d1-bookmark";
export const D1_BOOKMARK_HEADER = "x-dx-d1-bookmark";

/**
 * D1 bookmarks are hex groups joined by dashes. Anything else is ignored, so
 * a malformed or forged bookmark never reaches D1, which would refuse it.
 */
const BOOKMARK = /^[0-9a-f]{8}(?:-[0-9a-f]{8,64}){1,6}$/;

/**
 * Replicas apply a write within seconds; after this a bookmark constrains
 * nothing any replica has not already applied.
 */
const BOOKMARK_MAX_AGE_SECONDS = 300;

const readMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A `D1Database` whose queries run in `session`. Better Auth recognizes D1 by
 * `prepare`, `batch`, and `exec`; a session has no `exec`, which runs DDL
 * outside any session on the bare binding.
 */
export const sessionDatabase = (
  db: D1Database,
  session: D1DatabaseSession,
): D1Database =>
  ({
    prepare: (query: string) => session.prepare(query),
    batch: <T = unknown>(statements: D1PreparedStatement[]) =>
      session.batch<T>(statements),
    exec: (query: string) => db.exec(query),
    dump: () => db.dump(),
    withSession: (constraint?: D1SessionBookmark | D1SessionConstraint) =>
      db.withSession(constraint),
  }) as D1Database;

/** Each session-backed binding's way to the primary for this request. */
const primaries = new WeakMap<object, D1Database>();

/**
 * The binding to read credentials from. A write request's session already
 * started at the primary; a read request reaches it through the bare binding.
 */
export const primaryDatabase = <T extends D1Database | undefined>(db: T): T =>
  db === undefined ? db : ((primaries.get(db) as T | undefined) ?? db);

/** Read requests whose session may have started at a replica. */
const replicaReads = new WeakSet<Request>();
/** Retries of a replica's "not found", which read the primary. */
const primaryRetries = new WeakSet<Request>();

/**
 * The answers that say a Thread, Project, or artifact does not exist for the
 * requester. Each comes from a D1 lookup of something another request may
 * have just written: a Thread an agent or schedule started, a share another
 * person granted, an artifact the agent saved.
 */
const MISS_CODES = new Set([
  "THREAD_NOT_FOUND",
  "PROJECT_NOT_FOUND",
  "ARTIFACT_NOT_FOUND",
  "ARTIFACT_REVISION_NOT_FOUND",
]);

const answeredMiss = async (response: Response) => {
  if (response.status !== 404) return undefined;
  if (!response.headers.get("content-type")?.includes("application/json"))
    return undefined;
  const body = (await response
    .clone()
    .json()
    .catch(() => undefined)) as { data?: { code?: unknown } } | undefined;
  const code = body?.data?.code;
  return typeof code === "string" && MISS_CODES.has(code) ? code : undefined;
};

type Fetch<Env> = (
  request: Request,
  env?: Env,
  executionCtx?: ExecutionContext,
) => Response | Promise<Response>;

/**
 * A replica may not have applied a row another request just wrote, and a
 * read without a bookmark, or with one older than that write, can be served
 * by it. So a read that a replica answered "not found" is answered again at
 * the primary, whose answer stands (#1784): no ownership or access decision
 * concludes "not found" from a replica that may be behind. A replica that
 * has the row costs nothing extra; a real miss reads the primary once more.
 * GET and HEAD change nothing, so running one again is safe.
 */
export const confirmMissesAtPrimary =
  <Env>(fetch: Fetch<Env>): Fetch<Env> =>
  async (request, env, executionCtx) => {
    const response = await fetch(request, env, executionCtx);
    if (!replicaReads.has(request)) return response;
    const code = await answeredMiss(response);
    if (code === undefined) return response;
    await response.body?.cancel().catch(() => undefined);
    const retry = new Request(request);
    // The retry logs under the same request ID as the replica's answer.
    const id = response.headers.get("x-request-id");
    if (id !== null) retry.headers.set("x-request-id", id);
    primaryRetries.add(retry);
    const confirmed = await fetch(retry, env, executionCtx);
    const stillMissing = (await answeredMiss(confirmed)) !== undefined;
    requestLogger.info(
      stillMissing
        ? "A replica's not-found was confirmed at the primary."
        : "A replica missed what the primary has.",
      {
        event: "d1_replica_miss",
        code,
        outcome: stillMissing ? "absent" : "found_at_primary",
        status: confirmed.status,
        ...(id === null ? {} : { requestId: id }),
      },
    );
    return confirmed;
  };

const hasSessions = (db: unknown): db is D1Database =>
  typeof db === "object" &&
  db !== null &&
  typeof (db as D1Database).withSession === "function";

export const d1Session: MiddlewareHandler<AppEnv> = async (context, next) => {
  const db = context.env?.DB;
  if (!hasSessions(db)) return next();
  const read = readMethods.has(context.req.method);
  const bookmark = [
    context.req.header(D1_BOOKMARK_HEADER),
    getCookie(context, D1_BOOKMARK_COOKIE),
  ].find((value) => value !== undefined && BOOKMARK.test(value));
  const retry = primaryRetries.has(context.req.raw);
  const anyReplica = read && context.req.header("cookie") !== undefined;
  const constraint = retry
    ? "first-primary"
    : read && bookmark !== undefined
      ? bookmark
      : anyReplica
        ? "first-unconstrained"
        : "first-primary";
  if (read && constraint !== "first-primary") replicaReads.add(context.req.raw);
  const session = db.withSession(constraint);
  const sessioned = sessionDatabase(db, session);
  primaries.set(sessioned, read && !retry ? db : sessioned);
  context.env = { ...context.env, DB: sessioned };
  await next();
  if (context.res.status === 101) return;
  // Signing out, or a session found ended, clears the auth cookies; the
  // bookmark goes with them, so a signed-out browser keeps no dx cookie.
  if (
    getCookie(context, D1_BOOKMARK_COOKIE) !== undefined &&
    clearsSession(context.res)
  )
    return setBookmarkCookie(context, "", 0);
  if (read) return;
  const latest = session.getBookmark();
  if (latest === null || latest === bookmark || !BOOKMARK.test(latest)) return;
  setBookmarkCookie(context, latest, BOOKMARK_MAX_AGE_SECONDS);
};

const clearsSession = (response: Response) =>
  response.headers
    .getSetCookie()
    .some(
      (line) =>
        /^[^=]*session_token=/.test(line) &&
        (/^[^=]*session_token=;/.test(line) || /;\s*max-age=0\b/i.test(line)),
    );

const setBookmarkCookie = (
  context: Context<AppEnv>,
  value: string,
  maxAge: number,
) => {
  const write = () =>
    setCookie(context, D1_BOOKMARK_COOKIE, value, {
      path: "/",
      httpOnly: true,
      secure: new URL(context.req.url).protocol === "https:",
      sameSite: "Lax",
      maxAge,
    });
  try {
    write();
  } catch {
    // A response passed through from fetch has immutable headers.
    context.res = new Response(context.res.body, context.res);
    write();
  }
};
