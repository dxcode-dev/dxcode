import { DATA_VIEW_PLACES } from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/**
 * Views described as data: a plugin's JSON view file, drawn by dx with its
 * own parts in each place the manifest's `show` names, from state the
 * plugin's code sets with `ctx.views.set`.
 */

const Text = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

const ViewId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,47}$/));

/** A view described as data that the person can open. */
export const PluginDataViewOption = Schema.Struct({
  plugin: Text(96),
  view: ViewId,
  title: Text(40),
  pluginTitle: Text(96),
  /** `lucide:<name>` or an icon asset's sha256. */
  icon: Schema.optional(
    Schema.String.check(
      Schema.isPattern(/^(?:lucide:[a-z0-9-]{1,64}|[0-9a-f]{64})$/),
    ),
  ),
  show: Schema.Array(Schema.Literals(DATA_VIEW_PLACES)),
  /** The install, and the sha256 of the view file: its file's address. */
  installId: Text(128),
  integrity: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});

export type PluginDataViewOption = typeof PluginDataViewOption.Type;

export const PluginDataViewStateResponseSchema = successResponse(
  Schema.Struct({
    state: Schema.Unknown,
    /** 0 until the plugin first sets the state. */
    version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    /** Lets the realtime connection carry this view's changes. */
    watch: Schema.optional(Schema.String),
    /** `<install id>/<view id>`, as changes on the realtime connection name it. */
    key: Text(200),
  }),
);

export type PluginDataViewStateData =
  (typeof PluginDataViewStateResponseSchema.Type)["data"];

/** A view's `call` action: run a function the plugin exposes. */
export const PluginDataViewCallRequestSchema = Schema.Struct({
  fn: Schema.String.check(Schema.isPattern(/^[a-z][A-Za-z0-9_]{0,47}$/)),
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  /** Where the reply goes in the view's state. */
  result: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});

export type PluginDataViewCallRequest =
  typeof PluginDataViewCallRequestSchema.Type;

export const PluginDataViewCallResponseSchema = successResponse(
  Schema.Struct({
    value: Schema.Unknown,
    /** The state's version after the reply was stored at `result`. */
    version: Schema.optional(Schema.Int),
  }),
);

export const PluginDataViewErrorCodes = [
  "INVALID_REQUEST",
  "PLUGIN_VIEW_NOT_FOUND",
  "PLUGIN_VIEW_READ_ONLY",
  "PLUGIN_VIEW_CALL_REFUSED",
  "PLUGIN_VIEW_CALL_FAILED",
] as const;

export type PluginDataViewErrorCode = (typeof PluginDataViewErrorCodes)[number];

export const PluginDataViewErrorResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literals(PluginDataViewErrorCodes),
    message: Schema.String,
    requestId: Schema.String,
    detail: Schema.optional(Schema.String),
  }),
});
