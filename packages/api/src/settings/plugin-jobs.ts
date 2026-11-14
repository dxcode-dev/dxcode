import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/**
 * A plugin's background jobs and live connections, run by its Durable
 * Object host, as the Plugins page shows them.
 */

export const PluginJobDataSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  schedule: Schema.Struct({
    every: Schema.optional(Schema.String),
    cron: Schema.optional(Schema.String),
    at: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  }),
  status: Schema.Literals([
    "scheduled",
    "running",
    "stopped",
    "paused",
    "done",
  ]),
  /** Epoch milliseconds. */
  nextRunAt: Schema.optional(Schema.Number),
  lastRunAt: Schema.optional(Schema.Number),
  lastOutcome: Schema.optional(Schema.String),
  lastError: Schema.optional(Schema.String),
  lastMs: Schema.optional(Schema.Number),
  runs: Schema.Number,
  /** The Thread a thread-scoped job runs for. */
  threadId: Schema.optional(Schema.String),
  /** The Thread's title, for the viewer's own Threads only. */
  threadTitle: Schema.optional(Schema.String),
});

export type PluginJobData = typeof PluginJobDataSchema.Type;

export const PluginJobsResponseSchema = successResponse(
  Schema.Struct({
    /** False when the plugin's tier does not allow the durable host. */
    available: Schema.Boolean,
    /** Why it is unavailable: "blocked-tier" or "not-deployed". */
    reason: Schema.optional(Schema.String),
    jobs: Schema.Array(PluginJobDataSchema),
    watches: Schema.Array(
      Schema.Struct({
        target: Schema.String,
        connectedAt: Schema.Number,
        messages: Schema.Number,
        dropped: Schema.Number,
      }),
    ),
    storage: Schema.Struct({
      sqlBytes: Schema.Number,
      blobBytes: Schema.Number,
    }),
    /** The tier's job limit, so the page can say "3 of 20". */
    jobLimit: Schema.Number,
    canMutate: Schema.Boolean,
  }),
);

export type PluginJobsData = typeof PluginJobsResponseSchema.Type.data;

export const PluginJobActionRequestSchema = Schema.Struct({
  threadId: Schema.optional(
    Schema.String.check(Schema.isPattern(/^thr_[A-Za-z0-9_-]{1,64}$/)),
  ),
});

export const PluginJobParamsSchema = Schema.Struct({
  jobId: Schema.String.check(
    Schema.isPattern(/^[a-z][a-z0-9-]{0,47}(?::[A-Za-z0-9._-]{1,64})?$/),
  ),
});
