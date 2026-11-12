import { Schema } from "effect";

/**
 * The reactions people give a Space's posts and a shared Thread's messages,
 * and that a Space's agent gives posts.
 */
export const REACTIONS = ["thumbs_up", "heart", "joy", "eyes", "wave"] as const;
export const ReactionSchema = Schema.Literals(REACTIONS);
export type Reaction = typeof ReactionSchema.Type;

/** One reaction on a message, counted over everyone who gave it. */
export const ReactionCountSchema = Schema.Struct({
  reaction: ReactionSchema,
  count: Schema.Int,
  /** The requester gave it. */
  mine: Schema.Boolean,
  /** The agent gave it (in a Space: dx's `eyes` while it works on the post, or its own). */
  agent: Schema.Boolean,
});
export type ReactionCount = typeof ReactionCountSchema.Type;
