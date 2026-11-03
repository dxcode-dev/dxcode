import * as React from "react";
import type * as CodeHighlight from "./code-highlight.js";

/** Highlighted code: text, or a span with highlight.js classes. */
export type HighlightNode =
  | string
  | {
      readonly className: string;
      readonly children: ReadonlyArray<HighlightNode>;
    };

/** Lines highlighted once; React skips them while later lines stream. */
export interface HighlightedLines {
  readonly nodes: ReadonlyArray<HighlightNode>;
  /** The code offset where these lines start. */
  readonly start: number;
  /** Characters of code these lines hold. */
  readonly length: number;
}

export interface StreamingCodeHighlight {
  readonly language: string | undefined;
  readonly source: string;
  /** Highlighted as one pass over the whole code, as rehype-highlight does. */
  readonly exact: boolean;
  readonly settled: ReadonlyArray<HighlightedLines>;
  /** Characters of `source` that `settled` covers. */
  readonly settledLength: number;
  readonly tail: ReadonlyArray<HighlightNode>;
}

/**
 * The language a code block's classes name, read as rehype-highlight reads
 * them: false when the block turns highlighting off.
 */
export const codeLanguage = (
  className: string | undefined,
): string | false | undefined => {
  let language: string | undefined;
  for (const value of className?.split(" ") ?? []) {
    if (value === "no-highlight" || value === "nohighlight") return false;
    if (language === undefined && value.startsWith("lang-"))
      language = value.slice(5);
    if (language === undefined && value.startsWith("language-"))
      language = value.slice(9);
  }
  return language || undefined;
};

/** Code shown as plain text, before or without highlighting. */
export const plainCode = (
  language: string | undefined,
  source: string,
  exact: boolean,
): StreamingCodeHighlight => ({
  language,
  source,
  exact,
  settled: [],
  settledLength: 0,
  tail: source === "" ? [] : [source],
});

/** highlight.js with the common grammars, loaded on demand. */
export type CodeHighlighter = typeof CodeHighlight;

// highlight.js and its grammars are about 40 KB gzip and a long task to
// evaluate on a phone, so they load when the first code block that names a
// language renders, not with the page. Code shows as plain text until then.
let highlighter: CodeHighlighter | undefined;
let loading: Promise<CodeHighlighter> | undefined;
const listeners = new Set<() => void>();

// Each code block re-renders highlighted when its listener runs. A reply
// can hold dozens of blocks, so they re-render a few milliseconds' worth at a
// time, yielding to the browser between slices, instead of in one long task.
const SLICE_MS = 8;
const nextTask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
const notifyInSlices = async (pending: ReadonlyArray<() => void>) => {
  let sliceStart = performance.now();
  for (const listener of pending) {
    if (performance.now() - sliceStart > SLICE_MS) {
      await nextTask();
      sliceStart = performance.now();
    }
    // A block that unmounted while it waited has nothing to update.
    if (listeners.has(listener)) listener();
  }
};

/** Loads the highlighter once; code blocks re-render when it arrives. */
export const loadCodeHighlighter = () => {
  loading ??= import("./code-highlight.js").then(
    (module) => {
      highlighter = module;
      void notifyInSlices([...listeners]);
      return module;
    },
    (error: unknown) => {
      // A failed chunk leaves code plain; the next code block retries.
      loading = undefined;
      throw error;
    },
  );
  return loading;
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => highlighter;

/**
 * The code highlighter, or undefined while it loads. A caller with code to
 * highlight (`wanted`) starts the load; every caller re-renders when it
 * arrives.
 */
export const useCodeHighlighter = (wanted: boolean) => {
  const current = React.useSyncExternalStore(subscribe, snapshot, snapshot);
  if (wanted && current === undefined)
    loadCodeHighlighter().catch(() => undefined);
  return current;
};
