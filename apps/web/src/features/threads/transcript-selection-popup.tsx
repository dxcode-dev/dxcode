import { Link2, Mic, Reply } from "lucide-react";
import {
  quoteSelection,
  type SelectionMenuAction,
  type SelectionSurface,
  selectionCopyActions,
} from "../../shared/ui/selection-actions.js";
import { SelectionMenu } from "../../shared/ui/selection-menu.js";
import { copyText } from "./message-copy.js";
import { isMessageLinkId, messageLinkUrl } from "./message-link.js";

/** Puts the selection into the composer as a quote, optionally dictating. */
export type TranscriptReply = (quote: string, dictate: boolean) => void;

const TRANSCRIPT: SelectionSurface = {
  region: ".transcript-viewport",
  // What people and the agent wrote, not its work.
  message: ["user-prompt", "assistant-prose", "final-answer"]
    .map((kind) => `article[data-row-kind="${kind}"]`)
    .join(", "),
  content: ".message-content",
  // People write plain text; the agent writes Markdown.
  markdown: (message) => message.dataset.rowKind !== "user-prompt",
  // The composer floats over the transcript's last lines.
  floating: ".agent-composer-dock",
};

/**
 * The toolbar under a selection in a message: Reply, Reply with dictation,
 * Copy as Markdown, Copy with Styling, and Copy Highlighted Link.
 */
export function TranscriptSelectionPopup({
  onReply,
  canDictate,
}: {
  /** Absent where nobody can write, such as an archived Thread. */
  readonly onReply?: TranscriptReply;
  readonly canDictate: boolean;
}) {
  return (
    <SelectionMenu
      surface={TRANSCRIPT}
      actions={(selection): ReadonlyArray<SelectionMenuAction> => {
        const rowId = selection.message.dataset.rowId ?? "";
        const reply = (dictate: boolean) => {
          window.getSelection()?.removeAllRanges();
          onReply?.(quoteSelection(selection.text), dictate);
        };
        const link = isMessageLinkId(rowId) ? messageLinkUrl(rowId) : undefined;
        return [
          ...(onReply === undefined
            ? []
            : [
                {
                  key: "r",
                  label: "Reply",
                  Icon: Reply,
                  run: () => reply(false),
                },
              ]),
          ...(onReply !== undefined && canDictate
            ? [
                {
                  key: "d",
                  label: "Reply with dictation",
                  Icon: Mic,
                  run: () => reply(true),
                },
              ]
            : []),
          ...selectionCopyActions(selection),
          ...(link === undefined
            ? []
            : [
                {
                  key: "l",
                  label: "Copy Highlighted Link",
                  Icon: Link2,
                  run: () => void copyText(link, "Link"),
                },
              ]),
        ];
      }}
    />
  );
}
