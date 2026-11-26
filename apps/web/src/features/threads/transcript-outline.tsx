import {
  promptOutlineLabel,
  type TranscriptOutlineAnchor,
  type TranscriptRowId,
} from "@dx/client";
import type { FlueConversationPrompt } from "@flue/react";
import { List } from "lucide-react";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/ui/menu.js";

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const dayTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A prompt from today shows its time; an older one, its day too. */
const formatPromptTime = (timestamp: string) => {
  const date = new Date(timestamp);
  return date.toDateString() === new Date().toDateString()
    ? timeFormatter.format(date)
    : dayTimeFormatter.format(date);
};

/**
 * One outline row: a prompt the transcript has loaded (`anchor`), or one
 * only the Thread's prompt list knows, which `cursor` opens history at.
 */
export interface TranscriptOutlineEntry {
  readonly key: string;
  readonly label: string;
  readonly timestamp?: string;
  readonly anchor?: TranscriptOutlineAnchor;
  readonly prompt?: FlueConversationPrompt;
}

/**
 * The Thread's prompts, oldest first: every prompt in its prompt list, with
 * the loaded ones taking their row from the transcript, then prompts loaded
 * since the list was read, such as one just sent.
 */
const transcriptOutlineEntries = (
  anchors: ReadonlyArray<TranscriptOutlineAnchor>,
  prompts: ReadonlyArray<FlueConversationPrompt> | undefined,
): ReadonlyArray<TranscriptOutlineEntry> => {
  const fromAnchor = (anchor: TranscriptOutlineAnchor) => ({
    key: anchor.id,
    label: anchor.label,
    ...(anchor.timestamp ? { timestamp: anchor.timestamp } : {}),
    anchor,
  });
  if (prompts === undefined) return anchors.map(fromAnchor);
  const loaded = new Map(anchors.map((anchor) => [anchor.messageId, anchor]));
  const listed = new Set<string>();
  const entries: TranscriptOutlineEntry[] = [];
  for (const prompt of prompts) {
    listed.add(prompt.id);
    const anchor = loaded.get(prompt.id);
    if (anchor !== undefined) {
      entries.push({ ...fromAnchor(anchor), prompt });
      continue;
    }
    const label = promptOutlineLabel(prompt.text);
    // A prompt of only images has no prompt row to open at.
    if (label === "" && !prompt.text.includes("<dx_attachments")) continue;
    entries.push({
      key: `outline:${prompt.id}`,
      label,
      ...(prompt.timestamp ? { timestamp: prompt.timestamp } : {}),
      prompt,
    });
  }
  for (const anchor of anchors)
    if (!listed.has(anchor.messageId)) entries.push(fromAnchor(anchor));
  return entries;
};

interface TranscriptOutlineProps {
  readonly anchors: ReadonlyArray<TranscriptOutlineAnchor>;
  /** The Thread's full prompt list, once read; absent before. */
  readonly prompts?: ReadonlyArray<FlueConversationPrompt>;
  /** The Thread has prompts the transcript has not loaded. */
  readonly hasUnloaded?: boolean;
  readonly visibleRowIds: ReadonlySet<TranscriptRowId>;
  readonly onNavigate: (entry: TranscriptOutlineEntry) => void;
  readonly onOpen: () => void;
}

const currentItemRef = (element: HTMLElement | null) => {
  if (element === null) return;
  requestAnimationFrame(() => element.scrollIntoView?.({ block: "start" }));
};

/**
 * The outline changes when a prompt is added, scrolls into view, or the
 * prompt list arrives, not when a reply streams: the transcript keeps its
 * anchors and handlers stable.
 */
export function TranscriptOutline({
  anchors,
  prompts,
  hasUnloaded = false,
  visibleRowIds,
  onNavigate,
  onOpen,
}: TranscriptOutlineProps) {
  const entries = transcriptOutlineEntries(anchors, prompts);
  const currentRowId = anchors.find((anchor) =>
    visibleRowIds.has(anchor.rowId),
  )?.rowId;
  if (entries.length <= 1 && !hasUnloaded) return null;

  return (
    <MenuRoot onOpenChange={(open) => (open ? onOpen() : undefined)}>
      <MenuTrigger
        className={buttonVariants({
          variant: "subtle",
          size: "icon-sm",
          className: "transcript-control",
        })}
        aria-label="Prompt outline"
      >
        <List />
      </MenuTrigger>
      <MenuPopup
        side="top"
        align="end"
        sideOffset={6}
        positionerClassName="transcript-outline-positioner"
        className="transcript-outline-menu"
        aria-label="Prompt outline"
      >
        {entries.map((entry) => {
          const rowId = entry.anchor?.rowId;
          return (
            <MenuItem
              className="transcript-outline-item"
              data-visible={
                rowId !== undefined && visibleRowIds.has(rowId) ? "" : undefined
              }
              data-loaded={entry.anchor === undefined ? undefined : ""}
              aria-current={
                rowId !== undefined && rowId === currentRowId
                  ? "location"
                  : undefined
              }
              ref={
                rowId !== undefined && rowId === currentRowId
                  ? currentItemRef
                  : undefined
              }
              key={entry.key}
              onClick={() => onNavigate(entry)}
            >
              <span>{entry.label}</span>
              {entry.timestamp ? (
                <time className="dx-menu-hint" dateTime={entry.timestamp}>
                  {formatPromptTime(entry.timestamp)}
                </time>
              ) : null}
            </MenuItem>
          );
        })}
      </MenuPopup>
    </MenuRoot>
  );
}
