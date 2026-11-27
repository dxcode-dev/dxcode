import type { UserId } from "@dx/domain";
import { findSharedThreadGrant } from "../thread-sharing/access.js";

/**
 * Who set up a schedule or GitHub subscription (`created_by_user_id`). Both
 * run as the Thread's owner, so one a Contribute member of a shared Thread
 * set up records that member, and pauses once their Contribute access ends
 * (#2667). NULL means the owner: it runs for as long as the owner keeps it.
 */

/**
 * The creator a write records: null when the owner asked, the member when
 * someone else did, and undefined (keep what is recorded) when no person's
 * message started the turn, such as an automation or another Thread.
 */
export const automationCreator = (
  ownerUserId: string,
  requesterUserId: UserId | undefined,
): string | null | undefined =>
  requesterUserId === undefined
    ? undefined
    : requesterUserId === ownerUserId
      ? null
      : requesterUserId;

/**
 * Why a member's automation may no longer run as the owner, or undefined
 * while the member still contributes to its Thread, or to the shared
 * Thread that started it.
 */
export const creatorAccessEnded = async (
  db: D1Database,
  threadId: string,
  creatorUserId: string | null,
  now = new Date(),
) => {
  if (creatorUserId === null) return undefined;
  const parent = await db
    .prepare("SELECT parent_thread_id FROM threads WHERE id = ?")
    .bind(threadId)
    .first<string | null>("parent_thread_id");
  for (const id of [threadId, ...(parent ? [parent] : [])]) {
    const grant = await findSharedThreadGrant(db, id, creatorUserId, now);
    if (grant?.access === "contribute") return undefined;
  }
  return "Paused: the member who set this up no longer has Contribute access to the Thread. The owner can resume it.";
};
