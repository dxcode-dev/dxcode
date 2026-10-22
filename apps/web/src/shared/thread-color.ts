import type { ThreadData } from "@dx/api";
import { THREAD_COLORS, type ThreadColor } from "@dx/domain";
import type { CSSProperties } from "react";

export { THREAD_COLORS, type ThreadColor };

export const THREAD_COLOR_LABELS: Readonly<Record<ThreadColor, string>> = {
  gray: "Gray",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  cyan: "Cyan",
};

/** The hue a Thread's orb gets until its owner picks a color, stable per Thread. */
export const autoThreadHue = (threadId: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < threadId.length; index += 1) {
    hash ^= threadId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
};

/**
 * Attributes that color a Thread's orb, and its title too once the owner
 * picked a color. Auto colors leave the title alone. A child Thread on
 * auto takes its parent's color, chosen or auto, on the orb only.
 */
export const threadColorAttributes = (
  thread: Pick<ThreadData, "id" | "color" | "parentThreadId" | "parentColor">,
) => {
  const named = thread.color ?? thread.parentColor;
  return {
    "data-thread-color": named ?? "auto",
    "data-thread-color-chosen": thread.color === undefined ? undefined : "",
    style:
      named === undefined
        ? ({
            "--thread-hue": autoThreadHue(thread.parentThreadId ?? thread.id),
          } as CSSProperties)
        : undefined,
  };
};
