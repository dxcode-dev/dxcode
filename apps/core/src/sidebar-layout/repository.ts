import {
  type SidebarGrouping,
  SidebarGroupingSchema,
  type SidebarLayoutData,
  type SidebarLayoutEntry,
  SidebarLayoutEntrySchema,
  type SidebarOrder,
  SidebarOrderSchema,
  SidebarWidthSchema,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { Option, Schema } from "effect";

/** Choices kept per person; older ones fall back to the default. */
const ENTRY_LIMIT = 500;

const decodeEntry = Schema.decodeUnknownOption(SidebarLayoutEntrySchema);
const decodeWidth = Schema.decodeUnknownOption(SidebarWidthSchema);
const decodeGrouping = Schema.decodeUnknownOption(SidebarGroupingSchema);
const decodeOrder = Schema.decodeUnknownOption(SidebarOrderSchema);

export const readSidebarLayout = async (
  db: D1Database,
  userId: UserId,
): Promise<SidebarLayoutData> => {
  const [rows, panelRows] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT kind, item_id, open FROM sidebar_layout_entry
          WHERE user_id = ?1`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT width, collapsed, thread_grouping, thread_order
           FROM sidebar_panel WHERE user_id = ?1`,
      )
      .bind(userId),
  ]);
  // A row the current schema no longer accepts keeps the default.
  const entries = (rows?.results ?? []).flatMap((row) =>
    Option.toArray(
      decodeEntry({ kind: row.kind, id: row.item_id, open: row.open === 1 }),
    ),
  );
  const panel = panelRows?.results[0];
  const width = Option.getOrUndefined(decodeWidth(panel?.width));
  const grouping = Option.getOrUndefined(
    decodeGrouping(panel?.thread_grouping),
  );
  const order = Option.getOrUndefined(decodeOrder(panel?.thread_order));
  return {
    entries,
    ...(width === undefined ? {} : { width }),
    ...(panel?.collapsed === 1 ? { collapsed: true } : {}),
    ...(grouping === undefined ? {} : { grouping }),
    ...(order === undefined ? {} : { order }),
  };
};

/** Records the person's Sidebar Layout: by Project, or one list. */
export const writeSidebarGrouping = async (
  db: D1Database,
  userId: UserId,
  grouping: SidebarGrouping,
  now = new Date(),
) => {
  await db
    .prepare(
      `INSERT INTO sidebar_panel (user_id, thread_grouping, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT (user_id) DO UPDATE SET
         thread_grouping = excluded.thread_grouping,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, grouping, now.toISOString())
    .run();
};

/** Records the person's Sidebar Order: by last activity, or by creation. */
export const writeSidebarOrder = async (
  db: D1Database,
  userId: UserId,
  order: SidebarOrder,
  now = new Date(),
) => {
  await db
    .prepare(
      `INSERT INTO sidebar_panel (user_id, thread_order, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT (user_id) DO UPDATE SET
         thread_order = excluded.thread_order,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, order, now.toISOString())
    .run();
};

/** Records the width the person dragged their desktop sidebar to. */
export const writeSidebarWidth = async (
  db: D1Database,
  userId: UserId,
  width: number,
  now = new Date(),
) => {
  await db
    .prepare(
      `INSERT INTO sidebar_panel (user_id, width, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT (user_id) DO UPDATE SET
         width = excluded.width,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, width, now.toISOString())
    .run();
};

/** Records whether the person keeps their desktop sidebar collapsed. */
export const writeSidebarCollapsed = async (
  db: D1Database,
  userId: UserId,
  collapsed: boolean,
  now = new Date(),
) => {
  await db
    .prepare(
      `INSERT INTO sidebar_panel (user_id, collapsed, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT (user_id) DO UPDATE SET
         collapsed = excluded.collapsed,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, collapsed ? 1 : 0, now.toISOString())
    .run();
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
