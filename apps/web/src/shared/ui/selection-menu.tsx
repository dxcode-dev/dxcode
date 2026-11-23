import * as React from "react";
import { createPortal } from "react-dom";
import { useMountEffect } from "../hooks/use-mount-effect.js";
import type {
  SelectionMenuAction,
  SelectionSurface,
  TextSelection,
} from "./selection-actions.js";
import { toMarkdown } from "./selection-markdown.js";
import { placeSelectionMenu, type ViewportBox } from "./selection-placement.js";
import "./selection-menu.css";

const elementOf = (node: Node) =>
  node instanceof Element ? node : node.parentElement;

const boxOf = ({ top, bottom, left, right }: ViewportBox): ViewportBox => ({
  top,
  bottom,
  left,
  right,
});

/** The visible screen: smaller than the window while a phone's keyboard shows. */
const screenBox = (): ViewportBox => {
  const visual = window.visualViewport;
  if (visual === null)
    return {
      top: 0,
      left: 0,
      bottom: window.innerHeight,
      right: window.innerWidth,
    };
  return {
    top: visual.offsetTop,
    left: visual.offsetLeft,
    bottom: visual.offsetTop + visual.height,
    right: visual.offsetLeft + visual.width,
  };
};

const overlap = (a: ViewportBox, b: ViewportBox): ViewportBox => ({
  top: Math.max(a.top, b.top),
  bottom: Math.min(a.bottom, b.bottom),
  left: Math.max(a.left, b.left),
  right: Math.min(a.right, b.right),
});

/** The message the selection lies in, or nothing when it spans two. */
const readSelection = (
  surface: SelectionSurface,
): TextSelection | undefined => {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0)
    return undefined;
  const text = selection.toString();
  if (text.trim() === "") return undefined;
  const range = selection.getRangeAt(0);
  const start = elementOf(range.startContainer);
  const region = start?.closest(surface.region);
  const content = start?.closest(surface.content);
  if (
    region === null ||
    region === undefined ||
    content === null ||
    content === undefined ||
    !region.contains(content) ||
    content !== elementOf(range.endContainer)?.closest(surface.content)
  )
    return undefined;
  const message = content.closest<HTMLElement>(surface.message);
  if (message === null || !region.contains(message)) return undefined;
  const markdown = surface.markdown?.(message, content) ?? false;
  const screen = screenBox();
  let bounds = overlap(boxOf(region.getBoundingClientRect()), screen);
  const floating =
    surface.floating === undefined
      ? null
      : (region.parentElement?.querySelector(surface.floating) ?? null);
  const over = floating?.getBoundingClientRect();
  if (over !== undefined && over.height > 0 && over.top < bounds.bottom)
    bounds = { ...bounds, bottom: Math.max(bounds.top, over.top) };
  return {
    message,
    text,
    markdown: markdown
      ? toMarkdown(range.cloneContents())
          .replace(/\n{3,}/g, "\n\n")
          .trim()
      : text,
    range: range.cloneRange(),
    box: boxOf(range.getBoundingClientRect()),
    bounds,
    screen,
  };
};

const sameBox = (a: ViewportBox, b: ViewportBox) =>
  a.top === b.top &&
  a.bottom === b.bottom &&
  a.left === b.left &&
  a.right === b.right;

const sameSelection = (a?: TextSelection, b?: TextSelection) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.message === b.message &&
    a.text === b.text &&
    sameBox(a.box, b.box) &&
    sameBox(a.bounds, b.bounds));

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable='true']") !==
      null);

const COARSE = "(hover: none)";
const subscribeCoarse = (notify: () => void) => {
  const query = window.matchMedia(COARSE);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};
const coarsePointer = () => window.matchMedia(COARSE).matches;

const BUTTON = { mouse: 28, touch: 44 } as const;
/** The menu's padding and border around its buttons. */
const FRAME = { width: 12, height: 8 } as const;

/**
 * The toolbar at text selected in a message: a Thread's transcript, a
 * Space's posts, or a post's comments. Each surface gives its own actions,
 * such as Reply and Comment, usually with Copy as Markdown and Copy with
 * Styling (`selectionCopyActions`); each has a one-key shortcut while the
 * menu shows.
 *
 * It never covers the device's own menu. A right-click hides it until the
 * selection changes. On a touch screen it keeps clear of the phone's menu
 * (see `placeSelectionMenu`), and leaves out the copy actions, which the
 * phone's menu already has.
 */
export function SelectionMenu({
  surface,
  actions,
  pointer,
}: {
  readonly surface: SelectionSurface;
  /** The buttons for a selection, in order. */
  readonly actions: (
    selection: TextSelection,
  ) => ReadonlyArray<SelectionMenuAction>;
  /** Stories set it; absent, the device decides. */
  readonly pointer?: "mouse" | "touch";
}) {
  const [selected, setSelected] = React.useState<TextSelection>();
  // A right-click's menu is open over this selection.
  const [hiddenFor, setHiddenFor] = React.useState<TextSelection>();
  const deviceTouch = React.useSyncExternalStore(
    subscribeCoarse,
    coarsePointer,
    () => false,
  );
  const touch = pointer === undefined ? deviceTouch : pointer === "touch";
  const buttons =
    selected === undefined
      ? []
      : actions(selected).filter(({ copies }) => !(touch && copies === true));

  // Read in listeners, which see the latest render's buttons and surface.
  const latest = React.useRef({ buttons, surface, touch });
  const keepLatest = (node: HTMLDivElement | null) => {
    if (node !== null) latest.current = { buttons, surface, touch };
  };

  useMountEffect(() => {
    let frame = 0;
    // The message holding a text selection hides its ⋯.
    let marked: Element | undefined;
    const mark = (next: Element | undefined) => {
      if (next === marked) return;
      marked?.removeAttribute("data-text-selected");
      next?.setAttribute("data-text-selected", "");
      marked = next;
    };
    const read = () => readSelection(latest.current.surface);
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = read();
        mark(next?.message);
        if (next === undefined) setHiddenFor(undefined);
        setSelected((current) =>
          sameSelection(current, next) ? current : next,
        );
      });
    };
    // Escape clears the text selection first; the message stays selected.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || read() === undefined) return;
      event.stopPropagation();
      window.getSelection()?.removeAllRanges();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat)
        return;
      if (isEditable(event.target) || read() === undefined) return;
      const button = latest.current.buttons.find(
        ({ key }) => key === event.key.toLowerCase(),
      );
      if (button === undefined) return;
      event.preventDefault();
      button.run();
    };
    // The browser's own menu opens at the pointer, over or under the
    // toolbar; the toolbar steps aside until the selection changes. A long
    // press on a phone selects text and reports a context menu too, and
    // there the toolbar is the only way to reply.
    const onContextMenu = (event: MouseEvent) => {
      if (latest.current.touch) return;
      if ("pointerType" in event && event.pointerType === "touch") return;
      const current = read();
      if (current !== undefined) setHiddenFor(current);
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keydown", onEscape, { capture: true });
    document.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("scroll", update, { capture: true, passive: true });
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keydown", onEscape, { capture: true });
      document.removeEventListener("contextmenu", onContextMenu);
      mark(undefined);
      window.removeEventListener("scroll", update, { capture: true });
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  });

  if (
    selected === undefined ||
    buttons.length === 0 ||
    (hiddenFor !== undefined &&
      hiddenFor.message === selected.message &&
      hiddenFor.text === selected.text)
  )
    return null;
  const button = touch ? BUTTON.touch : BUTTON.mouse;
  const { top, left } = placeSelectionMenu({
    selection: selected.box,
    size: {
      width: buttons.length * button + FRAME.width,
      height: button + FRAME.height,
    },
    bounds: selected.bounds,
    screen: selected.screen,
    touch,
  });
  return createPortal(
    <SelectionMenuBar
      ref={keepLatest}
      buttons={buttons}
      touch={touch}
      style={{ top, left }}
    />,
    document.body,
  );
}

/**
 * The menu's row of buttons, placed by `style`. `SelectionMenu` places it
 * at the selection; Storybook's grid shows it in place.
 */
export function SelectionMenuBar({
  buttons,
  touch,
  style,
  ref,
}: {
  readonly buttons: ReadonlyArray<SelectionMenuAction>;
  /** A touch screen's bigger buttons. */
  readonly touch: boolean;
  readonly style?: React.CSSProperties;
  readonly ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      className="selection-menu"
      role="toolbar"
      aria-label="Selection"
      data-touch={touch ? "" : undefined}
      style={style}
    >
      {buttons.map(({ key, label, Icon, run }) => (
        <button
          key={key}
          type="button"
          className="selection-menu-button"
          aria-label={label}
          aria-keyshortcuts={key}
          title={`${label} (${key})`}
          // Pressing a button must not clear the selection it acts on.
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={run}
        >
          <Icon aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
