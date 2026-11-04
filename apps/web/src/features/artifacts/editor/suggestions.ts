/**
 * The `/` block menu and the `@` people picker. A menu is open while the text
 * just before the caret is `/query` or `@query` at the start of a block or
 * after a space; it is worked out from the document on every change, so it
 * cannot fall out of step with what was typed. Arrows move, Enter or Tab
 * picks, and Escape closes it, keeping the typed text.
 */
import {
  type EditorState,
  Plugin,
  PluginKey,
  type Transaction,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

export type SuggestKind = "slash" | "mention";

export interface SuggestItem {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
}

/** An open menu: what it is for, where its trigger sits, and what is typed. */
export interface SuggestMatch {
  readonly kind: SuggestKind;
  /** The trigger's position; the query runs from after it to `to`. */
  readonly from: number;
  readonly to: number;
  readonly query: string;
}

interface SuggestState {
  readonly match: SuggestMatch | undefined;
  readonly active: number;
  /** A trigger Escape closed: it stays closed while the caret is after it. */
  readonly dismissed: number | undefined;
}

type SuggestMeta =
  | { readonly move: 1 | -1 }
  | { readonly select: number }
  | { readonly dismiss: true };

export interface SuggestHost {
  readonly items: (match: SuggestMatch) => ReadonlyArray<SuggestItem>;
  readonly pick: (
    view: EditorView,
    match: SuggestMatch,
    item: SuggestItem,
  ) => void;
}

export const suggestKey = new PluginKey<SuggestState>("artifactSuggest");

// The trigger at the block's start or after whitespace; a `/` inside a word
// (and/or, a URL) or an `@` inside an email address opens nothing.
const TRIGGERS: ReadonlyArray<readonly [SuggestKind, RegExp]> = [
  ["slash", /(?:^|\s)\/([^\s/]{0,24})$/],
  ["mention", /(?:^|\s)@([^\s@]{0,40})$/],
];

/** The menu the text before the caret asks for, if any. */
export const suggestMatch = (state: EditorState): SuggestMatch | undefined => {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code)
    return undefined;
  // One character per inline node, so offsets in the text are positions.
  const before = $from.parent.textBetween(
    0,
    $from.parentOffset,
    undefined,
    () => "￼",
  );
  for (const [kind, pattern] of TRIGGERS) {
    const found = pattern.exec(before);
    if (found === null) continue;
    const query = found[1] ?? "";
    const trigger = before.length - query.length - 1;
    return {
      kind,
      from: $from.start() + trigger,
      to: $from.pos,
      query,
    };
  }
  return undefined;
};

export const suggestions = (host: SuggestHost) =>
  new Plugin<SuggestState>({
    key: suggestKey,
    state: {
      init: () => ({ match: undefined, active: 0, dismissed: undefined }),
      apply: (tr: Transaction, value, _old, next) => {
        const meta = tr.getMeta(suggestKey) as SuggestMeta | undefined;
        const found = suggestMatch(next);
        const dismissed =
          meta !== undefined && "dismiss" in meta
            ? value.match?.from
            : value.dismissed === undefined
              ? undefined
              : tr.mapping.map(value.dismissed);
        if (found === undefined || found.from === dismissed)
          return {
            match: undefined,
            active: 0,
            dismissed: found === undefined ? undefined : dismissed,
          };
        const same =
          value.match?.kind === found.kind &&
          tr.mapping.map(value.match.from) === found.from;
        let active =
          same && value.match?.query === found.query ? value.active : 0;
        if (meta !== undefined && "move" in meta) {
          const count = host.items(found).length;
          active = count === 0 ? 0 : (active + meta.move + count) % count;
        }
        if (meta !== undefined && "select" in meta) active = meta.select;
        return { match: found, active, dismissed };
      },
    },
    props: {
      handleKeyDown: (view, event) => {
        const value = suggestKey.getState(view.state);
        const match = value?.match;
        if (value === undefined || match === undefined) return false;
        const items = host.items(match);
        if (event.key === "Escape") {
          // The menu's Escape: a sheet or dialog around the editor stays.
          event.stopPropagation();
          view.dispatch(view.state.tr.setMeta(suggestKey, { dismiss: true }));
          return true;
        }
        if (items.length === 0) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          view.dispatch(
            view.state.tr.setMeta(suggestKey, {
              move: event.key === "ArrowDown" ? 1 : -1,
            }),
          );
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = items[Math.min(value.active, items.length - 1)];
          if (item !== undefined) host.pick(view, match, item);
          return true;
        }
        return false;
      },
    },
  });
