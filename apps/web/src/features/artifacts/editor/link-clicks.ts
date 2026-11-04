import type { EditorView } from "prosemirror-view";

/**
 * The href a click opens: a primary click on a link in the editor, plain or
 * with Cmd or Ctrl, and from a mouse or a tap, while nothing is selected.
 * A drag that selects text and a Shift click that extends the selection
 * keep editing. Only safe links render an href (`artifact-markdown.ts`).
 * Handled here rather than left to the browser, which follows no link in
 * editable text and whose table plugin swallows the click in a cell.
 */
export const linkToOpen = (view: EditorView, event: MouseEvent) => {
  if (event.button !== 0 || event.shiftKey || event.altKey) return undefined;
  const anchor =
    event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (anchor === null || !view.dom.contains(anchor)) return undefined;
  if (!modified(event) && !view.state.selection.empty) return undefined;
  return anchor.getAttribute("href") ?? undefined;
};

const modified = (event: MouseEvent) => event.metaKey || event.ctrlKey;

/** Opens a link from the editor in a new tab, as links open elsewhere. */
export const linkClickProps = {
  handleDOMEvents: {
    // ProseMirror takes a Cmd or Ctrl press for selecting the block it lands
    // in; on a link that press is the start of opening it.
    mousedown: (view: EditorView, event: MouseEvent) =>
      modified(event) && linkToOpen(view, event) !== undefined,
    click: (view: EditorView, event: MouseEvent) => {
      const href = linkToOpen(view, event);
      if (href === undefined) return false;
      event.preventDefault();
      window.open(href, "_blank", "noopener,noreferrer");
      return true;
    },
  },
};
