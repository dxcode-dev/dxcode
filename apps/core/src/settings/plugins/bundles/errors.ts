import { Schema } from "effect";

/** A bundle that dx refuses to import, with a reason shown to the person. */
export class PluginBundleRejected extends Schema.TaggedError<PluginBundleRejected>()(
  "PluginBundleRejected",
  { reason: Schema.String },
) {}

/** The bundle's source could not be fetched. */
export class PluginBundleSourceUnavailable extends Schema.TaggedError<PluginBundleSourceUnavailable>()(
  "PluginBundleSourceUnavailable",
  { reason: Schema.String },
) {}
