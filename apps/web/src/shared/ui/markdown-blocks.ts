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
 * fenced code, and the items of a loose list stay in one document. Outside a
 * list, a fence starts its own block, and a closed fence settles at the blank
 * line after it. Earlier blocks are byte-identical as the text grows, which
 * lets a renderer memoize them and parse only the tail on each stream chunk.
 */
export const settledMarkdownBlocks = (text: string): string[] => {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: { readonly char: string; readonly length: number } | undefined;
  let inList = false;
  // The current block is one fenced code block, now closed.
  let closedFence = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    const match = FENCE.exec(line);
    if (fence === undefined) {
      const marker = match?.[1];
      if (
        marker !== undefined &&
        !(marker.startsWith("`") && match?.[2]?.includes("`"))
      ) {
        fence = { char: marker.charAt(0), length: marker.length };
        // A fence interrupts a paragraph. Judge the opener once complete:
        // "```ts`" is inline code, not a fence.
        // An HTML block or display math swallows the fence; leave those whole.
        if (
          !inList &&
          index + 1 < lines.length &&
          current.some((value) => value.trim() !== "") &&
          !current.some((value) => /^ {0,3}(?:<|\$\$|\\\[)/.test(value))
        ) {
          blocks.push(current.join("\n"));
          current = [];
          closedFence = false;
        }
      }
    } else if (
      match?.[1] !== undefined &&
      match[1].charAt(0) === fence.char &&
      match[1].length >= fence.length &&
      match[2]?.trim() === ""
    ) {
      fence = undefined;
      closedFence =
        !inList &&
        FENCE.test(current.find((value) => value.trim() !== "") ?? "");
    }
    if (fence === undefined && LIST_ITEM.test(line)) inList = true;
    current.push(line);
    const next = lines[index + 1];
    if (
      fence === undefined &&
      line.trim() === "" &&
      next !== undefined &&
      (closedFence ||
        // The last line may be partial ("1" before "1. "); judge it once complete.
        (index + 2 < lines.length &&
          next.trim() !== "" &&
          !/^[ \t]/.test(next) &&
          !(inList && LIST_ITEM.test(next)))) &&
      current.some((value) => value.trim() !== "")
    ) {
      blocks.push(current.join("\n"));
      current = [];
      inList = false;
      closedFence = false;
    } else if (line.trim() !== "" && fence === undefined && !FENCE.test(line))
      closedFence = false;
  }
  blocks.push(current.join("\n"));
  return blocks;
};

export interface CodeFenceBlock {
  /** The first word of the info string, as remark reads it. */
  readonly language: string | undefined;
  /** The code as remark reads it. */
  readonly code: string;
  readonly closed: boolean;
}

// An opener at the first column, after any blank lines, whose line is complete.
const OPENER = /^(?:[ \t]*\n)*(`{3,}|~{3,})([^\n]*)\n/;

/**
 * Reads a block that is one fenced code block, open or followed only by blank
 * lines. Returns undefined for anything a plain reading could get wrong:
 * an indented fence, escapes or entities in the info string, or carriage
 * returns and NUL characters, which remark rewrites.
 */
export const codeFenceBlock = (block: string): CodeFenceBlock | undefined => {
  const match = OPENER.exec(block);
  if (match === null) return undefined;
  const [opener, marker = "", info = ""] = match;
  if ((marker.startsWith("`") && info.includes("`")) || /[\\&\r]/.test(info))
    return undefined;
  const body = block.slice(opener.length);
  if (/[\r\0]/.test(body)) return undefined;
  const language = info.trim().split(/\s/)[0] || undefined;
  const closer = new RegExp(
    `^ {0,3}${marker.charAt(0)}{${marker.length},}[ \\t]*$`,
    "m",
  ).exec(body);
  if (closer === null)
    return { language, code: body.replace(/\n$/, ""), closed: false };
  if (body.slice(closer.index + closer[0].length).trim() !== "")
    return undefined;
  return {
    language,
    code: body.slice(0, Math.max(closer.index - 1, 0)),
    closed: true,
  };
};
