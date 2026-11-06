import { ClipboardType, Copy, Link2, Mic, Reply } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { useMountEffect } from "../../shared/hooks/use-mount-effect.js";
import { copyText, copyWithStyling } from "./message-copy.js";
import { isMessageLinkId, messageLinkUrl } from "./message-link.js";

/** Puts the selection into the composer as a quote, optionally dictating. */
export type TranscriptReply = (quote: string, dictate: boolean) => void;

interface SelectedText {
  readonly rowId: string;
  /** People write plain text; the agent writes Markdown. */
  readonly agent: boolean;
  readonly top: number;
  readonly bottom: number;
  readonly center: number;
  /**
   * The selection as it was, since tapping a button on a phone can clear
   * the page's selection before the button acts.
   */
  readonly text: string;
  readonly range: Range;
}

const MESSAGE_KINDS = new Set([
  "user-prompt",
  "assistant-prose",
  "final-answer",
]);
const POPUP_HEIGHT = 36;

const elementOf = (node: Node) =>
  node instanceof Element ? node : node.parentElement;

/** The message the selection lies in, or nothing when it spans two. */
const readSelection = (): SelectedText | undefined => {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0)
    return undefined;
  if (selection.toString().trim() === "") return undefined;
  const range = selection.getRangeAt(0);
  const content = elementOf(range.startContainer)?.closest(
    ".transcript-viewport .message-content",
  );
  if (
    content === null ||
    content === undefined ||
    content !== elementOf(range.endContainer)?.closest(".message-content")
  )
    return undefined;
  const message = content.closest<HTMLElement>("article[data-row-kind]");
  const kind = message?.dataset.rowKind;
  const rowId = message?.dataset.rowId;
  if (kind === undefined || rowId === undefined || !MESSAGE_KINDS.has(kind))
    return undefined;
  const rect = range.getBoundingClientRect();
  return {
    rowId,
    agent: kind !== "user-prompt",
    top: rect.top,
    bottom: rect.bottom,
    center: rect.left + rect.width / 2,
    text: selection.toString(),
    range: range.cloneRange(),
  };
};

const sameSelection = (a?: SelectedText, b?: SelectedText) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.rowId === b.rowId &&
    a.top === b.top &&
    a.bottom === b.bottom &&
    a.center === b.center &&
    a.text === b.text);

/** Markdown for a fragment of a rendered reply. */
const toMarkdown = (
  node: Node,
  list?: { ordered: boolean; index: number },
): string => {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element) && !(node instanceof DocumentFragment))
    return "";
  const children = (within = list) =>
    [...node.childNodes].map((child) => toMarkdown(child, within)).join("");
  if (node instanceof DocumentFragment) return children();
  if (node.matches("button, [aria-hidden='true']")) return "";
  switch (node.tagName) {
    case "STRONG":
    case "B":
      return `**${children()}**`;
    case "EM":
    case "I":
      return `*${children()}*`;
    case "DEL":
    case "S":
      return `~~${children()}~~`;
    case "CODE":
      return node.closest("pre") === null
        ? `\`${node.textContent ?? ""}\``
        : (node.textContent ?? "");
    case "PRE":
      return `\n\`\`\`\n${(node.textContent ?? "").replace(/\n$/, "")}\n\`\`\`\n\n`;
    case "A": {
      const href = node.getAttribute("href");
      return href === null ? children() : `[${children()}](${href})`;
    }
    case "BR":
      return "\n";
    case "P":
      return `${children()}\n\n`;
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return `${"#".repeat(Number(node.tagName[1]))} ${children()}\n\n`;
    case "BLOCKQUOTE":
      return `${children()
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
    case "UL":
    case "OL":
      return `${[...node.children]
        .map((item, index) =>
          toMarkdown(item, { ordered: node.tagName === "OL", index }),
        )
        .join("")}\n`;
    case "LI":
      return `${list?.ordered ? `${list.index + 1}.` : "-"} ${children(undefined).trim()}\n`;
    default:
      return children();
  }
};

const selectedMarkdown = ({ agent, text, range }: SelectedText) =>
  agent
    ? toMarkdown(range.cloneContents())
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    : text;

/** `> ` before each line, and a line to write on below. */
const quoted = (text: string) =>
  `${text
    .replace(/\s+$/, "")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}\n`;

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable='true']") !==
      null);

/**
 * The toolbar under a selection in a message: Reply, Reply with dictation,
 * Copy as Markdown, Copy with Styling, and Copy Highlighted Link, each with
 * a one-key shortcut while it shows.
 */
export function TranscriptSelectionPopup({
  onReply,
  canDictate,
}: {
  /** Absent where nobody can write, such as an archived Thread. */
  readonly onReply?: TranscriptReply;
  readonly canDictate: boolean;
}) {
  const [selected, setSelected] = React.useState<SelectedText>();
  const touch = React.useSyncExternalStore(
    subscribeCoarse,
    coarsePointer,
    () => false,
  );

  const actions = {
    reply: (dictate: boolean) => {
      if (onReply === undefined || selected === undefined) return;
      window.getSelection()?.removeAllRanges();
      setSelected(undefined);
      onReply(quoted(selected.text), dictate);
    },
    markdown: () => {
      if (selected === undefined) return;
      void copyText(selectedMarkdown(selected), "Selection");
    },
    styling: () => {
      if (selected === undefined) return;
      void copyWithStyling(
        selected.range.cloneContents(),
        selected.text,
        "Selection",
      );
    },
    link: () => {
      const url =
        selected === undefined ? undefined : messageLinkUrl(selected.rowId);
      if (url !== undefined) void copyText(url, "Link");
    },
  };
  const buttons = [
    ...(onReply === undefined
      ? []
      : [
          {
            key: "r",
            label: "Reply",
            Icon: Reply,
            run: () => actions.reply(false),
          },
          ...(canDictate
            ? [
                {
                  key: "d",
                  label: "Reply with dictation",
                  Icon: Mic,
                  run: () => actions.reply(true),
                },
              ]
            : []),
        ]),
    { key: "c", label: "Copy as Markdown", Icon: Copy, run: actions.markdown },
    {
      key: "s",
      label: "Copy with Styling",
      Icon: ClipboardType,
      run: actions.styling,
    },
    ...(selected !== undefined &&
    isMessageLinkId(selected.rowId) &&
    messageLinkUrl(selected.rowId) !== undefined
      ? [
          {
            key: "l",
            label: "Copy Highlighted Link",
            Icon: Link2,
            run: actions.link,
          },
        ]
      : []),
  ];

  // Read in listeners, which see the latest render's buttons.
  const latest = React.useRef(buttons);
  const keepLatest = (node: HTMLDivElement | null) => {
    if (node !== null) latest.current = buttons;
  };

  useMountEffect(() => {
    let frame = 0;
    // The message holding a text selection hides its ⋯, as the reference.
    let marked: Element | undefined;
    const mark = (rowId: string | undefined) => {
      const next =
        rowId === undefined
          ? undefined
          : (document.getElementById(rowId) ?? undefined);
      if (next === marked) return;
      marked?.removeAttribute("data-text-selected");
      next?.setAttribute("data-text-selected", "");
      marked = next;
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = readSelection();
        mark(next?.rowId);
        setSelected((current) =>
          sameSelection(current, next) ? current : next,
        );
      });
    };
    // Escape clears the text selection first; the message stays selected.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || readSelection() === undefined) return;
      event.stopPropagation();
      window.getSelection()?.removeAllRanges();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat)
        return;
      if (isEditable(event.target) || readSelection() === undefined) return;
      const button = latest.current.find(
        ({ key }) => key === event.key.toLowerCase(),
      );
      if (button === undefined) return;
      event.preventDefault();
      button.run();
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keydown", onEscape, { capture: true });
    window.addEventListener("scroll", update, { capture: true, passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keydown", onEscape, { capture: true });
      mark(undefined);
      window.removeEventListener("scroll", update, { capture: true });
      window.removeEventListener("resize", update);
    };
  });

  if (selected === undefined) return null;
  const width = buttons.length * 28 + 10;
  // Under the selection; on touch, below the browser's own selection
  // handles; above it when there is no room below.
  const below = selected.bottom + (touch ? 40 : 6);
  const top =
    below + POPUP_HEIGHT > window.innerHeight - 8
      ? Math.max(8, selected.top - POPUP_HEIGHT - 6)
      : below;
  const left = Math.min(
    Math.max(8, selected.center - width / 2),
    window.innerWidth - width - 8,
  );
  return createPortal(
    <div
      ref={keepLatest}
      className="transcript-selection-popup"
      role="toolbar"
      aria-label="Selection"
      style={{ top, left }}
    >
      {buttons.map(({ key, label, Icon, run }) => (
        <button
          key={key}
          type="button"
          className="transcript-selection-button"
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
    </div>,
    document.body,
  );
}

const COARSE = "(hover: none)";
const subscribeCoarse = (notify: () => void) => {
  const query = window.matchMedia(COARSE);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};
const coarsePointer = () => window.matchMedia(COARSE).matches;
