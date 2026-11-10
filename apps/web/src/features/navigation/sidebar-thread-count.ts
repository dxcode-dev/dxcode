import type { CSSProperties } from "react";

/**
 * Row attributes that make room at the row's end for a root's children
 * toggle showing `text`; none when empty.
 */
export const countControlAttributes = (text: string) =>
  text === ""
    ? {}
    : {
        "data-children": "",
        style: { "--thread-children-glyphs": text.length } as CSSProperties,
      };
