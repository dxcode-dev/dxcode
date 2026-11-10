import type { SpacePost, SpacePostReaction } from "@dx/api";
import { epochOf } from "../space-format.js";

export const REACTION_EMOJI: Record<SpacePostReaction, string> = {
  thumbs_up: "👍",
  heart: "❤️",
  joy: "😂",
  eyes: "👀",
  wave: "👋",
};

export const REACTION_NAME: Record<SpacePostReaction, string> = {
  thumbs_up: "Thumbs Up",
  heart: "Heart",
  joy: "Joy",
  eyes: "Eyes",
  wave: "Wave",
};

/** Epoch milliseconds of a post's timestamp. */
export const postTime = epochOf;

/**
 * Why a post or an edit did not save, in plain words, by the server's code.
 * Anything else may pass on a retry.
 */
export const postFailureText = (error: unknown, action: "post" | "edit") => {
  const code =
    error instanceof Error && "code" in error ? error.code : undefined;
  switch (code) {
    case "SPACE_ARCHIVED":
      return `This Space is archived. Unarchive it to ${action}.`;
    case "SPACE_READ_ONLY":
      return "You can read this Space, but not post in it.";
    case "SPACE_AGENT_UNAVAILABLE":
      return `dx couldn't take your ${action} just now. Try again in a moment.`;
    case "POST_NOT_YOURS":
      return "Only its author can edit this post.";
    default:
      return action === "post"
        ? "Couldn't post. Try again."
        : "Couldn't save the edit. Try again.";
  }
};

/** How far the server's clock may stand from the browser's. */
const CLOCK_SKEW_MS = 60_000;

/**
 * The sending bubbles still to show: dx may announce a post, and a read
 * bring it back, before the post's own answer returns. A bubble whose post
 * is already in the chat (the viewer's, same text, made since it was sent)
 * gives way to it, so the post never shows twice.
 */
export const stillSending = <
  Pending extends { readonly posted: string; readonly submittedAt: number },
>(
  pending: ReadonlyArray<Pending>,
  posts: ReadonlyArray<SpacePost>,
  viewerId: string,
): ReadonlyArray<Pending> => {
  const claimed = new Set<string>();
  return pending.filter((sending) => {
    const landed = posts.find(
      (post) =>
        !claimed.has(post.id) &&
        post.author.kind === "user" &&
        post.author.userId === viewerId &&
        post.text === sending.posted &&
        postTime(post.createdAt) >= sending.submittedAt - CLOCK_SKEW_MS,
    );
    if (landed === undefined) return true;
    claimed.add(landed.id);
    return false;
  });
};
