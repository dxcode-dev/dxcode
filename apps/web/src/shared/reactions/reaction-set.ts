import {
  REACTIONS as API_REACTIONS,
  type Reaction as ApiReaction,
  type ReactionCount as ApiReactionCount,
} from "@dx/api";

/** The five reactions on a Space's posts and a shared Thread's messages. */

export type Reaction = ApiReaction;
export type ReactionCount = ApiReactionCount;
export const REACTIONS = API_REACTIONS;

export const REACTION_EMOJI: Record<Reaction, string> = {
  thumbs_up: "👍",
  heart: "❤️",
  joy: "😂",
  eyes: "👀",
  wave: "👋",
};

export const REACTION_NAME: Record<Reaction, string> = {
  thumbs_up: "Thumbs Up",
  heart: "Heart",
  joy: "Joy",
  eyes: "Eyes",
  wave: "Wave",
};

/** The viewer's reaction toggled on a message's counts, as the server will. */
export const toggledReactions = (
  reactions: ReadonlyArray<ReactionCount>,
  reaction: Reaction,
  on: boolean,
): ReadonlyArray<ReactionCount> => {
  const existing = reactions.find((item) => item.reaction === reaction);
  if (existing === undefined)
    return on
      ? [...reactions, { reaction, count: 1, mine: true, agent: false }]
      : reactions;
  if (existing.mine === on) return reactions;
  return reactions.flatMap((item) => {
    if (item.reaction !== reaction) return [item];
    const count = item.count + (on ? 1 : -1);
    return count <= 0 ? [] : [{ ...item, count, mine: on }];
  });
};
