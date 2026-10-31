import type { CSSProperties } from "react";
import type { ThreadListClientItem } from "../../shared/api/client.js";

/**
 * A child Thread's count of the Threads below it that list under it rather
 * than under the root; zero for a root.
 */
export const startedCountOf = (
  thread: Pick<ThreadListClientItem, "parentThreadId" | "startedCount">,
) => (thread.parentThreadId === undefined ? 0 : (thread.startedCount ?? 0));

/**
 * Row attributes that make room at the row's end for a count control showing
 * `text`, a root's children toggle or a child's count; none when empty.
 */
export const countControlAttributes = (text: string) =>
  text === ""
    ? {}
    : {
        "data-children": "",
        style: { "--thread-children-glyphs": text.length } as CSSProperties,
      };
