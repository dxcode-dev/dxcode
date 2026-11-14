import { Schema } from "effect";

/**
 * Background jobs a plugin declares (`extensions["dev.dxcode"].jobs`) and
 * their schedules, run by the plugin's Durable Object host on alarms:
 * `{ every: "5m" }` (1 minute to 30 days, in m, h, or d), `{ cron: "0 * * * *" }`
 * (five fields, UTC), or `{ at: "on-demand" }` (only when the code schedules
 * it with `ctx.jobs.schedule`).
 */

export const MAX_PLUGIN_JOBS = 50;

/** A declared job's id; an instance the code schedules adds `:<key>`. */
export const PLUGIN_JOB_ID = /^[a-z][a-z0-9-]{0,47}$/;
export const PLUGIN_JOB_INSTANCE_ID =
  /^[a-z][a-z0-9-]{0,47}(?::[A-Za-z0-9._-]{1,64})?$/;

export const PluginJobId = Schema.String.check(Schema.isPattern(PLUGIN_JOB_ID));

export const PluginJobSchedule = Schema.Union([
  Schema.Struct({
    // Bounds (1m to 30d) and cron fields are checked where the manifest is
    // read (core), so the web bundle carries no schedule code.
    every: Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,4}[mhd]$/)),
  }),
  Schema.Struct({
    cron: Schema.String.check(Schema.isMinLength(9), Schema.isMaxLength(100)),
  }),
  Schema.Struct({ at: Schema.Literal("on-demand") }),
]);

export type PluginJobSchedule = typeof PluginJobSchedule.Type;

export const PluginJob = Schema.Struct({
  id: PluginJobId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  schedule: PluginJobSchedule,
  host: Schema.optional(Schema.Literal("durable")),
});

export type PluginJob = typeof PluginJob.Type;

export const PLUGIN_DURABLE_SCOPES = ["install", "thread"] as const;
export const PluginDurableScope = Schema.Literals(PLUGIN_DURABLE_SCOPES);
export type PluginDurableScope = (typeof PLUGIN_DURABLE_SCOPES)[number];
