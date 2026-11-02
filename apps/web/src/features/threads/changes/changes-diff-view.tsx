import { type FileDiffMetadata, Virtualizer } from "@pierre/diffs";
import {
  FileDiff,
  type FileDiffOptions,
  VirtualizerContext,
} from "@pierre/diffs/react";
import type * as React from "react";
import { useState, useSyncExternalStore } from "react";
import { type ChunkPosition, chunkPositions } from "./changes-diff-chunks.js";

/**
 * Rows a diff may render in full. Past this, only the rows near the viewport
 * are in the DOM (about 14 elements per highlighted row), so a 5,000-line file
 * costs what a 200-line one does. Smaller diffs stay whole, so the browser's
 * find-in-page still reaches every line of them.
 */
const FULL_DIFF_ROW_LIMIT = 200;

/**
 * Row geometry of `.changes-pierre-diff` (changes.css): the virtualizer places
 * unrendered rows by these numbers, so they must match the stylesheet.
 */
const diffMetrics = {
  hunkLineCount: 50,
  lineHeight: 18,
  diffHeaderHeight: 0,
  spacing: 8,
};

/**
 * The Changes scroll container. Large diffs inside it render only the rows
 * near its viewport, through one virtualizer that watches this element's
 * scroll and its content's size.
 */
export function ChangesDiffScroller({
  children,
  empty,
}: {
  readonly children: React.ReactNode;
  readonly empty: boolean;
}) {
  const [{ virtualizer, attach }] = useState(createScrollVirtualizer);
  return (
    <VirtualizerContext.Provider value={virtualizer}>
      <div
        ref={attach}
        className="changes-scroll"
        data-empty={empty || undefined}
        aria-live="polite"
      >
        <div className="changes-scroll-content">{children}</div>
      </div>
    </VirtualizerContext.Provider>
  );
}

const createScrollVirtualizer = () => {
  const virtualizer = new Virtualizer();
  const attach = (node: HTMLDivElement | null) => {
    if (node === null) return;
    const content = node.firstElementChild;
    virtualizer.setup(node, content ?? undefined);
    return () => virtualizer.cleanUp();
  };
  return { virtualizer, attach };
};

/**
 * Every file of one parsed patch. Files past the row limit are virtualized,
 * and the chunks of a long file mount only as they near the viewport.
 */
export function ChangesFileDiffs({
  files,
  options,
}: {
  readonly files: ReadonlyArray<FileDiffMetadata>;
  readonly options: FileDiffOptions<undefined, undefined>;
}) {
  return (
    <>
      {files.map((fileDiff) => {
        // Chunks of one file share its name, not its cache key.
        const key = fileDiff.cacheKey ?? fileDiff.name;
        const chunk = chunkPositions.get(fileDiff);
        if (chunk !== undefined)
          return (
            <ChangesDiffChunk
              key={key}
              fileDiff={fileDiff}
              options={options}
              chunk={chunk}
            />
          );
        return rowCount(fileDiff, options) > FULL_DIFF_ROW_LIMIT ? (
          <FileDiff
            key={key}
            fileDiff={fileDiff}
            className="changes-pierre-diff"
            options={options}
            metrics={diffMetrics}
          />
        ) : (
          // Outside the virtualizer, the library renders every row.
          <VirtualizerContext.Provider key={key} value={undefined}>
            <FileDiff
              fileDiff={fileDiff}
              className="changes-pierre-diff"
              options={options}
            />
          </VirtualizerContext.Provider>
        );
      })}
    </>
  );
}

/** Rows the diff shows: changed and context lines, not collapsed ones. */
const rowCount = (
  fileDiff: FileDiffMetadata,
  options: FileDiffOptions<undefined, undefined>,
) =>
  fileDiff.hunks.reduce(
    (rows, hunk) =>
      rows +
      (options.diffStyle === "split"
        ? hunk.splitLineCount
        : hunk.unifiedLineCount),
    0,
  );

/** How far outside the scroll viewport a chunk mounts. */
const CHUNK_MOUNT_MARGIN = "1500px 0px";

function ChangesDiffChunk({
  fileDiff,
  options,
  chunk,
}: {
  readonly fileDiff: FileDiffMetadata;
  readonly options: FileDiffOptions<undefined, undefined>;
  readonly chunk: ChunkPosition;
}) {
  const [{ observe, subscribe, getSnapshot }] = useState(
    createNearViewportLatch,
  );
  const near = useSyncExternalStore(subscribe, getSnapshot);
  const metrics = {
    ...diffMetrics,
    paddingTop: chunk.first ? diffMetrics.spacing : 0,
    paddingBottom: chunk.last ? diffMetrics.spacing : 0,
  };
  return (
    <div
      ref={observe}
      className="changes-diff-chunk"
      // Holds the chunk's place while its diff mounts empty and the
      // virtualizer lays it out in the next frame; without it the chunks
      // below would slide into view and mount too.
      style={{ minHeight: estimatedHeight(fileDiff, options, metrics) }}
    >
      {near ? (
        <FileDiff
          fileDiff={fileDiff}
          className="changes-pierre-diff"
          options={{ ...options, unsafeCSS: chunkCSS(chunk) }}
          metrics={metrics}
        />
      ) : null}
    </div>
  );
}

/** Seams between chunks: no padding where the file continues. */
const chunkCSS = ({ first, last }: ChunkPosition) =>
  `${first ? "" : "[data-code] { padding-top: 0; }"}${last ? "" : "[data-code] { padding-bottom: 0; }"}`;

/** The chunk's height as the virtualizer lays it out, before rows are measured. */
const estimatedHeight = (
  fileDiff: FileDiffMetadata,
  options: FileDiffOptions<undefined, undefined>,
  metrics: typeof diffMetrics & {
    readonly paddingTop: number;
    readonly paddingBottom: number;
  },
) =>
  metrics.paddingTop +
  metrics.paddingBottom +
  rowCount(fileDiff, options) * metrics.lineHeight +
  fileDiff.hunks.filter((hunk) => hunk.collapsedBefore > 0).length *
    SEPARATOR_HEIGHT;

/** A `line-info-basic` hunk separator's height, as the library draws it. */
const SEPARATOR_HEIGHT = 32;

/**
 * Turns true, once, when the observed element comes within
 * `CHUNK_MOUNT_MARGIN` of the Changes scroll viewport.
 */
const createNearViewportLatch = () => {
  let near = false;
  const listeners = new Set<() => void>();
  const observe = (node: HTMLElement | null) => {
    if (node === null || near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        near = true;
        observer.disconnect();
        for (const listener of listeners) listener();
      },
      { root: node.closest(".changes-scroll"), rootMargin: CHUNK_MOUNT_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  };
  return {
    observe,
    getSnapshot: () => near,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
