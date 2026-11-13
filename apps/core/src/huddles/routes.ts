import {
  formatHuddleCode,
  HuddleJoinResponseSchema,
  HuddleLinkResponseSchema,
  HuddleSummaryResponseSchema,
} from "@dx/api";
import { Schema } from "effect";
import { Hono } from "hono";
import { userImageSql } from "../avatars/storage.js";
import type { AppEnv } from "../http/types.js";
import { displayNameSql } from "../thread-sharing/service.js";
import { failure } from "./failures.js";
import { huddleWorkspace, linkCodeFor } from "./links.js";
import {
  addParticipant,
  createMeeting,
  liveHuddle,
  type RealtimeKitAccess,
  realtimeKitAccess,
} from "./realtimekit.js";

interface Person {
  readonly id: string;
  readonly name: string | null;
  readonly image: string | null;
}

const people = async (
  db: D1Database,
  userIds: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, Person>> => {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .prepare(
      `SELECT "user".id AS id,
              ${displayNameSql('"user"', "account")} AS name,
              ${userImageSql('"user"', "account")} AS image
         FROM "user"
         LEFT JOIN personal_account AS account ON account.user_id = "user".id
        WHERE "user".id IN (${userIds.map(() => "?").join(", ")})`,
    )
    .bind(...userIds)
    .all<Person>();
  return new Map(rows.results.map((row) => [row.id, row]));
};

const displayName = (person: Person | undefined) =>
  (person?.name?.trim() || "Member").slice(0, 256);

const storedMeeting = async (db: D1Database, threadId: string) =>
  (
    await db
      .prepare("SELECT meeting_id FROM thread_huddles WHERE thread_id = ?")
      .bind(threadId)
      .first<{ meeting_id: string }>()
  )?.meeting_id;

/**
 * The Thread's meeting, created on first join. Two first joins at once may
 * both create one; the first row written wins and the other meeting stays
 * idle on RealtimeKit, which costs nothing.
 */
const meetingFor = async (
  db: D1Database,
  access: RealtimeKitAccess,
  threadId: string,
) => {
  const existing = await storedMeeting(db, threadId);
  if (existing !== undefined) return existing;
  const created = await createMeeting(access, `dx huddle ${threadId}`);
  await db
    .prepare(
      `INSERT INTO thread_huddles (thread_id, meeting_id, created_at)
       VALUES (?, ?, ?) ON CONFLICT (thread_id) DO NOTHING`,
    )
    .bind(threadId, created, new Date().toISOString())
    .run();
  return (await storedMeeting(db, threadId)) ?? created;
};

/**
 * `/v1/threads/:threadId/huddle`, behind `authorizeThread`: the Thread's
 * huddle, for anyone who can open the Thread, view-only members included,
 * since talking changes nothing in the Thread. A Space's huddle is its own
 * Thread's.
 *
 * A private Thread has no huddle: talking is for the people it is shared
 * with, so every route answers `HUDDLE_PRIVATE` until it is shared.
 *
 * - `GET /huddle`: who is in it now, for the header before joining.
 * - `POST /huddle/join`: a RealtimeKit token that joins the signed-in person
 *   under their dx name, creating the Thread's meeting on first join.
 * - `POST /huddle/link`: the huddle's short link, made on first copy and the
 *   same for everyone after.
 */
export const threadHuddleRoutes = new Hono<AppEnv>()
  // Matches `/huddle` itself too.
  .use("/:threadId/huddle/*", async (context, next) => {
    const db = context.env.DB;
    if (
      db !== undefined &&
      (await huddleWorkspace(db, context.req.param("threadId"))) === undefined
    )
      return failure(context, "HUDDLE_PRIVATE");
    return next();
  })
  .post("/:threadId/huddle/link", async (context) => {
    const db = context.env.DB;
    const threadId = context.req.param("threadId");
    const workspace =
      db === undefined ? undefined : await huddleWorkspace(db, threadId);
    if (db === undefined || workspace === undefined)
      return failure(context, "HUDDLE_PRIVATE");
    const code = formatHuddleCode(await linkCodeFor(db, threadId));
    return context.json(
      Schema.encodeUnknownSync(HuddleLinkResponseSchema)({
        status: "success",
        data: {
          code,
          workspace: workspace.slug,
          path: `/huddle/${workspace.slug}/${code}`,
        },
      }),
      200,
    );
  })
  .get("/:threadId/huddle", async (context) => {
    const access = realtimeKitAccess(context.env);
    const db = context.env.DB;
    if (access === undefined || db === undefined)
      return failure(context, "HUDDLE_UNAVAILABLE");
    const meetingId = await storedMeeting(db, context.req.param("threadId"));
    let live: Awaited<ReturnType<typeof liveHuddle>>;
    try {
      live =
        meetingId === undefined
          ? undefined
          : await liveHuddle(access, meetingId);
    } catch {
      return failure(context, "HUDDLE_PROVIDER_FAILED");
    }
    const ids = (live?.userIds ?? []).slice(0, 200);
    const found = await people(db, ids);
    return context.json(
      Schema.encodeUnknownSync(HuddleSummaryResponseSchema)({
        status: "success",
        data: {
          active: ids.length > 0,
          participants: ids.map((userId) => {
            const person = found.get(userId);
            const image = person?.image;
            return {
              userId,
              name: displayName(person),
              ...(typeof image === "string" &&
              image !== "" &&
              image.length <= 2048
                ? { avatarUrl: image }
                : {}),
            };
          }),
          ...(live === undefined || live.startedAt === ""
            ? {}
            : { startedAt: live.startedAt }),
        },
      }),
      200,
    );
  })
  .post("/:threadId/huddle/join", async (context) => {
    const access = realtimeKitAccess(context.env);
    const db = context.env.DB;
    if (access === undefined || db === undefined)
      return failure(context, "HUDDLE_UNAVAILABLE");
    const actor = context.get("actor") ?? context.get("principal");
    const userId = String(actor.userId);
    try {
      const [meetingId, found] = await Promise.all([
        meetingFor(db, access, context.req.param("threadId")),
        people(db, [userId]),
      ]);
      const authToken = await addParticipant(access, meetingId, {
        userId,
        name: displayName(found.get(userId)),
      });
      return context.json(
        Schema.encodeUnknownSync(HuddleJoinResponseSchema)({
          status: "success",
          data: { authToken, meetingId },
        }),
        200,
      );
    } catch {
      return failure(context, "HUDDLE_PROVIDER_FAILED");
    }
  });
