import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/**
 * Composer quick actions: when the agent ends a turn, a
 * small Workers AI text model writes the replies the person might send
 * next from the agent's final reply, and Clef Flash picks which actions to
 * show above the composer, and in what order: those replies and Snooze
 * Until I'm Needed. The agent has no part in it and is never told.
 */
/** The most replies one turn offers. */
export const REPLY_OFFER_LIMIT = 2;
/** A reply is a short message, sent as written. */
export const REPLY_OFFER_MAX_LENGTH = 120;

export const ThreadQuickActionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("snooze") }),
  Schema.Struct({
    kind: Schema.Literal("reply"),
    text: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(REPLY_OFFER_MAX_LENGTH),
    ),
  }),
]);

export type ThreadQuickAction = typeof ThreadQuickActionSchema.Type;

export const ThreadQuickActionsResponseSchema = successResponse(
  Schema.Struct({
    /** The agent message the actions follow; absent when none is picked. */
    messageId: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
    /** In Clef's order; empty when Clef offers nothing or did not answer. */
    actions: Schema.Array(ThreadQuickActionSchema).check(
      Schema.isMaxLength(REPLY_OFFER_LIMIT + 1),
    ),
    /**
     * The turn that ended on the asked-about message is still being
     * picked for: ask again shortly.
     */
    pending: Schema.optional(Schema.Boolean),
  }),
);

export type ThreadQuickActionsData =
  (typeof ThreadQuickActionsResponseSchema.Type)["data"];

export const ThreadQuickActionsErrorResponseSchema = Schema.Union([
  errorResponse(
    "QUICK_ACTIONS_MODEL_UNAVAILABLE",
    "Composer quick actions need Workers AI's Clef Flash, which this deployment does not provide.",
  ),
  errorResponse(
    "QUICK_ACTIONS_READ_ONLY",
    "People who can only view this Thread get no quick actions.",
  ),
]);
