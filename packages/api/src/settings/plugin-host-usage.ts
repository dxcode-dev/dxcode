import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/**
 * A plugin's host cost line. Its own module,
 * so the schemas load with the plugin details that read them, not with
 * the Thread page's shared API chunk.
 */
/** One host's month-to-date use by a plugin, charged to its installer. */
export const PluginHostUsageLineSchema = /* @__PURE__ */ Schema.Struct({
  host: /* @__PURE__ */ Schema.Literals([
    "worker",
    "durable",
    "orb",
    "container",
  ]),
  unitsMs: Schema.Number,
  requests: Schema.Number,
  /** Estimated list price, in millionths of a US dollar. */
  costMicroUsd: Schema.Number,
  /** Calls refused for the tier or a cap. */
  blocked: Schema.Number,
});

export type PluginHostUsageLineData = typeof PluginHostUsageLineSchema.Type;

export const PluginHostUsageResponseSchema = /* @__PURE__ */ successResponse(
  /* @__PURE__ */ Schema.Struct({
    /** The UTC month the lines cover, `YYYY-MM`. */
    month: Schema.String,
    lines: /* @__PURE__ */ Schema.Array(PluginHostUsageLineSchema),
  }),
);
