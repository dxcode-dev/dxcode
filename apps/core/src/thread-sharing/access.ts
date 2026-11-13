import type { Principal, UserId } from "@dx/domain";
import {
  activeMemberSql,
  threadProjectReachableSql,
} from "../settings/members/membership-sql.js";

export type SharedThreadAccess = "contribute" | "view";

/**
 * SQL predicate: the Thread is shared with a workspace that both `userId`
 * and the Thread owner actively belong to, and the owner still reaches the
 * Thread's Project. `thread` and `project` are table aliases; `userId` is a
 * trusted SQL expression (column or placeholder).
 */
export const sharedThreadVisibleSql = (
  thread: string,
  project: string,
  userId: string,
) => `(
  ${thread}.workspace_access IN ('view', 'contribute')
  -- Matches the partial index threads_shared_workspace_idx.
  AND ${thread}.workspace_access != 'none'
  AND ${thread}.shared_workspace_id IS NOT NULL
  AND ${thread}.owner_user_id != ${userId}
  AND ${activeMemberSql(`${thread}.shared_workspace_id`, userId)}
  AND ${activeMemberSql(`${thread}.shared_workspace_id`, `${thread}.owner_user_id`)}
  AND ${threadProjectReachableSql(project, `${thread}.owner_user_id`)})`;

/**
 * `contribute_until` for Contribute that never ends: a Space shared with its
 * workspace lets every member chat in it for as long as it stays shared.
 */
export const CONTRIBUTE_WITHOUT_END = "9999-12-31T23:59:59.999Z";

/** SQL expression: the effective member access at `now` (ISO placeholder). */
export const sharedThreadAccessSql = (thread: string, now: string) => `
  CASE WHEN ${thread}.workspace_access = 'contribute'
         AND ${thread}.contribute_until IS NOT NULL
         AND ${thread}.contribute_until > ${now}
       THEN 'contribute' ELSE 'view' END`;

export interface SharedThreadGrant {
  readonly ownerUserId: UserId;
  readonly lifecycleState: "active" | "archived";
  /** The owner snoozed the Thread; a member's message wakes it too. */
  readonly snoozed: boolean;
  /** The Thread is a Space. */
  readonly space: boolean;
  readonly access: SharedThreadAccess;
}

/** A member's access to another member's shared Thread, if any. */
export const findSharedThreadGrant = async (
  db: D1Database,
  threadId: string,
  userId: string,
  now = new Date(),
): Promise<SharedThreadGrant | undefined> => {
  const row = await db
    .prepare(
      `SELECT thread.owner_user_id, thread.lifecycle_state,
              thread.snoozed_until IS NOT NULL AS snoozed,
              thread.kind,
              ${sharedThreadAccessSql("thread", "?3")} AS access
         FROM threads AS thread
         JOIN projects AS project ON project.id = thread.project_id
        WHERE thread.id = ?1
          AND thread.lifecycle_state != 'deleted'
          AND ${sharedThreadVisibleSql("thread", "project", "?2")}`,
    )
    .bind(threadId, userId, now.toISOString())
    .first<{
      owner_user_id: string;
      lifecycle_state: "active" | "archived";
      snoozed: number;
      kind: string;
      access: SharedThreadAccess;
    }>();
  return row === null
    ? undefined
    : {
        ownerUserId: row.owner_user_id as UserId,
        lifecycleState: row.lifecycle_state,
        snoozed: row.snoozed === 1,
        space: row.kind === "space",
        access: row.access,
      };
};

/**
 * Only signed-in people use shared Threads. External applications act for
 * their own Threads only.
 */
export const canUseSharedThreads = (principal: Principal) =>
  principal.application === undefined;

/**
 * The owner's identity for a member acting in a shared Thread. Scopes stay
 * the actor's, but every user-keyed lookup now resolves as the owner.
 */
export const impersonateThreadOwner = (
  actor: Principal,
  ownerUserId: UserId,
): Principal => ({ ...actor, userId: ownerUserId });

/** Someone's access to a Thread: its owner, or a member it is shared with. */
export type ThreadAccess = "owner" | SharedThreadAccess;

/**
 * Whether someone may read the Thread's Orb: its files, Changes diffs,
 * Terminal, Portals, Desktop, processes and folders, and copies of its files
 * the Thread keeps. Owners and contributors may; a View-only member reads
 * the transcript, the Changes file list, and what the agent shared, never
 * the Orb, which can hold secrets such as `.env` files and shell history.
 */
export const mayReadOrbContents = (access: ThreadAccess) => access !== "view";

/**
 * The Thread routes that read the Orb, below `/threads/:threadId`. Thread
 * authorization refuses them to anyone who may not read Orb contents.
 * `/storage` is only the list: it names every stored copy, the read-only
 * restart's rescued work included. A single stored file decides by itself.
 */
const ORB_CONTENT_ROUTE =
  /^\/(?:(?:files|terminal|desktop|portals|memory|disk)(?:\/.*)?|files-sandbox|changes\/diff|storage)\/?$/;

/** Whether this Thread request path reads the Orb's contents. */
export const readsOrbContents = (path: string) => {
  const below = /\/threads\/[^/]+(\/.*)$/.exec(path)?.[1];
  return below !== undefined && ORB_CONTENT_ROUTE.test(below);
};

/**
 * Whether a member with View access may make this request. Viewers read the
 * conversation and the Changes file list, and follow the Thread; they cannot
 * prompt, stop, or write, and `authorizeThread` keeps them out of the Orb
 * (`readsOrbContents`).
 */
export const viewerMayRequest = (method: string, path: string) =>
  ["GET", "HEAD", "OPTIONS"].includes(method) ||
  // Following changes only the viewer's own sidebar.
  (["PUT", "DELETE"].includes(method) && /\/follow\/?$/.test(path)) ||
  // Viewers react to messages too: a reaction never reaches the agent.
  (["PUT", "DELETE"].includes(method) &&
    /\/message-reactions\/[^/]+\/[^/]+\/?$/.test(path)) ||
  // A bug report is the viewer's own and changes nothing in the Thread.
  (method === "POST" && /\/bug-reports\/?$/.test(path)) ||
  // Joining a huddle is talking, which changes nothing in the Thread, and
  // its link only invites people who can open the Thread already.
  (method === "POST" && /\/huddle\/(?:join|link)\/?$/.test(path));
