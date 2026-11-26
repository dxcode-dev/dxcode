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
 * One change a Space's threads shipped or have open: a pull request linked
 * to one of its threads (`pull_request`), or a thread's own commits pushed
 * straight to the default branch (`default_branch`). A pull request linked
 * to several threads counts once, under the thread that linked it first.
 */
export const SpaceProgressChangeSchema = Schema.Struct({
  /** `owner/name#number` for a pull request, the thread's ID for a push. */
  id: Schema.String.check(Schema.isMaxLength(256)),
  kind: Schema.Literals(["pull_request", "default_branch"]),
  /** The pull request's number; absent for a push. */
  number: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  /** The pull request on GitHub; absent for a push. */
  url: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
  title: Schema.String.check(Schema.isMaxLength(512)),
  /** A push is always merged: its commits are on the default branch. */
  state: Schema.Literals(["merged", "open"]),
  /** When it merged or was pushed; for an open pull request, when it opened. */
  at: Timestamp,
  threadId: ThreadId,
  threadTitle: Schema.String.check(Schema.isMaxLength(512)),
});

export type SpaceProgressChange = typeof SpaceProgressChangeSchema.Type;

/**
 * One calendar day in the viewer's time zone: how many pull requests merged
 * and how many pushes reached the default branch that day, and how many
 * pull requests were open when it ended. `changeIds` are the changes that
 * merged, were pushed, or opened and are still open that day, newest first.
 */
export const SpaceProgressDaySchema = Schema.Struct({
  date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  merged: Count,
  pushed: Count,
  openAtEnd: Count,
  changeIds: Schema.Array(Schema.String),
});

export type SpaceProgressDay = typeof SpaceProgressDaySchema.Type;

/**
 * `GET /v1/spaces/:threadId/progress`: what the Space's threads shipped over
 * the last `days` days, oldest day first and today last, counted from
 * changes rather than thread states. A thread can merge several pull
 * requests, or one while it still has work, and each counts on its day.
 * `totals` add up the window's merged pull requests and pushes, and the
 * pull requests open now.
 */
export const SpaceProgressResponseSchema = successResponse(
  Schema.Struct({
    timeZone: Schema.String,
    days: Schema.Array(SpaceProgressDaySchema),
    totals: Schema.Struct({ merged: Count, pushed: Count, open: Count }),
    /** Every change a day lists. */
    changes: Schema.Array(SpaceProgressChangeSchema),
  }),
);

export type SpaceProgressResponse = typeof SpaceProgressResponseSchema.Encoded;
export type SpaceProgressData = typeof SpaceProgressResponseSchema.Type.data;
