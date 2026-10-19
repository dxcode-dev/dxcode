import { type SidebarLayoutEntry, SidebarLayoutEntrySchema } from "@dx/api";
import type { UserId } from "@dx/domain";
import { Option, Schema } from "effect";

/** Choices kept per person; older ones fall back to the default. */
const ENTRY_LIMIT = 500;

const decodeEntry = Schema.decodeUnknownOption(SidebarLayoutEntrySchema);

export const readSidebarLayout = async (
  db: D1Database,
  userId: UserId,
): Promise<ReadonlyArray<SidebarLayoutEntry>> => {
  const rows = await db
    .prepare(
      `SELECT kind, item_id, open FROM sidebar_layout_entry
        WHERE user_id = ?1`,
    )
    .bind(userId)
    .all<{ kind: string; item_id: string; open: number }>();
  // A row the current schema no longer accepts keeps the default.
  return rows.results.flatMap((row) =>
    Option.toArray(
      decodeEntry({ kind: row.kind, id: row.item_id, open: row.open === 1 }),
    ),
  );
};

/**
 * Records one choice. A closed parent Thread is the default, so it removes
 * the row; a section keeps its row either way, since sections default
 * differently.
 */
export const writeSidebarLayoutEntry = async (
  db: D1Database,
  userId: UserId,
  entry: SidebarLayoutEntry,
  now = new Date(),
) => {
  await db.batch([
    entry.kind === "thread" && !entry.open
      ? db
          .prepare(
            `DELETE FROM sidebar_layout_entry
              WHERE user_id = ?1 AND kind = 'thread' AND item_id = ?2`,
          )
          .bind(userId, entry.id)
      : db
          .prepare(
            `INSERT INTO sidebar_layout_entry
               (user_id, kind, item_id, open, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (user_id, kind, item_id) DO UPDATE SET
               open = excluded.open,
               updated_at = excluded.updated_at`,
          )
          .bind(
            userId,
            entry.kind,
            entry.id,
            entry.open ? 1 : 0,
            now.toISOString(),
          ),
    db
      .prepare(
        `DELETE FROM sidebar_layout_entry
          WHERE user_id = ?1
            AND (kind, item_id) IN (
              SELECT kind, item_id FROM sidebar_layout_entry
               WHERE user_id = ?1
               ORDER BY updated_at DESC
               LIMIT -1 OFFSET ?2)`,
      )
      .bind(userId, ENTRY_LIMIT),
  ]);
};
