import { parseMessageAuthor } from "@dx/api";
import type { UserId } from "@dx/domain";
import type { DeliveredMessage } from "@flue/runtime";
import { Effect } from "effect";
import { loadAuthenticationRequirements } from "../auth/requirements.js";
import type { Bindings } from "../http/types.js";

/** Where people open this deployment of dx; undefined when unconfigured. */
export const spaceAppOrigin = async (
  bindings: Bindings,
): Promise<string | undefined> => {
  try {
    return new URL(
      (await Effect.runPromise(loadAuthenticationRequirements(bindings)))
        .authUrl,
    ).origin;
  } catch {
    return undefined;
  }
};

/**
 * The Space that started this Thread, for the child's prompt; undefined
 * for a Thread no Space started.
 */
export const readStartingSpace = async (
  db: D1Database,
  threadId: string,
): Promise<{ readonly name: string } | undefined> => {
  const row = await db
    .prepare(
      `SELECT space_thread.title FROM threads AS thread
         JOIN threads AS space_thread
           ON space_thread.id = thread.started_by_thread_id
        WHERE thread.id = ?1 AND space_thread.kind = 'space'`,
    )
    .bind(threadId)
    .first<{ title: string }>();
  return row === null ? undefined : { name: row.title };
};

/**
 * The person whose message a turn answers: the author of a person's own
 * message. A message from another Thread's agent or an automation, a chat
 * message, or a signal names no one.
 */
export const deliveryRequester = (
  delivery: DeliveredMessage | undefined,
): UserId | undefined => {
  if (delivery?.kind !== "user") return undefined;
  const tag = parseMessageAuthor(delivery.body);
  if (
    tag.author === undefined ||
    tag.sourceThreadId !== undefined ||
    tag.automation !== undefined ||
    tag.chat === true
  )
    return undefined;
  return tag.author.userId as UserId;
};
