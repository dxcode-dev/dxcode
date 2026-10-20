import type { Emitter } from "highlight.js";
import HighlightJs from "highlight.js/lib/core";
import { common, createLowlight } from "lowlight";

/** Highlighted code: text, or a span with highlight.js classes. */
export type HighlightNode =
  | string
  | {
      readonly className: string;
      readonly children: ReadonlyArray<HighlightNode>;
    };

interface LowlightNode {
  readonly type: string;
  readonly value?: string;
  readonly properties?: { readonly className?: ReadonlyArray<string> };
  readonly children?: ReadonlyArray<LowlightNode>;
}

const fromLowlight = (node: LowlightNode): HighlightNode =>
  node.type === "text"
    ? (node.value ?? "")
    : {
        className: node.properties?.className?.join(" ") ?? "",
        children: (node.children ?? []).map(fromLowlight),
      };

// The highlighter rehype-highlight would create, once for the page:
// react-markdown builds a processor per parse, and rehype-highlight created
// and compiled a new one for each.
const lowlight = createLowlight(common);
const exact = new Map<string, ReadonlyArray<HighlightNode>>();
let exactChars = 0;
const EXACT_CACHE_CHARS = 2_000_000;

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

/**
 * lowlight's highlighting of a code block, as rehype-highlight produces it,
 * or undefined when the language is unknown. Cached on the code, because a
 * finished reply parses its streamed blocks again.
 */
export const highlightCode = (
  language: string,
  code: string,
): ReadonlyArray<HighlightNode> | undefined => {
  if (!lowlight.registered(language)) return undefined;
  const key = `${language}\0${code}`;
  const cached = exact.get(key);
  if (cached !== undefined) {
    exact.delete(key);
    exact.set(key, cached);
    return cached;
  }
  const nodes = lowlight.highlight(language, code).children.map(fromLowlight);
  exact.set(key, nodes);
  exactChars += key.length;
  for (const oldest of exact.keys()) {
    if (exactChars <= EXACT_CACHE_CHARS || exact.size === 1) break;
    exactChars -= oldest.length;
    exact.delete(oldest);
  }
  return nodes;
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

interface Span {
  readonly className: string;
  readonly children: HighlightNode[];
}

/**
 * Builds the same tree as lowlight, which rehype-highlight uses, and records
 * the line ends that no span encloses.
 */
class NodeEmitter implements Emitter {
  readonly root: Span = { className: "", children: [] };
  readonly rootLineEnds: number[] = [];
  length = 0;
  private readonly stack: Span[] = [this.root];
  private readonly prefix: string;

  constructor(options: { readonly classPrefix: string }) {
    this.prefix = options.classPrefix;
  }

  addText(text: string) {
    if (text === "") return;
    if (this.stack.length === 1)
      for (
        let at = text.indexOf("\n");
        at !== -1;
        at = text.indexOf("\n", at + 1)
      )
        this.rootLineEnds.push(this.length + at + 1);
    this.length += text.length;
    const children = (this.stack.at(-1) as Span).children;
    const last = children.at(-1);
    if (typeof last === "string") children[children.length - 1] = last + text;
    else children.push(text);
  }

  startScope(scope: string) {
    // "title.function" becomes "hljs-title function_", as in lowlight.
    const span: Span = {
      className: scope
        .split(".")
        .map((part, index) =>
          index === 0 ? this.prefix + part : part + "_".repeat(index),
        )
        .join(" "),
      children: [],
    };
    (this.stack.at(-1) as Span).children.push(span);
    this.stack.push(span);
  }

  endScope() {
    this.stack.pop();
  }

  // highlight.js still opens and closes mode scopes through these.
  openNode(scope: string) {
    this.startScope(scope);
  }

  closeNode() {
    this.endScope();
  }

  __addSublanguage(other: Emitter, name: string) {
    const sublanguage = other as NodeEmitter;
    this.length += sublanguage.length;
    const children = (this.stack.at(-1) as Span).children;
    if (name)
      children.push({ className: name, children: sublanguage.root.children });
    else children.push(...sublanguage.root.children);
  }

  finalize() {}

  toHTML() {
    return "";
  }
}

// The grammars rehype-highlight registers, in an instance whose results
// expose the grammar state at the end of the input.
const highlighter = HighlightJs.newInstance();
for (const [name, grammar] of Object.entries(common))
  highlighter.registerLanguage(name, grammar);
highlighter.configure({ __emitter: NodeEmitter, classPrefix: "hljs-" });

const highlight = (language: string, code: string) => {
  const result = highlighter.highlight(code, {
    language,
    ignoreIllegals: true,
  });
  const emitter = result._emitter as NodeEmitter;
  return {
    nodes: result.errorRaised ? [code] : emitter.root.children,
    rootLineEnds: emitter.rootLineEnds,
    // Each mode highlight.js enters links to the one it left; the
    // language itself has no parent.
    endsAtRoot:
      !result.errorRaised &&
      (result._top as { parent?: unknown } | undefined)?.parent === undefined,
  };
};

const textLength = (node: HighlightNode): number =>
  typeof node === "string"
    ? node.length
    : node.children.reduce((total, child) => total + textLength(child), 0);

/** Splits top-level nodes at `offset`, or undefined when a span crosses it. */
const splitAt = (nodes: ReadonlyArray<HighlightNode>, offset: number) => {
  let at = 0;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index] as HighlightNode;
    const end = at + textLength(node);
    if (end === offset)
      return [nodes.slice(0, index + 1), nodes.slice(index + 1)] as const;
    if (end > offset) {
      if (typeof node !== "string") return undefined;
      return [
        [...nodes.slice(0, index), node.slice(0, offset - at)],
        [node.slice(offset - at), ...nodes.slice(index + 1)],
      ] as const;
    }
    at = end;
  }
  return offset === at ? ([nodes, []] as const) : undefined;
};

const sameNodes = (
  a: ReadonlyArray<HighlightNode>,
  b: ReadonlyArray<HighlightNode>,
): boolean =>
  a.length === b.length &&
  a.every((node, index) => {
    const other = b[index] as HighlightNode;
    return typeof node === "string" || typeof other === "string"
      ? node === other
      : node.className === other.className &&
          sameNodes(node.children, other.children);
  });

// A grammar can look ahead past a line end (JSX tags look for their closing
// tag), so lines settle only once this many later lines were highlighted
// with them.
const CONTEXT_LINES = 32;
const MIN_SETTLED_LINES = 16;

/**
 * Highlights code that grows at its end, such as an open Markdown fence
 * while a reply streams. Highlighting the whole fence on every chunk costs
 * quadratic time in its length; this re-highlights only the lines after the
 * last settled run, so each line is highlighted a bounded number of times.
 *
 * A run of lines settles at a line end where highlight.js is back in the
 * language's top-level state, so the next run can start fresh exactly as one
 * pass over the whole code would continue. Settled runs keep their identity.
 */
export const highlightStreamingCode = (
  previous: StreamingCodeHighlight | undefined,
  language: string | undefined,
  source: string,
): StreamingCodeHighlight => {
  if (language === undefined || highlighter.getLanguage(language) === undefined)
    return plain(language, source, false);
  const reuse =
    previous !== undefined &&
    !previous.exact &&
    previous.language === language &&
    source.startsWith(previous.source.slice(0, previous.settledLength));
  const settled = reuse ? previous.settled : [];
  const offset = reuse ? previous.settledLength : 0;
  const pending = source.slice(offset);
  const view = highlight(language, pending);
  const lineEnds: number[] = [];
  for (
    let at = pending.indexOf("\n");
    at !== -1;
    at = pending.indexOf("\n", at + 1)
  )
    lineEnds.push(at + 1);
  const latest = lineEnds[lineEnds.length - 1 - CONTEXT_LINES];
  const earliest = lineEnds[MIN_SETTLED_LINES - 1];
  if (latest !== undefined && earliest !== undefined && earliest <= latest) {
    const end = view.rootLineEnds.findLast(
      (lineEnd) => lineEnd >= earliest && lineEnd <= latest,
    );
    // No span crosses `end`, and an unscoped mode (a CSS rule body, say)
    // is not open there either.
    const split =
      end !== undefined && highlight(language, pending.slice(0, end)).endsAtRoot
        ? splitAt(view.nodes, end)
        : undefined;
    if (end !== undefined && split !== undefined)
      return {
        language,
        source,
        exact: false,
        settled: [...settled, { nodes: split[0], start: offset, length: end }],
        settledLength: offset + end,
        tail: split[1],
      };
  }
  return {
    language,
    source,
    exact: false,
    settled,
    settledLength: offset,
    tail: view.nodes,
  };
};

// Exact only once the code stops growing, so an open fence's highlight
// matches its `closed` state and is not replaced on every render.
const plain = (
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

/**
 * The exact highlighting of code that stopped growing, such as a fence that
 * just closed. It is cut where the streamed runs ended, wherever no span
 * crosses the cut, and a run whose output did not change keeps its identity,
 * so React leaves those lines alone.
 */
export const highlightClosedCode = (
  previous: StreamingCodeHighlight | undefined,
  language: string | undefined,
  source: string,
): StreamingCodeHighlight => {
  const nodes =
    language === undefined ? undefined : highlightCode(language, source);
  if (nodes === undefined || nodes.length === 0)
    return plain(language, source, true);
  const settled: HighlightedLines[] = [];
  let offset = 0;
  let rest = nodes;
  if (
    previous !== undefined &&
    previous.language === language &&
    source.startsWith(previous.source.slice(0, previous.settledLength))
  )
    for (const run of previous.settled) {
      const split = splitAt(rest, run.length);
      if (split === undefined) break;
      settled.push(
        sameNodes(split[0], run.nodes)
          ? run
          : { nodes: split[0], start: offset, length: run.length },
      );
      offset += run.length;
      rest = split[1];
    }
  return {
    language,
    source,
    exact: true,
    settled,
    settledLength: offset,
    tail: rest,
  };
};
