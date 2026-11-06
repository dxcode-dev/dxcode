/**
 * What the selection toolbar (#1805) does to an artifact's selection: its
 * marks, a link, its Markdown, and where it is on the page. Each command
 * keeps the selection, so the next button acts on the same text.
 */
import { toggleMark } from "prosemirror-commands";
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  artifactSchema,
  serializeArtifactMarkdownFresh,
} from "../markdown/artifact-markdown.js";

export type SelectionMark = "strong" | "em" | "strike" | "code";

/** The marks the whole selection has, and its link when it is one link. */
export interface SelectionMarks {
  readonly strong: boolean;
  readonly em: boolean;
  readonly strike: boolean;
  readonly code: boolean;
  readonly link: string | undefined;
}

/** Where the selected text is, in the page's coordinates. */
export interface SelectionBox {
  readonly top: number;
  readonly bottom: number;
  /** The middle of the selection on its first line. */
  readonly center: number;
}

const has = (state: EditorState, name: SelectionMark | "link") => {
  const { from, to } = state.selection;
  return state.doc.rangeHasMark(from, to, artifactSchema.marks[name]);
};

export const selectionMarks = (state: EditorState): SelectionMarks => {
  const { from, to } = state.selection;
  let link: string | undefined;
  let one = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return;
    const href = node.marks.find(
      (mark) => mark.type === artifactSchema.marks.link,
    )?.attrs.href as string | undefined;
    if (href === undefined || (link !== undefined && href !== link))
      one = false;
    link ??= href;
  });
  return {
    strong: has(state, "strong"),
    em: has(state, "em"),
    strike: has(state, "strike"),
    code: has(state, "code"),
    link: one ? link : undefined,
  };
};

export const selectionBox = (
  view: EditorView,
  page: HTMLElement,
): SelectionBox | undefined => {
  const { from, to, empty } = view.state.selection;
  if (empty) return undefined;
  try {
    const start = view.coordsAtPos(from, 1);
    const end = view.coordsAtPos(to, -1);
    const origin = page.getBoundingClientRect();
    const oneLine = Math.abs(end.top - start.top) < 4;
    return {
      top: Math.round(Math.min(start.top, end.top) - origin.top),
      bottom: Math.round(Math.max(start.bottom, end.bottom) - origin.top),
      center: Math.round(
        (oneLine ? (start.left + end.right) / 2 : start.left + 80) -
          origin.left,
      ),
    };
  } catch {
    return undefined;
  }
};

export const toggleSelectionMark = (view: EditorView, name: SelectionMark) => {
  toggleMark(artifactSchema.marks[name])(view.state, view.dispatch);
  view.focus();
};

/**
 * A web or mail address for a link: a bare domain gets `https://`. Not
 * `javascript:`, `data:`, or a relative path, which a link here never needs.
 */
export const linkTarget = (input: string): string | undefined => {
  const text = input.trim();
  if (text === "") return undefined;
  if (/^(https?:\/\/|mailto:)\S+$/i.test(text)) return text;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text)) return `https://${text}`;
  return undefined;
};

/**
 * Links the selection to `input`, or removes its link when `input` is
 * empty. False when `input` is not a web or mail address.
 */
export const linkSelection = (view: EditorView, input: string) => {
  const { from, to } = view.state.selection;
  const type = artifactSchema.marks.link;
  if (input.trim() === "") {
    view.dispatch(view.state.tr.removeMark(from, to, type));
    view.focus();
    return true;
  }
  const href = linkTarget(input);
  if (href === undefined) return false;
  view.dispatch(
    view.state.tr
      .removeMark(from, to, type)
      .addMark(from, to, type.create({ href })),
  );
  view.focus();
  return true;
};

/** The selection as Markdown, formatting kept; its text when it won't parse as blocks. */
export const selectionMarkdown = (state: EditorState) => {
  const { from, to } = state.selection;
  try {
    const doc = artifactSchema.topNodeType.create(
      null,
      state.selection.content().content,
    );
    const markdown = serializeArtifactMarkdownFresh(doc).trim();
    if (markdown !== "") return markdown;
  } catch {
    // A slice of a table or a list item is not a document by itself.
  }
  return state.doc.textBetween(from, to, "\n\n", "\n");
};

/** The selection as a Markdown quote, after what the person was writing. */
export const withQuote = (current: string, markdown: string) => {
  const quote = markdown
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
  return current.trim() === ""
    ? `${quote}\n\n`
    : `${current.trimEnd()}\n\n${quote}\n\n`;
};
