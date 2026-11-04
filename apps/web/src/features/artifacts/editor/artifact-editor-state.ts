import {
  baseKeymap,
  chainCommands,
  exitCode,
  setBlockType,
  toggleMark,
} from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, redo, undo } from "prosemirror-history";
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { Node, NodeType, Slice } from "prosemirror-model";
import { Fragment, Slice as SliceClass } from "prosemirror-model";
import {
  liftListItem,
  sinkListItem,
  splitListItem,
} from "prosemirror-schema-list";
import {
  type Command,
  EditorState,
  Plugin,
  PluginKey,
  TextSelection,
} from "prosemirror-state";
import { goToNextCell, tableEditing } from "prosemirror-tables";
import {
  Decoration,
  DecorationSet,
  type EditorView,
  type NodeView,
} from "prosemirror-view";
import {
  parseArtifactMarkdown,
  artifactSchema as schema,
} from "../markdown/artifact-markdown.js";
import { itemAt } from "../markdown/item-at.js";
import {
  type ChipViewHost,
  chipNodeViews,
  chipToggles,
  type NodeViews,
} from "./chip-views.js";
import { commentHighlights } from "./comment-highlights.js";

const nodes = schema.nodes;
const marks = schema.marks;

// ---------------------------------------------------------------------------
// Conflict flags: blocks a merge kept in both versions.

export const conflictFlagsKey = new PluginKey<ReadonlySet<number>>(
  "artifactConflictFlags",
);

const conflictFlags = new Plugin<ReadonlySet<number>>({
  key: conflictFlagsKey,
  state: {
    init: () => new Set(),
    apply: (tr, flags) => {
      const next = tr.getMeta(conflictFlagsKey) as
        | ReadonlySet<number>
        | undefined;
      return next ?? flags;
    },
  },
  props: {
    decorations: (state) => {
      const flags = conflictFlagsKey.getState(state);
      if (flags === undefined || flags.size === 0) return DecorationSet.empty;
      const decorations: Decoration[] = [];
      state.doc.forEach((node, offset) => {
        if (typeof node.attrs.key === "number" && flags.has(node.attrs.key))
          decorations.push(
            Decoration.node(offset, offset + node.nodeSize, {
              class: "artifact-block-conflict",
            }),
          );
      });
      return DecorationSet.create(state.doc, decorations);
    },
  },
});

// ---------------------------------------------------------------------------
// A paragraph always ends the document, so there is somewhere to type after
// a table, a code block, a view, or a divider. Markdown never holds it: an
// empty paragraph writes nothing.

const needsTrailingParagraph = (doc: Node) =>
  doc.lastChild?.type !== nodes.paragraph;

const trailingParagraph = new Plugin({
  appendTransaction: (transactions, _old, state) => {
    if (
      !transactions.some((tr) => tr.docChanged) ||
      !needsTrailingParagraph(state.doc)
    )
      return null;
    return state.tr
      .insert(state.doc.content.size, nodes.paragraph.create())
      .setMeta("addToHistory", false);
  },
});

/** `doc` with a paragraph at its end, if it does not end with one. */
export const withTrailingParagraph = (doc: Node) =>
  needsTrailingParagraph(doc)
    ? doc.copy(doc.content.addToEnd(nodes.paragraph.create()))
    : doc;

// ---------------------------------------------------------------------------
// Placeholder on an empty document.

const placeholder = new Plugin({
  props: {
    decorations: (state) => {
      const { doc } = state;
      const first = doc.firstChild;
      if (
        doc.childCount !== 1 ||
        first === null ||
        first.type !== nodes.paragraph ||
        first.childCount !== 0
      )
        return DecorationSet.empty;
      return DecorationSet.create(doc, [
        Decoration.node(0, first.nodeSize, {
          class: "artifact-placeholder",
          "data-placeholder": "Start writing…",
        }),
      ]);
    },
  },
});

// ---------------------------------------------------------------------------
// Commands

/** Splits a list item; a new checklist item starts unticked. */
const splitItem: Command = (state, dispatch) =>
  splitListItem(nodes.list_item)(
    state,
    dispatch === undefined
      ? undefined
      : (tr) => {
          const { $from } = tr.selection;
          for (let depth = $from.depth; depth > 0; depth -= 1) {
            const node = $from.node(depth);
            if (node.type === nodes.list_item) {
              if (node.attrs.checked === true || node.attrs.key !== null)
                tr.setNodeMarkup($from.before(depth), null, {
                  ...node.attrs,
                  checked: node.attrs.checked === null ? null : false,
                  key: null,
                });
              break;
            }
          }
          dispatch(tr);
        },
  );

/** Ticks or unticks the checklist item holding the selection. */
export const toggleTask: Command = (state, dispatch) => {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type === nodes.list_item && node.attrs.checked !== null) {
      dispatch?.(
        state.tr.setNodeMarkup($from.before(depth), null, {
          ...node.attrs,
          checked: !node.attrs.checked,
        }),
      );
      return true;
    }
  }
  return false;
};

/** Whether the selection is in a table cell, where Markdown has no line breaks. */
const inCell = (state: EditorState) => {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const role = $from.node(depth).type.spec.tableRole;
    if (role === "cell" || role === "header_cell") return true;
  }
  return false;
};

const hardBreak: Command = chainCommands(exitCode, (state, dispatch) => {
  if (inCell(state)) return true;
  dispatch?.(
    state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView(),
  );
  return true;
});

/** The paragraph holding an empty selection, when it is a top-level block. */
const topParagraph = (state: EditorState) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth !== 1 || $from.parent.type !== nodes.paragraph)
    return undefined;
  if ($from.parentOffset !== $from.parent.content.size) return undefined;
  return { node: $from.parent, pos: $from.before(1) };
};

/**
 * Enter after Markdown that names a block makes that block: a header row
 * (`| Name | State |`) makes a table with an empty row to fill, and a fence
 * (```` ``` ```` or ```` ```ts ````) makes a code block in that language.
 */
const markdownOnEnter: Command = (state, dispatch) => {
  const paragraph = topParagraph(state);
  if (paragraph === undefined) return false;
  const text = paragraph.node.textContent;
  const end = paragraph.pos + paragraph.node.nodeSize;
  const fence = /^```([^\s`]*)$/.exec(text);
  if (fence !== null) {
    if (dispatch !== undefined) {
      const tr = state.tr.replaceWith(
        paragraph.pos,
        end,
        nodes.code_block.create({ params: fence[1] ?? "" }),
      );
      dispatch(
        tr
          .setSelection(TextSelection.create(tr.doc, paragraph.pos + 1))
          .scrollIntoView(),
      );
    }
    return true;
  }
  if (!/^\s*\|(?:[^|\n]*\|){1,}\s*$/.test(text)) return false;
  const headers = text
    .trim()
    .slice(1, -1)
    .split("|")
    .map((header) => header.trim());
  if (dispatch === undefined) return true;
  const cell = (type: NodeType, value: string) =>
    type.create(
      null,
      nodes.paragraph.create(null, value === "" ? null : schema.text(value)),
    );
  const table = nodes.table.create(null, [
    nodes.table_row.create(
      null,
      headers.map((header) => cell(nodes.table_header, header)),
    ),
    nodes.table_row.create(
      null,
      headers.map(() => cell(nodes.table_cell, "")),
    ),
  ]);
  const tr = state.tr.replaceWith(paragraph.pos, end, table);
  // The caret starts in the first cell of the empty row.
  const firstBodyCell = paragraph.pos + 1 + table.child(0).nodeSize + 1;
  dispatch(
    tr
      .setSelection(TextSelection.near(tr.doc.resolve(firstBodyCell + 1)))
      .scrollIntoView(),
  );
  return true;
};

/**
 * Up (or Left at the very start) in a table's first row or a code block's
 * first line, when that block opens the document: a paragraph goes above it
 * to hold the caret, as nothing else can. Markdown never holds an empty
 * paragraph.
 */
const leaveTableAbove =
  (direction: "up" | "left"): Command =>
  (state, dispatch, view) => {
    const { $from, empty } = state.selection;
    if (!empty || $from.index(0) !== 0) return false;
    const first = state.doc.firstChild;
    if (first?.type === nodes.table) {
      if (!inCell(state)) return false;
      // Only from the first row, and only where the caret cannot move further.
      if ($from.index(1) !== 0) return false;
      if (
        direction === "left" &&
        ($from.index(2) !== 0 || $from.parentOffset !== 0)
      )
        return false;
    } else if (first?.type === nodes.code_block) {
      // The first line of a code block that opens the document.
      if ($from.parent !== first) return false;
      if (direction === "left" && $from.parentOffset !== 0) return false;
    } else return false;
    if (view !== undefined && !view.endOfTextblock(direction)) return false;
    if (dispatch !== undefined) {
      const tr = state.tr.insert(0, nodes.paragraph.create());
      dispatch(
        tr.setSelection(TextSelection.create(tr.doc, 1)).scrollIntoView(),
      );
    }
    return true;
  };

const editorKeymap = keymap({
  ArrowUp: leaveTableAbove("up"),
  ArrowLeft: leaveTableAbove("left"),
  "Mod-z": undo,
  "Shift-Mod-z": redo,
  "Mod-y": redo,
  "Mod-b": toggleMark(marks.strong),
  "Mod-i": toggleMark(marks.em),
  "Mod-e": toggleMark(marks.code),
  "Shift-Mod-x": toggleMark(marks.strike),
  "Mod-Enter": toggleTask,
  "Shift-Enter": hardBreak,
  Enter: chainCommands(markdownOnEnter, splitItem),
  Tab: chainCommands(goToNextCell(1), sinkListItem(nodes.list_item)),
  "Shift-Tab": chainCommands(goToNextCell(-1), liftListItem(nodes.list_item)),
  "Mod-[": liftListItem(nodes.list_item),
  "Mod-]": sinkListItem(nodes.list_item),
  "Shift-Ctrl-0": setBlockType(nodes.paragraph),
  "Shift-Ctrl-1": setBlockType(nodes.heading, { level: 1 }),
  "Shift-Ctrl-2": setBlockType(nodes.heading, { level: 2 }),
  "Shift-Ctrl-3": setBlockType(nodes.heading, { level: 3 }),
});

// ---------------------------------------------------------------------------
// Input rules: Markdown shortcuts typed at the start of a block.

const taskRule = new InputRule(
  /^\s*\[([ xX]?)\]\s$/,
  (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    const checked = match[1] === "x" || match[1] === "X";
    const item = $start.node(-1);
    if ($start.depth >= 2 && item.type === nodes.list_item) {
      return state.tr
        .delete(start, end)
        .setNodeMarkup($start.before(-1), null, { ...item.attrs, checked });
    }
    const tr = state.tr.delete(start, end);
    const $from = tr.doc.resolve(start);
    const range = $from.blockRange();
    if (range === null) return null;
    return tr.wrap(range, [
      { type: nodes.bullet_list },
      { type: nodes.list_item, attrs: { checked } },
    ]);
  },
);

const rules = inputRules({
  rules: [
    textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (match) => ({
      level: itemAt(match, 1).length,
    })),
    wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
    wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list, (match) => ({
      markup: match[1],
    })),
    wrappingInputRule(
      /^(\d+)\.\s$/,
      nodes.ordered_list,
      (match) => ({ order: Number(match[1]) }),
      (match, node) => node.childCount + node.attrs.order === Number(match[1]),
    ),
    taskRule,
    new InputRule(/^---$/, (state, _match, start, end) => {
      const $start = state.doc.resolve(start);
      if ($start.parent.type !== nodes.paragraph || $start.depth !== 1)
        return null;
      const tr = state.tr.delete(start, end);
      const after = tr.doc.resolve(start);
      return tr
        .replaceRangeWith(
          after.before(),
          after.after(),
          nodes.horizontal_rule.create(),
        )
        .insert(tr.mapping.map(after.after()), nodes.paragraph.create());
    }),
  ],
});

// ---------------------------------------------------------------------------
// Node views

/** A list item; a checklist item gets a checkbox people tick. */
class ListItemView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  #box: HTMLInputElement | undefined;
  #task: boolean;

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.#task = node.attrs.checked !== null;
    this.dom = document.createElement("li");
    if (!this.#task) {
      this.contentDOM = this.dom;
      return;
    }
    this.dom.className = "artifact-task";
    const box = document.createElement("span");
    box.className = "artifact-task-box";
    box.contentEditable = "false";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("aria-label", "Done");
    input.addEventListener("mousedown", (event) => event.preventDefault());
    input.addEventListener("click", () => {
      // The browser ticks the box; the transaction records it, and `update`
      // keeps the box in step with the document.
      const position = getPos();
      const current =
        position === undefined ? null : view.state.doc.nodeAt(position);
      if (position === undefined || current === null || !view.editable) return;
      view.dispatch(
        view.state.tr.setNodeMarkup(position, null, {
          ...current.attrs,
          checked: !current.attrs.checked,
        }),
      );
    });
    box.append(input);
    this.#box = input;
    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "artifact-task-body";
    this.dom.append(box, this.contentDOM);
    this.#show(node);
  }

  #show(node: Node) {
    if (this.#box === undefined) return;
    this.#box.checked = node.attrs.checked === true;
    this.dom.dataset.checked = String(node.attrs.checked === true);
  }

  update(node: Node) {
    if (node.type !== nodes.list_item) return false;
    if ((node.attrs.checked !== null) !== this.#task) return false;
    this.#show(node);
    return true;
  }

  stopEvent(event: Event) {
    return event.target === this.#box;
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection" }) {
    return (
      mutation.type !== "selection" &&
      this.#box !== undefined &&
      this.#box.parentElement?.contains(mutation.target as globalThis.Node) ===
        true
    );
  }
}

/** A table inside a box that scrolls sideways on a narrow screen. */
class TableView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;

  constructor() {
    this.dom = document.createElement("div");
    this.dom.className = "artifact-table-scroll";
    const table = document.createElement("table");
    this.contentDOM = document.createElement("tbody");
    table.append(this.contentDOM);
    this.dom.append(table);
  }

  update(node: Node) {
    return node.type === nodes.table;
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection" }) {
    return (
      mutation.type === "attributes" &&
      (mutation.target === this.dom ||
        mutation.target === this.contentDOM.parentElement)
    );
  }
}

/** Pasted plain text is read as Markdown. */
const pastedMarkdown = (text: string): Slice => {
  const doc = parseArtifactMarkdown(text);
  return doc.childCount === 1 && doc.firstChild?.type === nodes.paragraph
    ? new SliceClass(doc.firstChild.content, 0, 0)
    : new SliceClass(Fragment.from(doc.content), 0, 0);
};

/** Every node view, given what chips and `dx-view` blocks ask of the editor. */
export const artifactNodeViews = (host: ChipViewHost): NodeViews => ({
  list_item: (node: Node, view: EditorView, getPos: () => number | undefined) =>
    new ListItemView(node, view, getPos),
  table: () => new TableView(),
  ...chipNodeViews(host),
});

export const artifactClipboardTextParser = pastedMarkdown;

export const createArtifactEditorState = (
  doc: Node,
  extra: ReadonlyArray<Plugin> = [],
) =>
  EditorState.create({
    doc: withTrailingParagraph(doc),
    plugins: [
      // First, so an open `/` or `@` menu takes the arrows and Enter.
      ...extra,
      rules,
      editorKeymap,
      keymap(baseKeymap),
      history(),
      dropCursor(),
      // Tables take the arrow keys first, so they move between cells; the
      // gap cursor then handles leaving a table at the document's edge.
      tableEditing(),
      gapCursor(),
      trailingParagraph,
      conflictFlags,
      chipToggles,
      commentHighlights,
      placeholder,
    ],
  });
