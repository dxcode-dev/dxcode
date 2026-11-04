/**
 * Between editor selections and comment anchors. The API places a comment on
 * `quote`, text found in the current Markdown (the occurrence nearest `near`),
 * and reports its `anchor` as UTF-16 offsets in that Markdown. The editor
 * finds the same occurrence of the quote in its own text, so an anchor still
 * shows in the right place while the editor holds edits not saved yet.
 */
import { ARTIFACT_COMMENT_QUOTE_MAX_LENGTH } from "@dx/api";
import type { Node } from "prosemirror-model";
import type { ArtifactMarkdownCodec } from "./artifact-markdown.js";

/** Where a document position falls in its Markdown, written by `codec`. */
export const markdownOffset = (
  codec: ArtifactMarkdownCodec,
  doc: Node,
  pos: number,
) => codec.serialize(doc.cut(0, pos)).replace(/(?:\r\n|\r|\n)$/, "").length;

/** Where a document position falls in the Markdown. */
type OffsetOf = (pos: number) => number;

/** Of `candidates`, the one whose Markdown offset is nearest `target`. */
const nearestTo = <T>(
  candidates: ReadonlyArray<T>,
  offset: (candidate: T) => number,
  target: number,
): T | undefined => {
  let best: T | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates.slice(0, 50)) {
    const gap = Math.abs(offset(candidate) - target);
    if (gap < distance) {
      distance = gap;
      best = candidate;
    }
  }
  return best;
};

/** The document's text, block by block, and where each character sits. */
interface FlatText {
  readonly text: string;
  /** The document position of each character; -1 between blocks. */
  readonly at: ReadonlyArray<number>;
  /** Which inline node each character comes from; -1 between blocks. */
  readonly piece: ReadonlyArray<number>;
}

/** Chips read as their Markdown source, as they appear in the quote. */
const flatten = (doc: Node): FlatText => {
  let text = "";
  const at: number[] = [];
  const piece: number[] = [];
  let pieces = 0;
  let first = true;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (!first) {
      text += "\n";
      at.push(-1);
      piece.push(-1);
    }
    first = false;
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      pieces += 1;
      if (child.isText) {
        const value = child.text ?? "";
        text += value;
        for (let i = 0; i < value.length; i += 1) {
          at.push(start + i);
          piece.push(pieces);
        }
      } else if (child.type.name === "chip") {
        const source = String(child.attrs.source);
        text += source;
        for (let i = 0; i < source.length; i += 1) {
          at.push(start);
          piece.push(pieces);
        }
      } else {
        text += "\n";
        at.push(-1);
        piece.push(-1);
      }
    });
    return false;
  });
  return { text, at, piece };
};

const occurrences = (text: string, quote: string): number[] => {
  const found: number[] = [];
  let index = text.indexOf(quote);
  while (index !== -1) {
    found.push(index);
    index = text.indexOf(quote, index + 1);
  }
  return found;
};

const usable = (quote: string) => quote.trim() !== "";

/**
 * The quote and `near` for a new comment on the selection `from`–`to`: the
 * selected text when the Markdown holds it, else the longest run of whole
 * pieces (text runs and chips) it does hold. Kept to the block the
 * selection starts in, and to the quote limit. Undefined when nothing
 * selected can be found in the Markdown.
 */
export const quoteForSelection = (
  doc: Node,
  from: number,
  to: number,
  markdown: string,
  offsetOf: OffsetOf,
): { readonly quote: string; readonly near: number } | undefined => {
  if (from >= to) return undefined;
  const $from = doc.resolve(from);
  const end = Math.min(to, $from.parent.isTextblock ? $from.end() : to);
  const flat = flatten(doc);
  let first = -1;
  let last = -1;
  flat.at.forEach((position, index) => {
    if (position === -1 || position < from || position >= end) return;
    if (first === -1) first = index;
    last = index;
  });
  if (first === -1) return undefined;
  const limit = ARTIFACT_COMMENT_QUOTE_MAX_LENGTH;
  // Candidate windows, longest first: the whole selection, then runs of
  // whole pieces inside it.
  const bounds: number[] = [first];
  for (let index = first + 1; index <= last; index += 1)
    if (flat.piece[index] !== flat.piece[index - 1]) bounds.push(index);
  bounds.push(last + 1);
  const windows: Array<readonly [number, number]> = [[first, last + 1]];
  for (let i = 0; i < bounds.length - 1; i += 1)
    for (let j = i + 1; j < bounds.length; j += 1) {
      const window = [bounds[i] ?? 0, bounds[j] ?? 0] as const;
      if (window[0] !== first || window[1] !== last + 1) windows.push(window);
    }
  windows.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
  for (const [start, stop] of windows) {
    const quote = flat.text.slice(start, Math.min(stop, start + limit));
    if (!usable(quote) || !markdown.includes(quote)) continue;
    // Measured in the Markdown itself, which holds text the reader does not
    // see (a link's address), so the server picks the selected occurrence.
    return { quote, near: offsetOf(flat.at[start] ?? from) };
  }
  return undefined;
};

/**
 * Where a comment's anchor shows in the editor: the occurrence of its quote
 * that matches the anchored one in the Markdown. Undefined when the editor no
 * longer holds the text.
 */
export const anchorRange = (
  doc: Node,
  markdown: string,
  anchor: {
    readonly quote: string;
    readonly start: number;
    readonly end: number;
  },
  offsetOf: OffsetOf,
): { readonly from: number; readonly to: number } | undefined => {
  if (!usable(anchor.quote) || !markdown.includes(anchor.quote))
    return undefined;
  const flat = flatten(doc);
  const inDoc = occurrences(flat.text, anchor.quote).filter((index) =>
    flat.at
      .slice(index, index + anchor.quote.length)
      .every((position) => position !== -1),
  );
  // The occurrence whose place in the Markdown is nearest the anchor's.
  const start = nearestTo(
    inDoc,
    (index) => offsetOf(flat.at[index] ?? 0),
    anchor.start,
  );
  if (start === undefined) return undefined;
  const from = flat.at[start];
  const lastAt = flat.at[start + anchor.quote.length - 1];
  if (from === undefined || lastAt === undefined) return undefined;
  return { from, to: lastAt + 1 };
};
