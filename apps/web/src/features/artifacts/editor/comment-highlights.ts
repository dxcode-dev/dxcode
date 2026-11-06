/**
 * Highlights the text each open comment sits on, mapped through edits until
 * the comments are read again, and the comment chosen in the panel.
 */
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

export interface CommentRange {
  readonly id: string;
  readonly from: number;
  readonly to: number;
}

interface Highlights {
  readonly ranges: ReadonlyArray<CommentRange>;
  readonly active: string | undefined;
  /** The text a comment is being written on, before it is saved. */
  readonly draft: { readonly from: number; readonly to: number } | undefined;
}

type HighlightsMeta =
  | { readonly ranges: ReadonlyArray<CommentRange> }
  | { readonly active: string | undefined }
  | { readonly draft: Highlights["draft"] };

/** The `data-comment` of the text a new comment is being written on. */
export const DRAFT_COMMENT = "draft";

export const commentHighlightsKey = new PluginKey<Highlights>(
  "artifactCommentHighlights",
);

export const commentHighlights = new Plugin<Highlights>({
  key: commentHighlightsKey,
  state: {
    init: () => ({ ranges: [], active: undefined, draft: undefined }),
    apply: (tr, value) => {
      const meta = tr.getMeta(commentHighlightsKey) as
        | HighlightsMeta
        | undefined;
      let next = value;
      if (tr.docChanged)
        next = {
          ...next,
          ranges: next.ranges.flatMap((range) => {
            const from = tr.mapping.map(range.from, 1);
            const to = tr.mapping.map(range.to, -1);
            return from < to ? [{ ...range, from, to }] : [];
          }),
          draft:
            next.draft === undefined
              ? undefined
              : {
                  from: tr.mapping.map(next.draft.from, 1),
                  to: tr.mapping.map(next.draft.to, -1),
                },
        };
      if (meta !== undefined) next = { ...next, ...meta };
      return next;
    },
  },
  props: {
    decorations: (state) => {
      const value = commentHighlightsKey.getState(state);
      if (
        value === undefined ||
        (value.ranges.length === 0 && value.draft === undefined)
      )
        return DecorationSet.empty;
      const draft =
        value.draft === undefined || value.draft.from >= value.draft.to
          ? []
          : [
              Decoration.inline(value.draft.from, value.draft.to, {
                class: "artifact-comment-anchor artifact-comment-anchor-active",
                "data-comment": DRAFT_COMMENT,
              }),
            ];
      return DecorationSet.create(state.doc, [
        ...value.ranges.map((range) =>
          Decoration.inline(range.from, range.to, {
            class:
              range.id === value.active
                ? "artifact-comment-anchor artifact-comment-anchor-active"
                : "artifact-comment-anchor",
            "data-comment": range.id,
          }),
        ),
        ...draft,
      ]);
    },
  },
});

/** The comment whose highlighted text holds `pos`, if any. */
export const commentAt = (
  ranges: ReadonlyArray<CommentRange>,
  pos: number,
): string | undefined =>
  ranges.find((range) => range.from <= pos && pos < range.to)?.id;
