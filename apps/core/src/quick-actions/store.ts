import { type ThreadQuickAction, ThreadQuickActionSchema } from "@dx/api";
import { Option, Schema } from "effect";

/**
 * The pick the turn-end hook made for a Thread's latest ended turn
 * (`thread_quick_actions`). Only the hook writes it, from the history it
 * read on the server, so nothing a person sends can change what another
 * member of a shared Thread is shown.
 */
export interface StoredQuickActions {
  readonly messageId: string;
  readonly actions: ReadonlyArray<ThreadQuickAction>;
}

const decodeActions = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ThreadQuickActionSchema)),
);

export const storedQuickActions = async (
  db: D1Database,
  threadId: string,
): Promise<StoredQuickActions | undefined> => {
  const row = await db
    .prepare(
      "SELECT message_id, actions FROM thread_quick_actions WHERE thread_id = ?1",
    )
    .bind(threadId)
    .first<{ message_id: string; actions: string }>();
  if (row === null) return undefined;
  const actions = Option.getOrUndefined(decodeActions(row.actions));
  return actions === undefined
    ? undefined
    : { messageId: row.message_id, actions };
};

export const storeQuickActions = (
  db: D1Database,
  threadId: string,
  picked: StoredQuickActions,
) =>
  db
    .prepare(
      `INSERT INTO thread_quick_actions (thread_id, message_id, actions, picked_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (thread_id) DO UPDATE SET
         message_id = excluded.message_id,
         actions = excluded.actions,
         picked_at = excluded.picked_at`,
    )
    .bind(
      threadId,
      picked.messageId,
      JSON.stringify(picked.actions),
      new Date().toISOString(),
    )
    .run();
