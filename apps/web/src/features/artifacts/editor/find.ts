/**
 * Find in the artifact (#1810): every match of a query, case-insensitive,
 * highlighted, and the current one stronger, as the reference editor shows
 * them. Matches are read within each textblock, so one never spans two
 * paragraphs or cells.
 */
import type { Node } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

export interface FindMatch {
  readonly from: number;
  readonly to: number;
}

interface FindState {
  readonly query: string;
  readonly current: number;
}

export const findKey = new PluginKey<FindState>("artifactFind");

/** Every match of `query` in `doc`, in document order. */
export const findMatches = (doc: Node, query: string): FindMatch[] => {
  const needle = query.toLocaleLowerCase();
  if (needle === "") return [];
  const found: FindMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // One character per inline leaf (a chip, an image, a break), so an
    // index in the text is an offset in the block.
    const text = node
      .textBetween(0, node.content.size, undefined, "\ufffc")
      .toLocaleLowerCase();
    let at = text.indexOf(needle);
    while (at !== -1) {
      found.push({ from: pos + 1 + at, to: pos + 1 + at + needle.length });
      at = text.indexOf(needle, at + needle.length);
    }
    return false;
  });
  return found;
};

export const findPlugin = new Plugin<FindState>({
  key: findKey,
  state: {
    init: () => ({ query: "", current: 0 }),
    apply: (tr, value) =>
      (tr.getMeta(findKey) as FindState | undefined) ?? value,
  },
  props: {
    decorations: (state) => {
      const value = findKey.getState(state);
      if (value === undefined || value.query === "") return DecorationSet.empty;
      const matches = findMatches(state.doc, value.query);
      if (matches.length === 0) return DecorationSet.empty;
      return DecorationSet.create(
        state.doc,
        matches.map((match, index) =>
          Decoration.inline(match.from, match.to, {
            class:
              index === value.current % matches.length
                ? "artifact-find-match artifact-find-current"
                : "artifact-find-match",
          }),
        ),
      );
    },
  },
});
