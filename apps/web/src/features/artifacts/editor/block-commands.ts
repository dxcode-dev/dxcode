import { Fragment, type Node, type NodeType } from "prosemirror-model";
import {
  type Command,
  type EditorState,
  NodeSelection,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import {
  addColumnAfter,
  addRowAfter,
  CellSelection,
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
  selectedRect,
  TableMap,
} from "prosemirror-tables";
import { artifactSchema as schema } from "../markdown/artifact-markdown.js";
import { itemAt } from "../markdown/item-at.js";

const nodes = schema.nodes;

/** The kinds of block a person can insert or turn a block into. */
export type BlockKind =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bullet"
  | "ordered"
  | "checklist"
  | "quote"
  | "code"
  | "table"
  | "view"
  | "divider";

export const BLOCK_KINDS: ReadonlyArray<{
  readonly kind: BlockKind;
  readonly label: string;
  /** Whether Turn Into offers it; a table or divider has no text to keep. */
  readonly convertible: boolean;
}> = [
  { kind: "paragraph", label: "Text", convertible: true },
  { kind: "heading1", label: "Heading 1", convertible: true },
  { kind: "heading2", label: "Heading 2", convertible: true },
  { kind: "heading3", label: "Heading 3", convertible: true },
  { kind: "bullet", label: "Bulleted list", convertible: true },
  { kind: "ordered", label: "Numbered list", convertible: true },
  { kind: "checklist", label: "Checklist", convertible: true },
  { kind: "quote", label: "Quote", convertible: true },
  { kind: "code", label: "Code", convertible: true },
  { kind: "table", label: "Table", convertible: false },
  { kind: "view", label: "View", convertible: false },
  { kind: "divider", label: "Divider", convertible: false },
];

const paragraph = (content?: Fragment) =>
  nodes.paragraph.create(null, content ?? null);

/** An empty cell: one empty paragraph. */
const cell = (type: NodeType) => type.create(null, nodes.paragraph.create());

/** A new view: one self-contained HTML page, edited under Edit Source. */
const VIEW_TEMPLATE = `<!doctype html>
<html>
  <body>
    <h1>View</h1>
    <p>Edit the source to build this view.</p>
  </body>
</html>`;

/** Inserts a chip at the cursor, with a space after it to keep typing. */
export const insertChip = (
  state: EditorState,
  source: string,
): Transaction | undefined => {
  const { $from } = state.selection;
  if (!$from.parent.type.contentMatch.matchType(nodes.chip)) return undefined;
  if ($from.parent.type === nodes.code_block) return undefined;
  const tr = state.tr.replaceSelectionWith(nodes.chip.create({ source }), true);
  return tr.insertText(" ").scrollIntoView();
};

export const newTable = (rows = 3, columns = 3) =>
  nodes.table.create(
    null,
    Array.from({ length: rows }, (_, row) =>
      nodes.table_row.create(
        null,
        Array.from({ length: columns }, () =>
          cell(row === 0 ? nodes.table_header : nodes.table_cell),
        ),
      ),
    ),
  );

/** The inline content of each line of text a block holds. */
const linesOf = (block: Node): Fragment[] => {
  if (block.type === nodes.code_block)
    return block.textContent
      .split("\n")
      .map((line) =>
        line === "" ? Fragment.empty : Fragment.from(schema.text(line)),
      );
  if (block.isTextblock) return [block.content];
  const out: Fragment[] = [];
  block.descendants((node) => {
    if (node.isTextblock) {
      out.push(
        node.type === nodes.code_block
          ? node.textContent === ""
            ? Fragment.empty
            : Fragment.from(schema.text(node.textContent))
          : node.content,
      );
      return false;
    }
    return true;
  });
  return out.length === 0 ? [Fragment.empty] : out;
};

/** Inline content without hard breaks or images, for headings and code. */
const headingInline = (content: Fragment) => {
  const out: Node[] = [];
  content.forEach((node) => {
    if (node.type === nodes.hard_break) out.push(schema.text(" "));
    else out.push(node);
  });
  return Fragment.from(out);
};

/** A block of `kind` holding `lines` of text. */
const blockOf = (kind: BlockKind, lines: Fragment[]): Node[] => {
  const items = (checked: boolean | null) =>
    lines.map((line) => nodes.list_item.create({ checked }, paragraph(line)));
  switch (kind) {
    case "paragraph":
      return lines.map((line) => paragraph(line));
    case "heading1":
    case "heading2":
    case "heading3":
      return [
        nodes.heading.create(
          { level: Number(kind.slice(-1)) },
          headingInline(lines[0] ?? Fragment.empty),
        ),
        ...lines.slice(1).map((line) => paragraph(line)),
      ];
    case "bullet":
      return [nodes.bullet_list.create(null, items(null))];
    case "ordered":
      return [nodes.ordered_list.create(null, items(null))];
    case "checklist":
      return [nodes.bullet_list.create(null, items(false))];
    case "quote":
      return [
        nodes.blockquote.create(
          null,
          lines.map((line) => paragraph(line)),
        ),
      ];
    case "code": {
      const text = lines
        .map((line) =>
          line.textBetween(0, line.size, "", (leaf) =>
            leaf.type === nodes.hard_break ? "\n" : "",
          ),
        )
        .join("\n");
      return [
        nodes.code_block.create(null, text === "" ? null : schema.text(text)),
      ];
    }
    case "table":
      return [newTable()];
    case "view":
      return [
        nodes.code_block.create(
          { params: "dx-view" },
          schema.text(VIEW_TEMPLATE),
        ),
      ];
    case "divider":
      return [nodes.horizontal_rule.create()];
  }
};

/** The top-level block at `position`, with where it starts. */
export const topLevelBlockAt = (state: EditorState, position: number) => {
  const $pos = state.doc.resolve(Math.min(position, state.doc.content.size));
  if ($pos.depth === 0) {
    const node = state.doc.nodeAt(position);
    return node === null ? undefined : { node, pos: position };
  }
  return { node: $pos.node(1), pos: $pos.before(1) };
};

/** A cursor inside the first textblock at or after `position`. */
const cursorInto = (tr: Transaction, position: number) => {
  const $pos = tr.doc.resolve(Math.min(position, tr.doc.content.size));
  tr.setSelection(TextSelection.near($pos, 1));
  return tr;
};

/** Inserts a new block of `kind` after the top-level block at `pos`. */
export const insertBlockBelow = (
  state: EditorState,
  pos: number,
  kind: BlockKind,
): Transaction | undefined => {
  const block = state.doc.nodeAt(pos);
  if (block === null) return undefined;
  const after = pos + block.nodeSize;
  const inserted = blockOf(kind, [Fragment.empty]);
  const tr = state.tr.insert(after, inserted);
  if (kind === "divider")
    tr.insert(after + itemAt(inserted, 0).nodeSize, paragraph());
  return cursorInto(tr, after + 1).scrollIntoView();
};

/** Inserts a block of `kind` below the block holding the selection, or into an empty one. */
export const insertBlock = (
  state: EditorState,
  kind: BlockKind,
): Transaction | undefined => {
  const block = topLevelBlockAt(state, state.selection.from);
  if (block === undefined) return undefined;
  if (block.node.type === nodes.paragraph && block.node.childCount === 0) {
    const tr = state.tr.replaceWith(
      block.pos,
      block.pos + block.node.nodeSize,
      blockOf(kind, [Fragment.empty]),
    );
    if (kind === "divider")
      tr.insert(
        block.pos + nodes.horizontal_rule.create().nodeSize,
        paragraph(),
      );
    return cursorInto(tr, block.pos + 1).scrollIntoView();
  }
  return insertBlockBelow(state, block.pos, kind);
};

/** Turns the top-level block at `pos` into `kind`, keeping its text. */
export const turnBlockInto = (
  state: EditorState,
  pos: number,
  kind: BlockKind,
): Transaction | undefined => {
  const block = state.doc.nodeAt(pos);
  if (block === null || block.type === nodes.table) return undefined;
  const replacement = blockOf(kind, linesOf(block));
  const tr = state.tr.replaceWith(pos, pos + block.nodeSize, replacement);
  return cursorInto(tr, pos + 1);
};

/** Moves the top-level block at `pos` one place up (-1) or down (1). */
export const moveBlock = (
  state: EditorState,
  pos: number,
  direction: -1 | 1,
): Transaction | undefined => {
  const $pos = state.doc.resolve(pos);
  const index = $pos.index(0);
  const block = state.doc.child(index);
  const neighbour = index + direction;
  if (neighbour < 0 || neighbour >= state.doc.childCount) return undefined;
  const other = state.doc.child(neighbour);
  const tr = state.tr.delete(pos, pos + block.nodeSize);
  const target = direction === -1 ? pos - other.nodeSize : pos + other.nodeSize;
  tr.insert(target, block);
  return tr.setSelection(NodeSelection.create(tr.doc, target)).scrollIntoView();
};

/**
 * Moves the top-level block at `pos` to sit before the top-level block at
 * `index` (the end when `index` is the number of blocks): one step to undo.
 * Undefined when that is where it already is.
 */
export const moveBlockTo = (
  state: EditorState,
  pos: number,
  index: number,
): Transaction | undefined => {
  const from = state.doc.resolve(pos).index(0);
  if (index === from || index === from + 1) return undefined;
  const block = state.doc.child(from);
  const tr = state.tr.delete(pos, pos + block.nodeSize);
  const target = index > from ? index - 1 : index;
  let at = 0;
  for (let child = 0; child < target; child += 1)
    at += tr.doc.child(child).nodeSize;
  tr.insert(at, block);
  return tr.setSelection(NodeSelection.create(tr.doc, at)).scrollIntoView();
};

export const duplicateBlock = (
  state: EditorState,
  pos: number,
): Transaction | undefined => {
  const block = state.doc.nodeAt(pos);
  if (block === null) return undefined;
  return state.tr.insert(pos + block.nodeSize, block).scrollIntoView();
};

export const deleteBlock = (
  state: EditorState,
  pos: number,
): Transaction | undefined => {
  const block = state.doc.nodeAt(pos);
  if (block === null) return undefined;
  const tr = state.tr.delete(pos, pos + block.nodeSize);
  if (tr.doc.childCount === 0) tr.insert(0, paragraph());
  return cursorInto(tr, Math.max(0, pos - 1));
};

// ---------------------------------------------------------------------------
// Tables

export type TableAction =
  | "add-row"
  | "add-column"
  | "delete-row"
  | "delete-column"
  | "delete-table"
  | "align-left"
  | "align-center"
  | "align-right";

/** Runs a table action on the table holding the selection. */
export const tableAction = (
  state: EditorState,
  action: TableAction,
): Transaction | undefined => {
  if (!isInTable(state)) return undefined;
  const run = (command: Command) => {
    const captured: { tr?: Transaction } = {};
    command(state, (tr) => {
      captured.tr = tr;
    });
    return captured.tr;
  };
  /** Puts the cursor in the cell at `index` of the edited table's map. */
  const enterCell = (
    tr: Transaction | undefined,
    tableStart: number,
    index: (map: TableMap) => number,
  ) => {
    const table = tr?.doc.nodeAt(tableStart - 1);
    if (tr === undefined || table === null || table === undefined) return tr;
    const map = TableMap.get(table);
    const cell = tableStart + itemAt(map.map, index(map));
    return tr.setSelection(TextSelection.near(tr.doc.resolve(cell + 1)));
  };
  switch (action) {
    case "add-row": {
      // The cursor moves into the new row, ready to type.
      const rect = selectedRect(state);
      const tr = run(addRowAfter);
      // New cells take their column's alignment, as Markdown shows them.
      const table = tr?.doc.nodeAt(rect.tableStart - 1);
      if (tr !== undefined && table !== null && table !== undefined) {
        const map = TableMap.get(table);
        for (let column = 0; column < map.width; column += 1) {
          const header = table.nodeAt(itemAt(map.map, column));
          const cellPos =
            rect.tableStart + itemAt(map.map, rect.bottom * map.width + column);
          const cell = tr.doc.nodeAt(cellPos);
          if (header !== null && cell !== null && header.attrs.align !== null)
            tr.setNodeMarkup(cellPos, null, {
              ...cell.attrs,
              align: header.attrs.align,
            });
        }
      }
      return enterCell(tr, rect.tableStart, (map) => rect.bottom * map.width);
    }
    case "add-column": {
      const rect = selectedRect(state);
      return enterCell(
        run(addColumnAfter),
        rect.tableStart,
        (map) => rect.top * map.width + rect.right,
      );
    }
    case "delete-row":
      return run(deleteRow);
    case "delete-column":
      return run(deleteColumn);
    case "delete-table":
      return run(deleteTable);
    default: {
      // Markdown aligns a whole column: set it on every cell in the column.
      const rect = selectedRect(state);
      const align = action.slice("align-".length);
      const tr = state.tr;
      for (let row = 0; row < rect.map.height; row += 1) {
        for (let column = rect.left; column < rect.right; column += 1) {
          const cellPos =
            rect.tableStart +
            itemAt(rect.map.map, row * rect.map.width + column);
          const node = tr.doc.nodeAt(cellPos);
          if (node !== null)
            tr.setNodeMarkup(cellPos, null, { ...node.attrs, align });
        }
      }
      return tr;
    }
  }
};

export const selectionInTable = (state: EditorState) =>
  isInTable(state) || state.selection instanceof CellSelection;

/**
 * A transcript typed at the cursor, as one transaction. It gets a space
 * before it when it would otherwise run into the word before the cursor.
 */
export const insertDictation = (
  state: EditorState,
  text: string,
): Transaction | undefined => {
  const words = text.trim();
  if (words === "") return undefined;
  const { $from } = state.selection;
  const before = $from.parent.textBetween(
    Math.max(0, $from.parentOffset - 1),
    $from.parentOffset,
  );
  const spaced = before === "" || /\s$/.test(before) ? words : ` ${words}`;
  return state.tr.insertText(spaced).scrollIntoView();
};
