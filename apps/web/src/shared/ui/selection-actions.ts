import { ClipboardType, Copy, type LucideIcon } from "lucide-react";
import { copyText, copyWithStyling } from "../copy-text.js";
import type { ViewportBox } from "./selection-placement.js";

/** Text selected inside one message. */
export interface TextSelection {
  /** The element `message` matched: the message, post, or comment. */
  readonly message: HTMLElement;
  /**
   * The selection as it was, since tapping a button on a phone can clear
   * the page's selection before the button acts.
   */
  readonly text: string;
  /** Markdown when the message is rendered Markdown, else `text`. */
  readonly markdown: string;
  readonly range: Range;
  readonly box: ViewportBox;
  /** The area of messages, on screen, which the menu stays inside. */
  readonly bounds: ViewportBox;
  readonly screen: ViewportBox;
}

export interface SelectionMenuAction {
  /** The one-key shortcut while the menu shows, such as `r` for Reply. */
  readonly key: string;
  readonly label: string;
  readonly Icon: LucideIcon;
  readonly run: () => void;
  /** Left out on a touch screen, whose own selection menu copies. */
  readonly copies?: boolean;
}

/** Where people select text, as CSS selectors. */
export interface SelectionSurface {
  /** The scrolled area of messages, such as `.transcript-viewport`. */
  readonly region: string;
  /** One message in it, such as `article[data-row-kind]`. */
  readonly message: string;
  /** A message's text; a selection must start and end in the same one. */
  readonly content: string;
  /** Whether a message's text is rendered Markdown, copied as Markdown. */
  readonly markdown?: (message: HTMLElement, content: Element) => boolean;
  /**
   * What floats over the area's bottom beside it, such as the Thread's
   * composer; the menu stays above it.
   */
  readonly floating?: string;
}

/** `> ` before each line, and a line to write on below. */
export const quoteSelection = (text: string) =>
  `${text
    .replace(/\s+$/, "")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}\n`;

/** A draft with a quote added under what was typed, as Reply writes it. */
export const appendQuote = (draft: string, quote: string) =>
  draft.trim() === "" ? quote : `${draft.replace(/\s*$/, "")}\n\n${quote}`;

/** Copy as Markdown and Copy with Styling, for a selection. */
export const selectionCopyActions = (
  selection: TextSelection,
): ReadonlyArray<SelectionMenuAction> => [
  {
    key: "c",
    label: "Copy as Markdown",
    Icon: Copy,
    copies: true,
    run: () => void copyText(selection.markdown, "Selection"),
  },
  {
    key: "s",
    label: "Copy with Styling",
    Icon: ClipboardType,
    copies: true,
    run: () =>
      void copyWithStyling(
        selection.range.cloneContents(),
        selection.text,
        "Selection",
      ),
  },
];
