import { Editor } from "@pierre/diffs/edit";
import { type EditorFactory, EditProvider } from "@pierre/diffs/react";
import * as React from "react";
import { CodeFile } from "./code-view.js";

// Pierre reads Cmd as the primary modifier on these platforms, iPhone and
// iPad included, and Ctrl+F there as "cursor right". Mirrors its isMacLike.
const isMacLike = () =>
  /macOS|MacIntel|iPhone|iPad|iPod/i.test(navigator.platform);

const primaryModifier = () =>
  isMacLike() ? { metaKey: true } : { ctrlKey: true };

const editableIn = (host: HTMLElement | null) =>
  host
    ?.querySelector("diffs-container")
    ?.shadowRoot?.querySelector<HTMLElement>('[contenteditable="true"]');

const targetOf = (event: Event) => {
  const target = event.composedPath()[0];
  return target instanceof Element ? target : null;
};

const deepFocus = () => {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement)
    element = element.shadowRoot.activeElement;
  return element;
};

/** The editor's line and character at a point, from the DOM caret there. */
const positionAtPoint = (editable: HTMLElement, x: number, y: number) => {
  const shadow = editable.getRootNode();
  if (!(shadow instanceof ShadowRoot)) return undefined;
  const caret = document.caretPositionFromPoint(x, y, {
    shadowRoots: [shadow],
  });
  const node = caret?.offsetNode;
  const element = node instanceof Element ? node : node?.parentElement;
  const line = element?.closest<HTMLElement>("[data-line]");
  if (caret == null || node == null || line == null || !editable.contains(line))
    return undefined;
  const before = document.createRange();
  before.setStart(line, 0);
  before.setEnd(node, caret.offset);
  return {
    line: Number(line.dataset.line) - 1,
    character: before.toString().length,
  };
};

const inFindPanel = (target: Element | null) =>
  target?.closest("[data-search-panel]") != null;

/**
 * Keeps typing where the person sees the caret, on touch screens as on
 * desktop (#1989). Pierre 1.4.1 leaves these gaps, closed here and, for
 * Find on an iPhone, by primaryModifier in openFind:
 * - Closing Find leaves focus on the page, so typing goes nowhere. Focus goes
 *   back to the editor at the selected match.
 * - A tap that focuses the editor puts back Pierre's last selection, such as
 *   the Find match, over the tapped caret, so the next edit lands on that
 *   old line. Its own mouse path skips that restore; a tap gets the same.
 * - Home goes to column 0. It now moves to the first non-blank, then column
 *   0, and Shift+Home extends the selection there, through Pierre's own
 *   Cmd/Ctrl+Left move, which already does that.
 */
const keepCaretWhereSeen = (host: HTMLElement, editor: () => Editor | null) => {
  const focusAfterFindCloses = (event: Event) => {
    if (!inFindPanel(targetOf(event))) return;
    const shadow = host.querySelector("diffs-container")?.shadowRoot;
    if (shadow?.querySelector("[data-search-panel]") != null) return;
    // Focusing the element, not Editor.focus, which collapses the match to
    // its start: Pierre's focus handler selects the whole match again.
    editableIn(host)?.focus({ preventScroll: true });
  };
  const onFindClosing = (event: Event) => {
    // Escape or Close, after the panel's own handler removed it.
    if (event instanceof KeyboardEvent && event.key !== "Escape") return;
    focusAfterFindCloses(event);
  };
  // A tap that focuses the editor: Pierre puts its old caret back on focus
  // and then ignores the caret the tap placed, so set the tapped one.
  let tapFocusing = false;
  const onPointerDown = (event: PointerEvent) => {
    const editable = editableIn(host);
    const target = targetOf(event);
    tapFocusing =
      event.pointerType !== "mouse" &&
      editable != null &&
      target != null &&
      editable.contains(target) &&
      deepFocus() !== editable;
  };
  const onClick = (event: MouseEvent) => {
    if (!tapFocusing) return;
    tapFocusing = false;
    const editable = editableIn(host);
    if (editable == null || deepFocus() !== editable) return;
    const position = positionAtPoint(editable, event.clientX, event.clientY);
    if (position !== undefined)
      editor()?.setSelections([
        { start: position, end: position, direction: "none" },
      ]);
  };
  const onHome = (event: KeyboardEvent) => {
    if (
      event.key !== "Home" ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.isComposing
    )
      return;
    const editable = editableIn(host);
    if (editable == null || targetOf(event) !== editable) return;
    event.preventDefault();
    event.stopPropagation();
    editable.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        code: "ArrowLeft",
        shiftKey: event.shiftKey,
        ...primaryModifier(),
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
  };
  host.addEventListener("keydown", onHome, true);
  host.addEventListener("keydown", onFindClosing);
  host.addEventListener("click", onFindClosing);
  host.addEventListener("pointerdown", onPointerDown, true);
  host.addEventListener("click", onClick, true);
  return () => {
    host.removeEventListener("keydown", onHome, true);
    host.removeEventListener("keydown", onFindClosing);
    host.removeEventListener("click", onFindClosing);
    host.removeEventListener("pointerdown", onPointerDown, true);
    host.removeEventListener("click", onClick, true);
  };
};

export interface CodeEditorHandle {
  readonly openFind: () => void;
}

/**
 * A text file in the diffs editor with dx's code theme: the Files pane's
 * editor, shared. It owns the live document and its history; `onChange`
 * reports each edit, and a new `key` reloads it. `onHost` gets the element
 * the editor sits in, for callers that scroll or measure inside it. Import
 * it only from lazily loaded modules, as the diff library loads.
 */
export const CodeEditor = React.forwardRef<
  CodeEditorHandle,
  {
    readonly path: string;
    readonly content: string;
    readonly wrap: boolean;
    readonly onChange: (content: string) => void;
    readonly onReadyChange?: (ready: boolean) => void;
    /** Lines to highlight, such as the chunk an agent edit wrote. */
    readonly selectedLines?: { readonly start: number; readonly end: number };
    readonly className?: string;
    readonly onHost?: (host: HTMLDivElement | null) => void;
    readonly children?: React.ReactNode;
  }
>(function CodeEditor(
  {
    path,
    content,
    wrap,
    onChange,
    onReadyChange,
    selectedLines,
    className,
    onHost,
    children,
  },
  forwardedRef,
) {
  const host = React.useRef<HTMLDivElement>(null);
  const editor = React.useRef<Editor | null>(null);
  const [createEditor] = React.useState(
    (): EditorFactory<undefined, undefined> => (type, options, key) => {
      const created = new Editor(type, options, key);
      editor.current = created;
      return created;
    },
  );
  const attach = (node: HTMLDivElement | null) => {
    host.current = node;
    onHost?.(node);
    if (node === null) return;
    const detach = keepCaretWhereSeen(node, () => editor.current);
    return () => {
      detach();
      host.current = null;
    };
  };
  // Pierre owns the live document and history. Never feed keystrokes back as
  // external file updates. An explicit Reload remounts this editor.
  const [file] = React.useState(() => ({ name: path, contents: content }));
  React.useImperativeHandle(
    forwardedRef,
    () => ({
      openFind: () => {
        // Diffs 1.4.1 has no public openFind handle. Its own Find demo uses the
        // keyboard command on the shadow-root editor. Keep that adapter here.
        const input = editableIn(host.current);
        input?.focus();
        input?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "f",
            code: "KeyF",
            ...primaryModifier(),
            bubbles: true,
            composed: true,
          }),
        );
      },
    }),
    [],
  );

  return (
    <div className={className ?? "dx-code-editor"} ref={attach}>
      <EditProvider createEditor={createEditor}>
        <CodeFile
          file={file}
          edit
          selectedLines={selectedLines ?? null}
          options={{
            disableFileHeader: true,
            overflow: wrap ? "wrap" : "scroll",
            onPostRender: (node) =>
              onReadyChange?.(
                node.shadowRoot?.querySelector('[contenteditable="true"]') !=
                  null,
              ),
          }}
          onEditChange={(event) => onChange(event.file.contents)}
        />
      </EditProvider>
      {children}
    </div>
  );
});
