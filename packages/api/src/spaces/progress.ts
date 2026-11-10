import { ThreadId, Timestamp } from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/**
 * How a thread's work shipped, first signal wins:
 * `pull_request_merged` a pull request linked to it merged;
 * `ship_archived` its owner archived it from the outcome of its Ship run;
 * `default_branch` its own commits reached the default branch.
 */
export const ThreadShipReasonSchema = Schema.Literals([
  "default_branch",
  "pull_request_merged",
  "ship_archived",
]);

export type ThreadShipReason = typeof ThreadShipReasonSchema.Type;

export const SPACE_PROGRESS_DEFAULT_DAYS = 30;
export const SPACE_PROGRESS_MAX_DAYS = 90;

/** `GET /v1/spaces/:threadId/progress?days=30&tz=Europe/Berlin`. */
export const SpaceProgressQuerySchema = Schema.Struct({
  /** How many calendar days, today included. Left out: 30. */
  days: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[0-9]{1,3}$/)).pipe(
      Schema.decodeTo(Schema.FiniteFromString),
      Schema.decodeTo(
        Schema.Int.check(
          Schema.isBetween({ minimum: 1, maximum: SPACE_PROGRESS_MAX_DAYS }),
        ),
      ),
    ),
  ),
  /** The viewer's IANA time zone, which days are counted in. Left out: UTC. */
  tz: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  ),
});

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * One calendar day in the viewer's time zone: how many of the Space's threads
 * were created, shipped, and archived without shipping that day, and how
 * many were open when it ended. `threadIds` are the threads created,
 * shipped, or archived that day, newest first.
 */
export const SpaceProgressDaySchema = Schema.Struct({
  date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  created: Count,
  shipped: Count,
  archived: Count,
  openAtEnd: Count,
  threadIds: Schema.Array(ThreadId),
});

export type SpaceProgressDay = typeof SpaceProgressDaySchema.Type;

/** Where a thread stands for the chart: shipping wins over archiving. */
export const SpaceProgressOutcomeSchema = Schema.Literals([
  "shipped",
  "archived",
  "open",
]);

export type SpaceProgressOutcome = typeof SpaceProgressOutcomeSchema.Type;

/** A thread a day lists, enough to show it without another read. */
export const SpaceProgressThreadSchema = Schema.Struct({
  id: ThreadId,
  title: Schema.String.check(Schema.isMaxLength(512)),
  outcome: SpaceProgressOutcomeSchema,
  createdAt: Timestamp,
  shippedAt: Schema.NullOr(Timestamp),
  shipReason: Schema.NullOr(ThreadShipReasonSchema),
  archivedAt: Schema.NullOr(Timestamp),
});

export type SpaceProgressThread = typeof SpaceProgressThreadSchema.Type;

/**
 * `GET /v1/spaces/:threadId/progress`: the Space's threads over the last
 * `days` days, oldest day first and today last.
 *
 * A thread is open from when it was created until it shipped or was
 * archived, whichever came first; `openAtEnd` counts threads open when the
 * day ended (now, for today), so a thread started before the window and
 * still open counts too. `totals` are what the window's days add up to:
 * threads shipped and archived in it, and threads open now.
 */
export const SpaceProgressResponseSchema = successResponse(
  Schema.Struct({
    timeZone: Schema.String,
    days: Schema.Array(SpaceProgressDaySchema),
    totals: Schema.Struct({ shipped: Count, archived: Count, open: Count }),
    /** Every thread a day lists. */
    threads: Schema.Array(SpaceProgressThreadSchema),
  }),
);

export type SpaceProgressResponse = typeof SpaceProgressResponseSchema.Encoded;
export type SpaceProgressData = typeof SpaceProgressResponseSchema.Type.data;
