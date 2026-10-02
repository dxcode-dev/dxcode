// Fenced code opener or closer: up to three spaces, then ``` or ~~~ (3+).
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// A bullet or ordered list item marker at the start of a line.
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/**
 * Splits streaming Markdown into blocks that later text cannot change, plus a
 * final unsettled tail. Joining the blocks with "\n" restores the input.
 *
 * A block settles at a blank line outside a code fence that is followed by an
 * unindented line that cannot continue the block: indented continuations,
 * fenced code, and the items of a loose list stay in one document. Earlier blocks are byte-identical as the text grows, which lets a
 * renderer memoize them and parse only the tail on each stream chunk.
 */
export const settledMarkdownBlocks = (text: string): string[] => {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: { readonly char: string; readonly length: number } | undefined;
  let inList = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    const match = FENCE.exec(line);
    if (fence === undefined) {
      const marker = match?.[1];
      if (
        marker !== undefined &&
        !(marker.startsWith("`") && match?.[2]?.includes("`"))
      )
        fence = { char: marker.charAt(0), length: marker.length };
    } else if (
      match?.[1] !== undefined &&
      match[1].charAt(0) === fence.char &&
      match[1].length >= fence.length &&
      match[2]?.trim() === ""
    ) {
      fence = undefined;
    }
    if (fence === undefined && LIST_ITEM.test(line)) inList = true;
    current.push(line);
    const next = lines[index + 1];
    if (
      fence === undefined &&
      line.trim() === "" &&
      next !== undefined &&
      // The last line may be partial ("1" before "1. "); judge it once complete.
      index + 2 < lines.length &&
      next.trim() !== "" &&
      !/^[ \t]/.test(next) &&
      !(inList && LIST_ITEM.test(next)) &&
      current.some((value) => value.trim() !== "")
    ) {
      blocks.push(current.join("\n"));
      current = [];
      inList = false;
    }
  }
  blocks.push(current.join("\n"));
  return blocks;
};
