import type { ThreadData } from "@dx/api";
import { THREAD_COLORS, type ThreadColor } from "@dx/domain";

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

const AUTO_COLORS = THREAD_COLORS.filter((color) => color !== "gray");

/** The color a Thread gets until its owner picks one, stable per Thread. */
export const autoThreadColor = (threadId: string): ThreadColor => {
  let hash = 2166136261;
  for (let index = 0; index < threadId.length; index += 1) {
    hash ^= threadId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return AUTO_COLORS[(hash >>> 0) % AUTO_COLORS.length] ?? "blue";
};

/**
 * Attributes that color a Thread's orb, and its title too once the owner
 * picked a color. Auto colors leave the title alone. A child Thread on
 * auto takes its parent's color, chosen or auto, on the orb only.
 */
export const threadColorAttributes = (
  thread: Pick<ThreadData, "id" | "color" | "parentThreadId" | "parentColor">,
) => ({
  "data-thread-color":
    thread.color ??
    thread.parentColor ??
    autoThreadColor(thread.parentThreadId ?? thread.id),
  "data-thread-color-chosen": thread.color === undefined ? undefined : "",
});
