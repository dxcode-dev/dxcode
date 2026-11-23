import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/** One of the person's Orbs on Settings → Usage → Orb. */
export const OrbUsageRowDataSchema = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  /** Null for a Thread with no project. */
  projectName: Schema.NullOr(Schema.String),
  /** The Orb size (runner profile), such as `a1.medium`; null when unknown. */
  size: Schema.NullOr(Schema.String),
  /** When the Orb last paused; null while it runs or when dx has no record. */
  pausedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** Orb time in the last 24 hours, in milliseconds; null when dx has no record. */
  last24hMs: Schema.NullOr(Schema.Int),
  /**
   * What that time cost, in micro-dollars of the deployment's credits;
   * null for an Orb the deployment does not charge for.
   */
  last24hCostMicros: Schema.NullOr(Schema.Int),
});

export type OrbUsageRowData = typeof OrbUsageRowDataSchema.Type;

/** One Thread's charged Orb time this month. */
export const OrbMonthThreadDataSchema = Schema.Struct({
  threadId: ThreadId,
  /** Null when the Thread is gone or no longer the person's. */
  title: Schema.NullOr(Schema.String),
  projectName: Schema.NullOr(Schema.String),
  ms: Schema.Int,
  /** Micro-dollars of the deployment's credits. */
  costMicros: Schema.Int,
});

/**
 * The Orb time the deployment charged the person since the start of this
 * UTC month, per Thread, most credits first, with its totals.
 */
export const OrbMonthDataSchema = Schema.Struct({
  from: Schema.DateTimeUtcFromString,
  totalMs: Schema.Int,
  totalCostMicros: Schema.Int,
  threads: Schema.Array(OrbMonthThreadDataSchema),
});

export const OrbUsageDataSchema = Schema.Struct({
  refreshedAt: Schema.DateTimeUtcFromString,
  running: Schema.Array(OrbUsageRowDataSchema),
  paused: Schema.Array(OrbUsageRowDataSchema),
  /** Null when the deployment charges for no Orb. */
  month: Schema.NullOr(OrbMonthDataSchema),
});

export type OrbUsageData = typeof OrbUsageDataSchema.Type;

export const GetOrbUsageResponseSchema = successResponse(OrbUsageDataSchema);

export const OrbUsageUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Orb usage is temporarily unavailable.",
);
