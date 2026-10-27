import {
  nextOccurrence,
  parseRecurrence,
  type Recurrence,
  RecurrenceInvalid,
} from "./recurrence.js";

/**
 * A Thread's one schedule (D1 `thread_schedule`). The stored rule always
 * carries its DTSTART and zone, so parsing it again reproduces the same
 * occurrences whatever the owner's zone is now.
 */
export interface ScheduleRow {
  readonly thread_id: string;
  readonly owner_user_id: string;
  readonly title: string;
  readonly prompt: string;
  readonly rrule: string;
  readonly time_zone: string;
  readonly label: string;
  readonly run_mode: "existing" | "fresh";
  readonly agent_mode: string | null;
  readonly enabled: number;
  readonly next_run_at: string | null;
  readonly fired_count: number;
  readonly last_run_at: string | null;
  readonly last_run_status:
    | "delivered"
    | "started"
    | "skipped"
    | "failed"
    | null;
  readonly last_run_detail: string | null;
  readonly last_run_thread_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const COLUMNS = `thread_id, owner_user_id, title, prompt, rrule, time_zone,
  label, run_mode, agent_mode, enabled, next_run_at, fired_count, last_run_at,
  last_run_status, last_run_detail, last_run_thread_id, created_at, updated_at`;

/** The owner's IANA zone, recorded by their browser; UTC until it has. */
export const ownerTimeZone = async (db: D1Database, ownerUserId: string) =>
  (await db
    .prepare("SELECT time_zone FROM user_time_zone WHERE user_id = ?")
    .bind(ownerUserId)
    .first<string>("time_zone")) ?? "UTC";

export const readSchedule = (db: D1Database, threadId: string) =>
  db
    .prepare(`SELECT ${COLUMNS} FROM thread_schedule WHERE thread_id = ?`)
    .bind(threadId)
    .first<ScheduleRow>();

export const parseStoredRule = (
  row: Pick<ScheduleRow, "rrule" | "time_zone">,
) => parseRecurrence(row.rrule, { now: new Date(), timeZone: row.time_zone });

/**
 * The first firing at or after now (or the rule's DTSTART, when that is
 * later); undefined once the rule has nothing left.
 */
export const firstRun = (rule: Recurrence, fired: number, now = new Date()) =>
  nextOccurrence(
    rule,
    new Date(Math.max(rule.dtstart.getTime(), now.getTime() - 60_000)),
    fired,
    true,
  );

/** What the schedule tools and Settings show for a schedule. */
export const scheduleView = (row: ScheduleRow) => ({
  threadId: row.thread_id,
  title: row.title,
  prompt: row.prompt,
  schedule: row.rrule,
  scheduleLabel: row.label,
  timeZone: row.time_zone,
  runMode: row.run_mode,
  ...(row.agent_mode === null ? {} : { agentMode: row.agent_mode }),
  enabled: row.enabled === 1,
  status:
    row.next_run_at === null
      ? "finished"
      : row.enabled === 1
        ? "active"
        : "paused",
  ...(row.next_run_at === null ? {} : { nextRunAt: row.next_run_at }),
  firedCount: row.fired_count,
  ...(row.last_run_at === null
    ? {}
    : {
        lastRun: {
          at: row.last_run_at,
          status: row.last_run_status,
          ...(row.last_run_detail === null
            ? {}
            : { detail: row.last_run_detail }),
          ...(row.last_run_thread_id === null
            ? {}
            : { threadId: row.last_run_thread_id }),
        },
      }),
});

export interface ScheduleInput {
  readonly title: string;
  readonly prompt: string;
  readonly schedule: string;
  readonly label: string;
  readonly runMode: "existing" | "fresh";
  readonly agentMode: string | null;
}

/** Replaces the Thread's schedule and enables it. */
export const writeSchedule = async (
  db: D1Database,
  threadId: string,
  ownerUserId: string,
  input: ScheduleInput,
  now = new Date(),
) => {
  const rule = parseRecurrence(input.schedule, {
    now,
    timeZone: await ownerTimeZone(db, ownerUserId),
  });
  const next = firstRun(rule, 0, now);
  if (next === undefined)
    throw new RecurrenceInvalid("This schedule would never fire.");
  const at = now.toISOString();
  await db
    .prepare(
      `INSERT INTO thread_schedule (${COLUMNS})
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, 0, NULL, NULL, NULL, NULL, ?11, ?11)
       ON CONFLICT (thread_id) DO UPDATE SET
         title = excluded.title, prompt = excluded.prompt, rrule = excluded.rrule,
         time_zone = excluded.time_zone, label = excluded.label,
         run_mode = excluded.run_mode, agent_mode = excluded.agent_mode,
         enabled = 1, next_run_at = excluded.next_run_at, fired_count = 0,
         updated_at = excluded.updated_at`,
    )
    .bind(
      threadId,
      ownerUserId,
      input.title,
      input.prompt,
      rule.text,
      rule.timeZone,
      input.label,
      input.runMode,
      input.agentMode,
      next.toISOString(),
      at,
    )
    .run();
  return readSchedule(db, threadId);
};

/**
 * Changes some fields of the Thread's schedule. A new rule starts counting
 * firings again; resuming looks for the next occurrence from now, so a
 * paused schedule never replays what it missed.
 */
export const patchSchedule = async (
  db: D1Database,
  current: ScheduleRow,
  patch: Partial<ScheduleInput> & { readonly enabled?: boolean },
  now = new Date(),
) => {
  let rrule = current.rrule;
  let timeZone = current.time_zone;
  let fired = current.fired_count;
  let next = current.next_run_at;
  const enabled = patch.enabled ?? current.enabled === 1;
  if (patch.schedule !== undefined) {
    const rule = parseRecurrence(patch.schedule, {
      now,
      timeZone: await ownerTimeZone(db, current.owner_user_id),
    });
    rrule = rule.text;
    timeZone = rule.timeZone;
    fired = 0;
    next = firstRun(rule, 0, now)?.toISOString() ?? null;
  } else if (enabled && current.enabled !== 1 && next !== null)
    next =
      nextOccurrence(parseStoredRule(current), now, fired)?.toISOString() ??
      null;
  const runMode = patch.runMode ?? current.run_mode;
  const agentMode =
    patch.agentMode === undefined ? current.agent_mode : patch.agentMode;
  await db
    .prepare(
      `UPDATE thread_schedule SET title = ?2, prompt = ?3, rrule = ?4,
         time_zone = ?5, label = ?6, run_mode = ?7, agent_mode = ?8,
         enabled = ?9, next_run_at = ?10, fired_count = ?11, updated_at = ?12
       WHERE thread_id = ?1`,
    )
    .bind(
      current.thread_id,
      patch.title ?? current.title,
      patch.prompt ?? current.prompt,
      rrule,
      timeZone,
      patch.label ?? current.label,
      runMode,
      runMode === "fresh" ? agentMode : null,
      enabled ? 1 : 0,
      next,
      fired,
      now.toISOString(),
    )
    .run();
  return readSchedule(db, current.thread_id);
};

export const deleteSchedule = async (db: D1Database, threadId: string) =>
  (
    await db
      .prepare("DELETE FROM thread_schedule WHERE thread_id = ?")
      .bind(threadId)
      .run()
  ).meta.changes > 0;

/** Schedules whose next firing has come, oldest first. */
export const dueSchedules = async (db: D1Database, now: Date, limit = 50) =>
  (
    await db
      .prepare(
        `SELECT ${COLUMNS} FROM thread_schedule
          WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
          ORDER BY next_run_at LIMIT ?`,
      )
      .bind(now.toISOString(), limit)
      .all<ScheduleRow>()
  ).results;

/**
 * Claims one firing: moves `next_run_at` on from the value the sweep read,
 * so two overlapping sweeps fire an occurrence once. The next occurrence is
 * the first after now, so a sweep that ran late skips what it missed.
 */
export const claimFiring = async (
  db: D1Database,
  row: ScheduleRow,
  now: Date,
) => {
  let next: string | null = null;
  try {
    next =
      nextOccurrence(
        parseStoredRule(row),
        new Date(Math.max(now.getTime(), Date.parse(row.next_run_at ?? ""))),
        row.fired_count + 1,
      )?.toISOString() ?? null;
  } catch {
    // A rule that no longer parses fires this once and stops.
  }
  const claimed = await db
    .prepare(
      `UPDATE thread_schedule
          SET next_run_at = ?3, fired_count = fired_count + 1,
              last_run_at = ?4, last_run_status = NULL, last_run_detail = NULL,
              last_run_thread_id = NULL, updated_at = ?4
        WHERE thread_id = ?1 AND next_run_at = ?2 AND enabled = 1`,
    )
    .bind(row.thread_id, row.next_run_at, next, now.toISOString())
    .run();
  return claimed.meta.changes === 1;
};

export const recordFiring = (
  db: D1Database,
  threadId: string,
  outcome: {
    readonly status: "delivered" | "started" | "skipped" | "failed";
    readonly detail?: string;
    readonly threadId?: string;
  },
) =>
  db
    .prepare(
      `UPDATE thread_schedule
          SET last_run_status = ?2, last_run_detail = ?3, last_run_thread_id = ?4
        WHERE thread_id = ?1`,
    )
    .bind(
      threadId,
      outcome.status,
      outcome.detail?.slice(0, 500) ?? null,
      outcome.threadId ?? null,
    )
    .run();
