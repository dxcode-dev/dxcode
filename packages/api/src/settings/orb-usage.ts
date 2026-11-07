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
});

export type OrbUsageRowData = typeof OrbUsageRowDataSchema.Type;

export const OrbUsageDataSchema = Schema.Struct({
  refreshedAt: Schema.DateTimeUtcFromString,
  running: Schema.Array(OrbUsageRowDataSchema),
  paused: Schema.Array(OrbUsageRowDataSchema),
});

export type OrbUsageData = typeof OrbUsageDataSchema.Type;

export const GetOrbUsageResponseSchema = successResponse(OrbUsageDataSchema);

export const OrbUsageUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Orb usage is temporarily unavailable.",
);
