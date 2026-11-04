/**
 * Three-way merge of an artifact's Markdown, block by block: a person's
 * unsaved edits (`mine`) re-applied on top of a newer revision (`theirs`),
 * both made from `base`. Changes to different blocks merge. Where both sides
 * changed the same blocks, both versions are kept, theirs first, and their
 * top-level block indexes come back in `conflicts`, so a draft is never
 * dropped.
 */
import { blockParts, topLevelSources } from "./artifact-markdown.js";
import { itemAt } from "./item-at.js";

export interface ArtifactMerge {
  readonly markdown: string;
  /** Top-level block indexes, in `markdown`, of blocks both sides changed. */
  readonly conflicts: ReadonlyArray<number>;
}

interface Chunk {
  readonly source: string;
  readonly gap: string;
  /** The source of the block that followed it on its side; undefined for the last. */
  readonly next: string | undefined;
}

const chunksOf = (markdown: string) => {
  const { lead, blocks } = topLevelSources(markdown);
  const chunks: ReadonlyArray<Chunk> = blocks.map((block, index) => ({
    ...block,
    next: blocks[index + 1]?.source,
  }));
  return { lead, chunks };
};

const hasBlankLine = (gap: string) =>
  /(\r\n|\r|\n)[ \t]*(\r\n|\r|\n)/.test(gap);

/** Index pairs of a longest common subsequence of `a` and `b`, compared by source. */
const commonPairs = (
  a: ReadonlyArray<Chunk>,
  b: ReadonlyArray<Chunk>,
): Array<readonly [number, number]> => {
  const n = a.length;
  const m = b.length;
  const lengths = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1)
    for (let j = m - 1; j >= 0; j -= 1)
      itemAt(lengths, i)[j] =
        itemAt(a, i).source === itemAt(b, j).source
          ? itemAt(itemAt(lengths, i + 1), j + 1) + 1
          : Math.max(
              itemAt(itemAt(lengths, i + 1), j),
              itemAt(itemAt(lengths, i), j + 1),
            );
  const pairs: Array<readonly [number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (itemAt(a, i).source === itemAt(b, j).source) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (
      itemAt(itemAt(lengths, i + 1), j) >= itemAt(itemAt(lengths, i), j + 1)
    )
      i += 1;
    else j += 1;
  }
  return pairs;
};

const sameChunks = (a: ReadonlyArray<Chunk>, b: ReadonlyArray<Chunk>) =>
  a.length === b.length &&
  a.every((chunk, i) => chunk.source === itemAt(b, i).source);

type Merged = Array<{ chunk: Chunk; conflict: boolean }>;

const withNext = (
  parts: ReadonlyArray<{ readonly source: string; readonly gap: string }>,
): ReadonlyArray<Chunk> =>
  parts.map((part, index) => ({ ...part, next: parts[index + 1]?.source }));

/**
 * Both sides changed one block in place: merge a list item by item, or a
 * table row by row, so changes to different items do not conflict. A
 * conflicting item keeps both versions inside the one list.
 */
const mergeBlock = (
  original: Chunk,
  mineBlock: Chunk,
  theirsBlock: Chunk,
  prefer: Prefer,
): { readonly chunk: Chunk; readonly conflict: boolean } | undefined => {
  const o = blockParts(original.source);
  const a = blockParts(mineBlock.source);
  const b = blockParts(theirsBlock.source);
  if (
    o === undefined ||
    a === undefined ||
    b === undefined ||
    o.kind !== a.kind ||
    o.kind !== b.kind
  )
    return undefined;
  const parts = mergeSequences(
    withNext(o.parts),
    withNext(a.parts),
    withNext(b.parts),
    prefer,
    false,
  );
  const separator = o.parts[0]?.gap || "\n";
  const source = parts
    .map(({ chunk }, index) =>
      index === parts.length - 1
        ? chunk.source
        : chunk.source + (chunk.gap === "" ? separator : chunk.gap),
    )
    .join("");
  return {
    chunk: { source, gap: theirsBlock.gap, next: theirsBlock.next },
    conflict: parts.some(({ conflict }) => conflict),
  };
};

type Prefer = "both" | "mine";

/** Three-way merge of block sequences; see the module comment. */
const mergeSequences = (
  o: ReadonlyArray<Chunk>,
  a: ReadonlyArray<Chunk>,
  b: ReadonlyArray<Chunk>,
  prefer: Prefer,
  /** Whether a block both sides changed may merge part by part (top level only). */
  byPart: boolean,
): Merged => {
  const toMine = new Map(commonPairs(o, a));
  const toTheirs = new Map(commonPairs(o, b));
  const out: Merged = [];
  const take = (chunks: ReadonlyArray<Chunk>, conflict: boolean) => {
    for (const chunk of chunks) out.push({ chunk, conflict });
  };
  const both = (
    theirsChunks: ReadonlyArray<Chunk>,
    mineChunks: ReadonlyArray<Chunk>,
  ) => {
    if (prefer === "mine") take(mineChunks, false);
    else {
      take(theirsChunks, true);
      take(mineChunks, true);
    }
  };
  let oi = 0;
  let ai = 0;
  let bi = 0;
  const settle = (oEnd: number, aEnd: number, bEnd: number) => {
    const oRegion = o.slice(oi, oEnd);
    const aRegion = a.slice(ai, aEnd);
    const bRegion = b.slice(bi, bEnd);
    if (sameChunks(aRegion, oRegion)) take(bRegion, false);
    else if (sameChunks(bRegion, oRegion)) take(aRegion, false);
    else if (sameChunks(aRegion, bRegion)) take(aRegion, false);
    else if (
      aRegion.length === oRegion.length &&
      bRegion.length === oRegion.length
    ) {
      // Each side edited blocks in place: merge block by block, so edits to
      // neighbouring blocks never conflict.
      oRegion.forEach((original, index) => {
        const mineBlock = itemAt(aRegion, index);
        const theirsBlock = itemAt(bRegion, index);
        if (mineBlock.source === original.source) take([theirsBlock], false);
        else if (
          theirsBlock.source === original.source ||
          theirsBlock.source === mineBlock.source
        )
          take([mineBlock], false);
        else {
          const merged = byPart
            ? mergeBlock(original, mineBlock, theirsBlock, prefer)
            : undefined;
          if (merged === undefined) both([theirsBlock], [mineBlock]);
          else out.push(merged);
        }
      });
    } else both(bRegion, aRegion);
  };
  // Walk base blocks both sides kept unchanged; settle each region between.
  for (let index = 0; index < o.length; index += 1) {
    const inMine = toMine.get(index);
    const inTheirs = toTheirs.get(index);
    if (inMine === undefined || inTheirs === undefined) continue;
    if (inMine < ai || inTheirs < bi) continue;
    settle(index, inMine, inTheirs);
    take([itemAt(o, index)], false);
    oi = index + 1;
    ai = inMine + 1;
    bi = inTheirs + 1;
  }
  settle(o.length, a.length, b.length);
  return out;
};

export const mergeArtifactMarkdown = ({
  base,
  mine,
  theirs,
  prefer = "both",
}: {
  readonly base: string;
  readonly mine: string;
  readonly theirs: string;
  /** `mine` takes this side's version where both changed a block. */
  readonly prefer?: Prefer;
}): ArtifactMerge => {
  if (mine === base || mine === theirs)
    return { markdown: theirs, conflicts: [] };
  if (theirs === base) return { markdown: mine, conflicts: [] };
  const o = chunksOf(base);
  const a = chunksOf(mine);
  const b = chunksOf(theirs);
  const out = mergeSequences(o.chunks, a.chunks, b.chunks, prefer, true);

  const lead = a.lead !== o.lead ? a.lead : b.lead;
  const eol = /\r\n|\r|\n/.exec(theirs)?.[0] ?? "\n";
  let markdown = lead;
  out.forEach(({ chunk }, index) => {
    markdown += chunk.source;
    const following = out[index + 1]?.chunk;
    if (following === undefined) {
      markdown +=
        chunk.next === undefined ? chunk.gap : (b.chunks.at(-1)?.gap ?? eol);
      return;
    }
    // Blocks that followed each other keep the lines between them; others
    // get a blank line, so they stay apart.
    if (chunk.next === following.source || hasBlankLine(chunk.gap))
      markdown += chunk.gap;
    else markdown += chunk.gap === "" ? eol + eol : chunk.gap + eol;
  });
  return {
    markdown,
    conflicts: flaggedBlocks(markdown, out),
  };
};

/**
 * The top-level blocks of the merged Markdown that hold a conflicting
 * chunk. Counted on the parsed result, so two versions that Markdown reads
 * as one block (two lists in a row) flag that one block.
 */
const flaggedBlocks = (markdown: string, out: Merged): number[] => {
  if (!out.some(({ conflict }) => conflict)) return [];
  const blocks = topLevelSources(markdown).blocks;
  const flagged = new Set<number>();
  let cursor = 0;
  out.forEach(({ chunk, conflict }) => {
    const index = blocks.findIndex(
      (block, at) => at >= cursor && block.source.includes(chunk.source),
    );
    if (index === -1) return;
    if (conflict) flagged.add(index);
    cursor = blocks[index]?.source === chunk.source ? index + 1 : index;
  });
  return [...flagged].sort((x, y) => x - y);
};
