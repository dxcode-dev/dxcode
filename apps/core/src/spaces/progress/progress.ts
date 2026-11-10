import type {
  SpaceProgressData,
  SpaceProgressDay,
  SpaceProgressThread,
  ThreadShipReason,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { DateTime } from "effect";

const DAY_MS = 86_400_000;
/** A Space's chart reads at most this many of its threads. */
const MAX_THREADS = 2_000;

interface ProgressRow {
  readonly id: ThreadId;
  readonly title: string;
  readonly created_at: string;
  readonly shipped_at: number | null;
  readonly ship_reason: ThreadShipReason | null;
  /** When it was archived, only while it is. */
  readonly archived_at: number | null;
}

/**
 * The threads a Space started that were open at some point in the window:
 * its children, owned like it, not closed before the window began. The
 * window's start is read loosely, a day early, so no time zone's first day
 * misses one; counting by day drops what falls before it.
 */
const readProgressRows = async (
  db: D1Database,
  spaceThreadId: ThreadId,
  since: number,
) =>
  (
    await db
      .prepare(
        `SELECT id, title, created_at, shipped_at, ship_reason, archived_at
           FROM (
             SELECT thread.id, thread.title, thread.created_at,
                    thread.shipped_at, thread.ship_reason,
                    CASE WHEN thread.lifecycle_state = 'archived'
                      -- Archived before archive times were kept: its last change.
                      THEN COALESCE(thread.archived_at,
                        CAST(strftime('%s', thread.updated_at) AS INTEGER) * 1000)
                    END AS archived_at
               FROM threads AS thread
               JOIN threads AS space_thread
                 ON space_thread.id = thread.parent_thread_id
              WHERE thread.parent_thread_id = ?1
                AND +thread.owner_user_id = space_thread.owner_user_id
                AND thread.lifecycle_state != 'deleted'
           )
          WHERE COALESCE(shipped_at, ?2) >= ?2
            AND COALESCE(archived_at, ?2) >= ?2
          ORDER BY created_at DESC, id DESC
          LIMIT ${MAX_THREADS}`,
      )
      .bind(spaceThreadId, since)
      .all<ProgressRow>()
  ).results;

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD` of an instant in a time zone. */
const dayOf = (instant: number, timeZone: string) => {
  let format = dayFormatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatters.set(timeZone, format);
  }
  const parts = Object.fromEntries(
    format
      .formatToParts(new Date(instant))
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
};

/** The calendar day `offset` days from `day` (`YYYY-MM-DD`). */
const addDays = (day: string, offset: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + offset * DAY_MS)
    .toISOString()
    .slice(0, 10);

const timestamp = (value: number) => DateTime.makeUnsafe(new Date(value));

/**
 * A Space's progress over the last `days` calendar days in `timeZone`,
 * today last. Each thread counts once: shipped on the day it shipped,
 * archived on the day it was archived if it never shipped, and open from
 * the day it was created until the day it shipped or was archived.
 */
export const spaceProgress = async (
  db: D1Database,
  spaceThreadId: ThreadId,
  input: {
    readonly days: number;
    readonly timeZone: string;
    readonly now: number;
  },
): Promise<SpaceProgressData> => {
  const rows = await readProgressRows(
    db,
    spaceThreadId,
    input.now - (input.days + 1) * DAY_MS,
  );
  const today = dayOf(input.now, input.timeZone);
  const dates = Array.from({ length: input.days }, (_, index) =>
    addDays(today, index - input.days + 1),
  );
  const threads = rows.map((row) => {
    const createdAt = Date.parse(row.created_at);
    const shipped =
      row.shipped_at === null
        ? undefined
        : dayOf(row.shipped_at, input.timeZone);
    const archived =
      row.archived_at === null
        ? undefined
        : dayOf(row.archived_at, input.timeZone);
    const closedAt = Math.min(
      row.shipped_at ?? Number.POSITIVE_INFINITY,
      row.archived_at ?? Number.POSITIVE_INFINITY,
    );
    return {
      row,
      createdAt,
      created: dayOf(createdAt, input.timeZone),
      shipped,
      // Shipping wins: a thread archived and then shipped counts shipped.
      archived: shipped === undefined ? archived : undefined,
      closed: Number.isFinite(closedAt)
        ? dayOf(closedAt, input.timeZone)
        : undefined,
    };
  });
  const listed = new Set<ThreadId>();
  const days = dates.map((date): SpaceProgressDay => {
    let created = 0;
    let shipped = 0;
    let archived = 0;
    let openAtEnd = 0;
    const threadIds: ThreadId[] = [];
    for (const thread of threads) {
      const createdToday = thread.created === date;
      const shippedToday = thread.shipped === date;
      const archivedToday = thread.archived === date;
      if (createdToday) created += 1;
      if (shippedToday) shipped += 1;
      if (archivedToday) archived += 1;
      if (
        thread.created <= date &&
        (thread.closed === undefined || thread.closed > date)
      )
        openAtEnd += 1;
      if (createdToday || shippedToday || archivedToday) {
        threadIds.push(thread.row.id);
        listed.add(thread.row.id);
      }
    }
    return { date, created, shipped, archived, openAtEnd, threadIds };
  });
  return {
    timeZone: input.timeZone,
    days,
    totals: {
      shipped: days.reduce((total, day) => total + day.shipped, 0),
      archived: days.reduce((total, day) => total + day.archived, 0),
      open: days.at(-1)?.openAtEnd ?? 0,
    },
    threads: threads
      .filter(({ row }) => listed.has(row.id))
      .map(
        ({ row, createdAt }): SpaceProgressThread => ({
          id: row.id,
          title: row.title.slice(0, 512),
          outcome:
            row.shipped_at !== null
              ? "shipped"
              : row.archived_at !== null
                ? "archived"
                : "open",
          createdAt: timestamp(createdAt),
          shippedAt: row.shipped_at === null ? null : timestamp(row.shipped_at),
          shipReason: row.shipped_at === null ? null : row.ship_reason,
          archivedAt:
            row.archived_at === null ? null : timestamp(row.archived_at),
        }),
      ),
  };
};
