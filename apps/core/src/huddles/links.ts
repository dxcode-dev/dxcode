import {
  formatHuddleCode,
  HUDDLE_CODE_ALPHABET,
  HUDDLE_CODE_LENGTH,
  HuddleLinkTargetResponseSchema,
  normalizeHuddleCode,
} from "@dx/api";
import { Schema } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { threadProjectReachableSql } from "../settings/members/membership-sql.js";
import {
  canUseSharedThreads,
  findSharedThreadGrant,
} from "../thread-sharing/access.js";
import { failure } from "./failures.js";

/**
 * Huddle links: `/huddle/<workspace>/<code>` opens a shared Thread's or
 * Space's huddle for anyone who can open it. The code is the Thread's,
 * made on first copy and kept, so every copy is the same link.
 */

/**
 * The workspace a Thread's huddle belongs to: the one it is shared with.
 * Undefined for a private Thread, which has no huddle.
 */
export const huddleWorkspace = async (db: D1Database, threadId: string) =>
  (await db
    .prepare(
      `SELECT organization.id AS id, organization.slug AS slug
         FROM threads AS thread
         JOIN organization ON organization.id = thread.shared_workspace_id
        WHERE thread.id = ?
          AND thread.workspace_access IN ('view', 'contribute')
          AND organization.lifecycleState = 'active'`,
    )
    .bind(threadId)
    .first<{ id: string; slug: string }>()) ?? undefined;

/** Nine random letters from the code alphabet, without modulo bias. */
const randomCode = () => {
  const letters: string[] = [];
  const limit = 256 - (256 % HUDDLE_CODE_ALPHABET.length);
  while (letters.length < HUDDLE_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte >= limit || letters.length === HUDDLE_CODE_LENGTH) continue;
      letters.push(
        HUDDLE_CODE_ALPHABET.charAt(byte % HUDDLE_CODE_ALPHABET.length),
      );
    }
  }
  return letters.join("");
};

const storedCode = async (db: D1Database, threadId: string) =>
  (
    await db
      .prepare("SELECT code FROM huddle_links WHERE thread_id = ?")
      .bind(threadId)
      .first<{ code: string }>()
  )?.code;

/**
 * The Thread's code, made on first copy. Two first copies at once keep the
 * first row written; a code another Thread already holds (1 in 1.8 trillion)
 * is drawn again.
 */
export const linkCodeFor = async (db: D1Database, threadId: string) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await storedCode(db, threadId);
    if (existing !== undefined) return existing;
    await db
      .prepare(
        `INSERT INTO huddle_links (code, thread_id, created_at)
         VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .bind(randomCode(), threadId, new Date().toISOString())
      .run();
  }
  const code = await storedCode(db, threadId);
  if (code === undefined) throw new Error("No free huddle code.");
  return code;
};

/** The workspace a short name (or a renamed workspace's old one) names. */
const workspaceNamed = async (db: D1Database, shortName: string) =>
  (
    await db
      .prepare(
        `SELECT id FROM organization
          WHERE slug = ?1 COLLATE NOCASE AND lifecycleState = 'active'
         UNION ALL
         SELECT workspace_id AS id FROM workspace_short_name_alias
          WHERE short_name = ?1
         LIMIT 1`,
      )
      .bind(shortName)
      .first<{ id: string }>()
  )?.id;

/**
 * `GET /v1/huddle-links/:workspace/:code`: the Thread or Space a link opens,
 * for the signed-in person. The code is read without hyphens or case.
 *
 * - 404 `HUDDLE_LINK_NOT_FOUND`: no such code in that workspace.
 * - 403 `HUDDLE_LINK_FORBIDDEN`: it exists, but this person cannot open the
 *   Thread; nothing about the Thread is said.
 * - 409 `HUDDLE_PRIVATE`: its owner made the Thread private again.
 */
export const huddleLinkRoutes = new Hono<AppEnv>().get(
  "/:workspace/:code",
  async (context) => {
    const db = context.env.DB;
    const code = normalizeHuddleCode(context.req.param("code"));
    if (db === undefined || code === undefined)
      return failure(context, "HUDDLE_LINK_NOT_FOUND");
    const principal = context.get("principal");
    const userId = String(principal.userId);
    const [workspaceId, row] = await Promise.all([
      workspaceNamed(db, context.req.param("workspace")),
      db
        .prepare(
          `SELECT thread.id AS thread_id, thread.kind, thread.title,
                  thread.owner_user_id,
                  -- Shared: that workspace. Private again: its Project's,
                  -- or for a personal Project, its owner's workspace.
                  COALESCE(
                    thread.shared_workspace_id,
                    project.workspace_id,
                    (SELECT member.organizationId FROM member
                      WHERE member.userId = thread.owner_user_id LIMIT 1)
                  ) AS workspace_id,
                  ${threadProjectReachableSql("project", "?2")} AS reachable
             FROM huddle_links AS link
             JOIN threads AS thread ON thread.id = link.thread_id
             JOIN projects AS project ON project.id = thread.project_id
            WHERE link.code = ?1 AND thread.lifecycle_state != 'deleted'`,
        )
        .bind(code, userId)
        .first<{
          thread_id: string;
          kind: string;
          title: string | null;
          owner_user_id: string;
          workspace_id: string | null;
          reachable: number;
        }>(),
    ]);
    if (
      row === null ||
      workspaceId === undefined ||
      row.workspace_id !== workspaceId
    )
      return failure(context, "HUDDLE_LINK_NOT_FOUND");
    const owns = row.owner_user_id === userId && row.reachable === 1;
    const member =
      !owns &&
      canUseSharedThreads(principal) &&
      (await findSharedThreadGrant(db, row.thread_id, userId)) !== undefined;
    if (!owns && !member) return failure(context, "HUDDLE_LINK_FORBIDDEN");
    if ((await huddleWorkspace(db, row.thread_id)) === undefined)
      return failure(context, "HUDDLE_PRIVATE");
    return context.json(
      Schema.encodeUnknownSync(HuddleLinkTargetResponseSchema)({
        status: "success",
        data: {
          threadId: row.thread_id,
          kind: row.kind === "space" ? "space" : "thread",
          name: (row.title?.trim() || "Untitled thread").slice(0, 500),
          code: formatHuddleCode(code),
        },
      }),
      200,
    );
  },
);
