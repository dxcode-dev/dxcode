import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/**
 * Composer quick actions (experimental): when the agent ends a turn, Clef
 * Flash on Workers AI picks which actions to show above the composer, and in
 * what order, from dx's candidates: Snooze Until I'm Needed and the replies
 * the agent offered with its `offer_replies` tool. The tool call's input is
 * the only source of replies; nothing is read from message text, and a
 * chip sends its reply unchanged.
 */
export const OFFER_REPLIES_TOOL = "offer_replies";
/** The most replies one turn offers. */
export const REPLY_OFFER_LIMIT = 2;
/** A reply is a short message, sent as written. */
export const REPLY_OFFER_MAX_LENGTH = 120;
/** The personal experimental flag that turns the row on. */
export const COMPOSER_QUICK_ACTIONS_FEATURE = "composer-quick-actions";

/** Claude Code calls dx's tools as `mcp__dx__<name>`. */
export const isOfferRepliesTool = (toolName: string | undefined) =>
  toolName === OFFER_REPLIES_TOOL ||
  toolName === `mcp__dx__${OFFER_REPLIES_TOOL}`;

/**
 * The replies an `offer_replies` call's input holds, as the tool accepted
 * them: trimmed, non-empty, short enough, without repeats, at most two.
 */
export const offeredRepliesOf = (input: unknown): ReadonlyArray<string> => {
  const replies = (input as { readonly replies?: unknown } | null | undefined)
    ?.replies;
  if (!Array.isArray(replies)) return [];
  const kept = new Set<string>();
  for (const reply of replies)
    if (typeof reply === "string") {
      const text = reply.trim();
      if (text !== "" && text.length <= REPLY_OFFER_MAX_LENGTH) kept.add(text);
    }
  return [...kept].slice(0, REPLY_OFFER_LIMIT);
};

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
    /** The agent message the actions follow; absent when none ends the Thread. */
    messageId: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
    /** In Clef's order; empty when Clef offers nothing or did not answer. */
    actions: Schema.Array(ThreadQuickActionSchema).check(
      Schema.isMaxLength(REPLY_OFFER_LIMIT + 1),
    ),
  }),
);

export type ThreadQuickActionsData =
  (typeof ThreadQuickActionsResponseSchema.Type)["data"];

export const ThreadQuickActionsErrorResponseSchema = Schema.Union([
  errorResponse(
    "QUICK_ACTIONS_DISABLED",
    "Composer quick actions are off. Turn them on in Settings, Experimental Features.",
  ),
  errorResponse(
    "QUICK_ACTIONS_MODEL_UNAVAILABLE",
    "Composer quick actions need Workers AI's Clef Flash, which this deployment does not provide.",
  ),
  errorResponse(
    "QUICK_ACTIONS_READ_ONLY",
    "People who can only view this Thread get no quick actions.",
  ),
]);
