import { Mark, type Node } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";

/** Equal content and style, ignoring the codec's source keys. */
const sameIgnoringKeys = (a: Node, b: Node): boolean => {
  if (a.type !== b.type || a.childCount !== b.childCount) return false;
  if (!Mark.sameSet(a.marks, b.marks)) return false;
  if (a.isText) return a.text === b.text;
  for (const name of Object.keys(a.attrs))
    if (name !== "key" && a.attrs[name] !== b.attrs[name]) return false;
  for (let i = 0; i < a.childCount; i += 1)
    if (!sameIgnoringKeys(a.child(i), b.child(i))) return false;
  return true;
};

/** Gives every keyed node under `from` the key of the same node in `to`. */
const rekey = (tr: Transaction, from: Node, to: Node, position: number) => {
  if (from.attrs.key !== undefined && from.attrs.key !== to.attrs.key)
    tr.setNodeAttribute(position, "key", to.attrs.key);
  if (from.isTextblock || from.isLeaf) return;
  from.forEach((child, offset, index) => {
    rekey(tr, child, to.child(index), position + 1 + offset);
  });
};

/**
 * A transaction turning the editor's document into `next` while touching
 * only the top-level blocks that differ, so the selection and scroll of a
 * person typing elsewhere stay put. Unchanged blocks take `next`'s source
 * keys, so they are written back exactly as `next`'s Markdown has them.
 */
export const replaceDocument = (
  state: EditorState,
  next: Node,
): Transaction => {
  const current = state.doc;
  const tr = state.tr;
  let start = 0;
  while (
    start < current.childCount &&
    start < next.childCount &&
    sameIgnoringKeys(current.child(start), next.child(start))
  )
    start += 1;
  let endCurrent = current.childCount;
  let endNext = next.childCount;
  while (
    endCurrent > start &&
    endNext > start &&
    sameIgnoringKeys(current.child(endCurrent - 1), next.child(endNext - 1))
  ) {
    endCurrent -= 1;
    endNext -= 1;
  }
  const offset = (doc: Node, index: number) => {
    let position = 0;
    for (let i = 0; i < index; i += 1) position += doc.child(i).nodeSize;
    return position;
  };
  if (start < endCurrent || start < endNext) {
    const nodes: Node[] = [];
    for (let i = start; i < endNext; i += 1) nodes.push(next.child(i));
    tr.replaceWith(offset(current, start), offset(current, endCurrent), nodes);
  }
  // Unchanged blocks keep their place; give them the new source keys.
  for (let i = 0; i < start; i += 1)
    rekey(tr, current.child(i), next.child(i), offset(current, i));
  const shift = endNext - endCurrent;
  for (let i = endCurrent; i < current.childCount; i += 1)
    rekey(
      tr,
      current.child(i),
      next.child(i + shift),
      offset(tr.doc, i + shift),
    );
  return tr;
};
