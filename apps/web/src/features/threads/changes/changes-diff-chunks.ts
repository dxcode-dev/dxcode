import { type FileDiffMetadata, parsePatchFiles } from "@pierre/diffs";

/**
 * Rows per highlighted chunk of a long file. The highlighter colors a whole
 * diff at once, and its result for 5,000 lines takes a 4x-throttled phone
 * about half a second to receive. A longer file shows as consecutive chunks
 * of whole lines; each mounts, and is colored, only near the viewport.
 */
const CHUNK_ROWS = 1000;

export interface ChunkPosition {
  readonly first: boolean;
  readonly last: boolean;
}

/** The chunks of long files, with where each sits in its file. */
export const chunkPositions = new WeakMap<FileDiffMetadata, ChunkPosition>();

/**
 * Parses one file's patch, as chunks of at most `CHUNK_ROWS` rows when it is
 * longer. A chunk's first hunk counts only the unchanged lines since the
 * previous chunk, so a hunk split across chunks shows no separator.
 */
export const parsePatchInChunks = (
  patch: string,
  cacheKeyPrefix: string,
): FileDiffMetadata[] => {
  const chunks = splitPatch(patch);
  if (chunks === undefined)
    return parsePatchFiles(patch, cacheKeyPrefix, true).flatMap(
      (parsed) => parsed.files,
    );
  const files = chunks.map((chunk, index) => {
    const [file] = parsePatchFiles(
      chunk,
      `${cacheKeyPrefix}-${index}`,
      true,
    ).flatMap((parsed) => parsed.files);
    if (file === undefined) throw new Error("A patch chunk has no file.");
    return file;
  });
  for (const [index, file] of files.entries()) {
    chunkPositions.set(file, {
      first: index === 0,
      last: index === files.length - 1,
    });
    const previous = files[index - 1]?.hunks.at(-1);
    const first = file.hunks[0];
    if (previous === undefined || first === undefined) continue;
    const gap = Math.max(
      startBoundary(first.additionStart, first.additionCount) -
        startBoundary(previous.additionStart, previous.additionCount) -
        previous.additionCount,
      0,
    );
    const delta = gap - first.collapsedBefore;
    first.collapsedBefore = gap;
    for (const hunk of file.hunks) {
      hunk.splitLineStart += delta;
      hunk.unifiedLineStart += delta;
    }
    file.splitLineCount += delta;
    file.unifiedLineCount += delta;
  }
  return files;
};

// As the library counts a hunk's side: the line before it, or its start when empty.
const startBoundary = (start: number, count: number) =>
  start - (count === 0 ? 0 : 1);

interface PatchHunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly section: string;
  readonly body: ReadonlyArray<string>;
}

/**
 * A single-file patch as chunk patches of at most `CHUNK_ROWS` rows, each with
 * the file's headers and whole, recounted hunks; undefined when the patch is
 * short or is not one well-formed file. A chunk ends after a blank line near
 * its limit when it can, where a highlighter's state is least likely to be
 * mid-construct.
 */
const splitPatch = (patch: string): string[] | undefined => {
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ -"));
  if (firstHunk === -1 || lines.length - firstHunk <= CHUNK_ROWS * 1.25)
    return undefined;
  const headers = lines.slice(0, firstHunk);
  const hunks: PatchHunk[] = [];
  let index = firstHunk;
  while (index < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(
      lines[index] ?? "",
    );
    if (header === null) return undefined;
    let oldLeft = Number(header[2] ?? 1);
    let newLeft = Number(header[4] ?? 1);
    const body: string[] = [];
    index += 1;
    while (index < lines.length && (oldLeft > 0 || newLeft > 0)) {
      const line = lines[index] ?? "";
      const kind = line[0];
      if (kind === " ") {
        oldLeft -= 1;
        newLeft -= 1;
      } else if (kind === "-") oldLeft -= 1;
      else if (kind === "+") newLeft -= 1;
      else if (kind !== "\\") return undefined;
      body.push(line);
      index += 1;
    }
    while (lines[index]?.startsWith("\\")) {
      body.push(lines[index] ?? "");
      index += 1;
    }
    if (oldLeft !== 0 || newLeft !== 0) return undefined;
    hunks.push({
      oldStart: Number(header[1]),
      newStart: Number(header[3]),
      section: header[5] ?? "",
      body,
    });
  }
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkRows = 0;
  const closeChunk = () => {
    if (chunk.length > 0) chunks.push([...headers, ...chunk]);
    chunk = [];
    chunkRows = 0;
  };
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    let piece: string[] = [];
    let pieceOld = oldLine;
    let pieceNew = newLine;
    let pieceCounts = [0, 0];
    const closePiece = () => {
      if (piece.length === 0) return;
      chunk.push(
        `@@ -${pieceOld},${pieceCounts[0]} +${pieceNew},${pieceCounts[1]} @@${hunk.section}`,
        ...piece,
      );
      piece = [];
      pieceCounts = [0, 0];
      pieceOld = oldLine;
      pieceNew = newLine;
    };
    for (const line of hunk.body) {
      if (!line.startsWith("\\")) {
        const rows = chunkRows + piece.length;
        const blankBefore = /^.\s*$/.test(piece.at(-1) ?? "x");
        if (
          rows >= CHUNK_ROWS ||
          (rows >= CHUNK_ROWS * 0.8 && piece.length > 0 && blankBefore)
        ) {
          chunkRows += piece.filter((row) => !row.startsWith("\\")).length;
          closePiece();
          closeChunk();
        }
        if (line[0] !== "+") oldLine += 1;
        if (line[0] !== "-") newLine += 1;
        if (line[0] !== "+") pieceCounts[0] = (pieceCounts[0] ?? 0) + 1;
        if (line[0] !== "-") pieceCounts[1] = (pieceCounts[1] ?? 0) + 1;
      }
      piece.push(line);
    }
    chunkRows += piece.filter((row) => !row.startsWith("\\")).length;
    closePiece();
  }
  closeChunk();
  return chunks.length > 1
    ? chunks.map((lines) => `${lines.join("\n")}\n`)
    : undefined;
};

/**
 * The patch to parse. dxd cuts a patch over its capture limit on a hunk line
 * and recounts the last hunk; a capture from an older dxd may end mid-line or
 * mid-hunk, so the same cut is made here, or the file would not parse at all.
 */
export const shownPatch = (
  patch: string,
  file: { readonly truncated: boolean },
) => {
  if (!file.truncated || patch === "") return patch;
  const lines = patch.split("\n");
  // The text after the last newline is a partial line (or empty).
  lines.pop();
  const header = lines.findLastIndex((line) => line.startsWith("@@ -"));
  if (header === -1) return patch;
  let deletions = 0;
  let additions = 0;
  for (const line of lines.slice(header + 1)) {
    if (line.startsWith(" ")) {
      deletions += 1;
      additions += 1;
    } else if (line.startsWith("-")) deletions += 1;
    else if (line.startsWith("+")) additions += 1;
  }
  const counted = lines[header]?.replace(
    /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/,
    `@@ -$1,${deletions} +$2,${additions} @@`,
  );
  const kept =
    deletions + additions === 0
      ? lines.slice(0, header)
      : [...lines.slice(0, header), counted ?? "", ...lines.slice(header + 1)];
  return kept.some((line) => line.startsWith("@@ -"))
    ? `${kept.join("\n")}\n`
    : patch;
};
