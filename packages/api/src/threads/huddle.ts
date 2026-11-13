import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/**
 * Huddle: a live audio and video call on Cloudflare RealtimeKit, one per
 * Thread. A Space's huddle is its own Thread's. The deployment turns it on.
 */

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

/**
 * A huddle link's code: nine letters without i, l, or o, shown in three
 * groups like `abc-def-ghk`. Typed without hyphens, with spaces, or in
 * capitals, it is the same code.
 */
export const HUDDLE_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz";
export const HUDDLE_CODE_LENGTH = 9;

/** The stored form (nine lowercase letters), or undefined if `typed` is no code. */
export const normalizeHuddleCode = (typed: string): string | undefined => {
  const letters = typed.toLowerCase().replace(/[\s-]+/g, "");
  if (letters.length !== HUDDLE_CODE_LENGTH) return undefined;
  for (const letter of letters)
    if (!HUDDLE_CODE_ALPHABET.includes(letter)) return undefined;
  return letters;
};

/** `abcdefghk` as `abc-def-ghk`. */
export const formatHuddleCode = (code: string) =>
  `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6)}`;

const HuddleCode = Schema.String.check(
  Schema.isPattern(/^[a-hjkmnp-z]{3}-[a-hjkmnp-z]{3}-[a-hjkmnp-z]{3}$/),
);

/** `POST /v1/threads/:id/huddle/link`: the Thread's huddle link. */
export const HuddleLinkResponseSchema = successResponse(
  Schema.Struct({
    code: HuddleCode,
    /** The workspace's short name the link opens in. */
    workspace: Text,
    /** `/huddle/<workspace>/<code>`, on this deployment's origin. */
    path: Text,
  }),
);

export type HuddleLinkData = (typeof HuddleLinkResponseSchema.Type)["data"];

/** `GET /v1/huddle-links/:workspace/:code`: where a link opens. */
export const HuddleLinkTargetResponseSchema = successResponse(
  Schema.Struct({
    threadId: Text,
    kind: Schema.Literals(["thread", "space"]),
    name: Text,
    code: HuddleCode,
  }),
);

export type HuddleLinkTargetData =
  (typeof HuddleLinkTargetResponseSchema.Type)["data"];

export const HuddleErrorResponseSchema = Schema.Union([
  errorResponse(
    "HUDDLE_PRIVATE",
    "Huddles are only in shared threads and Spaces. Share this one with your workspace first.",
  ),
  errorResponse(
    "HUDDLE_LINK_NOT_FOUND",
    "This huddle link doesn't exist. Check the code and the workspace name.",
  ),
  errorResponse(
    "HUDDLE_LINK_FORBIDDEN",
    "You don't have access to this huddle. Ask whoever sent the link to share the thread with your workspace.",
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
