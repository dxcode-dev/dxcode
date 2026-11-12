import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/**
 * Huddle (experimental): a live audio and video call on Cloudflare
 * RealtimeKit, one per Thread. A Space's huddle is its own Thread's.
 */

/** The personal experimental flag that turns Huddle on. */
export const HUDDLE_FEATURE = "huddle";

const Text = Schema.String.check(Schema.isMaxLength(500));

export const HuddleSummaryResponseSchema = successResponse(
  Schema.Struct({
    active: Schema.Boolean,
    participants: Schema.Array(
      Schema.Struct({
        userId: Text,
        name: Text,
        avatarUrl: Schema.optional(
          Schema.String.check(Schema.isMaxLength(2048)),
        ),
      }),
    ).check(Schema.isMaxLength(200)),
    startedAt: Schema.optional(Text),
  }),
);

export type HuddleSummaryData =
  (typeof HuddleSummaryResponseSchema.Type)["data"];

export const HuddleJoinResponseSchema = successResponse(
  Schema.Struct({
    /** For the RealtimeKit client SDK; joins this person once. */
    authToken: Schema.String.check(Schema.isMaxLength(8192)),
    meetingId: Text,
  }),
);

export type HuddleJoinData = (typeof HuddleJoinResponseSchema.Type)["data"];

export const HuddleErrorResponseSchema = Schema.Union([
  errorResponse(
    "HUDDLE_DISABLED",
    "Huddle is off. Turn it on in Settings, Experimental Features.",
  ),
  errorResponse(
    "HUDDLE_UNAVAILABLE",
    "This deployment has no RealtimeKit app, so huddles are unavailable.",
  ),
  errorResponse(
    "HUDDLE_PROVIDER_FAILED",
    "RealtimeKit did not answer. Try again in a moment.",
  ),
]);

export type HuddleFailure =
  (typeof HuddleErrorResponseSchema.Type)["data"]["code"];
