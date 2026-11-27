import type {
  SpaceProgressChange,
  SpaceProgressData,
  SpaceProgressDay,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { DateTime } from "effect";
import { zoneFormatterCache } from "../../automations/recurrence.js";

const DAY_MS = 86_400_000;
/** A Space's chart reads at most this many pull requests and pushes. */
const MAX_CHANGES = 2_000;

interface PullRow {
  readonly repository: string;
  readonly number: number;
  readonly title: string | null;
  readonly state: string | null;
  readonly changed_at: string | null;
  readonly linked_at: string;
  readonly thread_id: ThreadId;
  readonly thread_title: string;
}

interface PushRow {
  readonly thread_id: ThreadId;
  readonly thread_title: string;
  readonly shipped_at: number;
}

/** The threads a Space started: its children, owned like it, not deleted. */
const SPACE_CHILDREN = `
  SELECT thread.id, thread.title FROM threads AS thread
    JOIN threads AS space_thread ON space_thread.id = thread.parent_thread_id
   WHERE thread.parent_thread_id = ?1
     AND +thread.owner_user_id = space_thread.owner_user_id
     AND thread.lifecycle_state != 'deleted'`;

/**
 * The verified pull requests linked to the Space's threads that merged in
 * the window or are still open, each once, under the thread that linked it
 * first, and the threads whose own commits reached the default branch in
 * the window. A closed, unmerged pull request shipped nothing. The window's
 * start is read loosely, a day early, so no time zone's first day misses one.
 */
const readChanges = async (
  db: D1Database,
  spaceThreadId: ThreadId,
  since: number,
) => {
  const [pulls, pushes] = await db.batch([
    db
      .prepare(
        `WITH child AS (${SPACE_CHILDREN}),
              linked AS (
                SELECT link.repository, link.number,
                       json_extract(link.subject_json, '$.title') AS title,
                       json_extract(link.subject_json, '$.state') AS state,
                       json_extract(link.subject_json, '$.changedAt') AS changed_at,
                       link.created_at AS linked_at,
                       child.id AS thread_id, child.title AS thread_title,
                       ROW_NUMBER() OVER (
                         PARTITION BY link.repository_key, link.number
                         ORDER BY link.created_at, child.id
                       ) AS rank
                  FROM thread_github_link AS link
                  JOIN child ON child.id = link.thread_id
                 WHERE link.kind = 'pull' AND link.verified = 1
              )
         SELECT repository, number, title, state, changed_at, linked_at,
                thread_id, thread_title
           FROM linked
          WHERE rank = 1
            AND (state = 'open'
                 OR (state = 'merged'
                     AND unixepoch(COALESCE(changed_at, linked_at)) * 1000 >= ?2))
          ORDER BY COALESCE(changed_at, linked_at) DESC
          LIMIT ${MAX_CHANGES}`,
      )
      .bind(spaceThreadId, since),
    db
      .prepare(
        `WITH child AS (${SPACE_CHILDREN})
         SELECT child.id AS thread_id, child.title AS thread_title,
                thread.shipped_at
           FROM child JOIN threads AS thread ON thread.id = child.id
          WHERE thread.ship_reason = 'default_branch'
            AND thread.shipped_at >= ?2
          ORDER BY thread.shipped_at DESC
          LIMIT ${MAX_CHANGES}`,
      )
      .bind(spaceThreadId, since),
  ]);
  return {
    pulls: (pulls?.results ?? []) as unknown as ReadonlyArray<PullRow>,
    pushes: (pushes?.results ?? []) as unknown as ReadonlyArray<PushRow>,
  };
};

const dayFormatter = zoneFormatterCache({
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `YYYY-MM-DD` of an instant in a time zone. */
const dayOf = (instant: number, timeZone: string) => {
  const format = dayFormatter(timeZone);
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

const instant = (value: string | null, fallback: string) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Date.parse(fallback);
};

/**
 * What a Space's threads shipped over the last `days` calendar days in
 * `timeZone`, today last: per day, the pull requests that merged and the
 * pushes to the default branch, and the pull requests open when it ended.
 * A merged pull request counts as open from when it was linked until it
 * merged; an open one from when it opened.
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
  const { pulls, pushes } = await readChanges(
    db,
    spaceThreadId,
    input.now - (input.days + 1) * DAY_MS,
  );
  const today = dayOf(input.now, input.timeZone);
  const dates = Array.from({ length: input.days }, (_, index) =>
    addDays(today, index - input.days + 1),
  );
  const changes = [
    ...pulls.map((row) => {
      const merged = row.state === "merged";
      const at = instant(row.changed_at, row.linked_at);
      const openedAt = merged ? Date.parse(row.linked_at) : at;
      const change: SpaceProgressChange = {
        id: `${row.repository}#${row.number}`,
        kind: "pull_request",
        number: row.number,
        url: `https://github.com/${row.repository}/pull/${row.number}`,
        title: (row.title ?? `Pull request #${row.number}`).slice(0, 512),
        state: merged ? "merged" : "open",
        at: timestamp(at),
        threadId: row.thread_id,
        threadTitle: row.thread_title.slice(0, 512),
      };
      return {
        change,
        day: dayOf(at, input.timeZone),
        opened: dayOf(Math.min(openedAt, at), input.timeZone),
        closed: merged ? dayOf(at, input.timeZone) : undefined,
      };
    }),
    ...pushes.map((row) => {
      const change: SpaceProgressChange = {
        id: row.thread_id,
        kind: "default_branch",
        title: row.thread_title.slice(0, 512),
        state: "merged",
        at: timestamp(row.shipped_at),
        threadId: row.thread_id,
        threadTitle: row.thread_title.slice(0, 512),
      };
      const day = dayOf(row.shipped_at, input.timeZone);
      return { change, day, opened: day, closed: day };
    }),
  ].toSorted(
    (left, right) =>
      DateTime.toEpochMillis(right.change.at) -
      DateTime.toEpochMillis(left.change.at),
  );
  const listed = new Set<string>();
  const days = dates.map((date): SpaceProgressDay => {
    let merged = 0;
    let pushed = 0;
    let openAtEnd = 0;
    const changeIds: string[] = [];
    for (const { change, day, opened, closed } of changes) {
      const landed = change.state === "merged" && day === date;
      if (landed && change.kind === "pull_request") merged += 1;
      if (landed && change.kind === "default_branch") pushed += 1;
      if (
        change.kind === "pull_request" &&
        opened <= date &&
        (closed === undefined || closed > date)
      )
        openAtEnd += 1;
      if (landed || (change.state === "open" && day === date)) {
        changeIds.push(change.id);
        listed.add(change.id);
      }
    }
    return { date, merged, pushed, openAtEnd, changeIds };
  });
  return {
    timeZone: input.timeZone,
    days,
    totals: {
      merged: days.reduce((total, day) => total + day.merged, 0),
      pushed: days.reduce((total, day) => total + day.pushed, 0),
      open: changes.filter(({ change }) => change.state === "open").length,
    },
    changes: changes
      .filter(({ change }) => listed.has(change.id))
      .map(({ change }) => change),
  };
};
