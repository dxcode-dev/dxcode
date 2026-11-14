import type { ThreadId } from "@dx/domain";
import {
  Bold,
  Check,
  Code,
  Copy,
  Italic,
  Link,
  MessageSquarePlus,
  SendHorizontal,
  Strikethrough,
} from "lucide-react";
import * as React from "react";
import { useMountEffect } from "../../../shared/hooks/use-mount-effect.js";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import { useThreadDraftValue } from "../../threads/thread-draft-queries.js";
import { type ArtifactScope, scopeThread } from "../artifact-scope.js";
import type { ArtifactSelection, ArtifactSession } from "./artifact-session.js";
import { type SelectionMark, withQuote } from "./selection-format.js";

const coarse = () =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
const subscribeCoarse = (listener: () => void) => {
  if (typeof matchMedia !== "function") return () => undefined;
  const query = matchMedia("(pointer: coarse)");
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
};

const mod = () =>
  typeof navigator !== "undefined" &&
  /Mac|iP(hone|ad|od)/.test(navigator.platform)
    ? "⌘"
    : "Ctrl+";

/** Buttons keep the editor's selection: a press would move focus. */
const keep = (event: React.MouseEvent) => event.preventDefault();

/** Where the toolbar goes; the stylesheet keeps it inside the page. */
const place = (top: number, center: number) =>
  ({ top, "--x": `${center}px` }) as React.CSSProperties;

const MARKS: ReadonlyArray<{
  readonly mark: SelectionMark;
  readonly label: string;
  readonly keys: string;
  readonly Icon: typeof Bold;
}> = [
  { mark: "strong", label: "Bold", keys: "B", Icon: Bold },
  { mark: "em", label: "Italic", keys: "I", Icon: Italic },
  {
    mark: "strike",
    label: "Strikethrough",
    keys: "Shift+X",
    Icon: Strikethrough,
  },
  { mark: "code", label: "Code", keys: "E", Icon: Code },
];

/**
 * The toolbar at an artifact selection (#1805): Bold, Italic, Strikethrough,
 * Code, Link, Comment, Copy as Markdown, and Send to Thread, above the
 * selected text. On a touch screen the native selection menu already copies
 * and formats nothing, so it adds only Comment, below the text, clear of
 * that menu. The parent keys it by the selection, so what it shows (an open
 * Link field, "Copied") starts afresh for each selection. Ctrl/Cmd+K in the
 * same artifact opens Link. Send to Thread shows only where a Thread
 * composer is on the page.
 */
export function SelectionToolbar({
  threadId,
  session,
  selection,
  hidden,
  sendToThread,
  onComment,
}: {
  readonly threadId: ArtifactScope;
  readonly session: ArtifactSession;
  readonly selection: ArtifactSelection;
  /** A reader who cannot edit, or a comment already being written. */
  readonly hidden: boolean;
  /** A Thread composer is on the page to quote the selection into. */
  readonly sendToThread: boolean;
  readonly onComment: () => void;
}) {
  const touch = React.useSyncExternalStore(
    subscribeCoarse,
    coarse,
    () => false,
  );
  const thread = scopeThread(threadId);
  const [linking, setLinking] = React.useState(false);
  const [status, setStatus] = React.useState<string>();
  const element = React.useRef<HTMLDivElement>(null);
  useMountEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const artifact = element.current?.closest(".artifact-view");
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k" &&
        event.target instanceof Node &&
        artifact?.contains(event.target) === true
      ) {
        event.preventDefault();
        setLinking(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  const { box, marks } = selection;
  if (hidden || !selection.ranged || box === undefined) return null;

  if (touch)
    return (
      <div
        role="toolbar"
        aria-label="Selection"
        ref={element}
        className="artifact-selection-toolbar"
        data-touch=""
        style={place(box.bottom + 10, box.center)}
      >
        <Button
          variant="subtle"
          size="xs"
          className="artifact-selection-button"
          aria-label="Comment"
          onMouseDown={keep}
          onClick={onComment}
        >
          <MessageSquarePlus aria-hidden="true" />
          <span>Comment</span>
        </Button>
      </div>
    );

  return (
    <div
      role="toolbar"
      aria-label="Selection"
      ref={element}
      className="artifact-selection-toolbar"
      style={place(box.top - 8, box.center)}
    >
      {linking ? (
        <form
          className="artifact-selection-link"
          onSubmit={(event) => {
            event.preventDefault();
            const link = String(
              new FormData(event.currentTarget).get("link") ?? "",
            );
            if (session.linkSelection(link)) {
              setLinking(false);
              setStatus(undefined);
            } else setStatus("Use a web or mail link.");
          }}
        >
          <Link aria-hidden="true" />
          <Input
            variant="bare"
            // biome-ignore lint/a11y/noAutofocus: it opens because the person asked for it
            autoFocus
            name="link"
            aria-label="Link"
            placeholder="Paste or type a link"
            defaultValue={marks?.link ?? ""}
            onKeyDown={(event) => {
              if (event.key === "Escape") setLinking(false);
            }}
          />
          <span className="artifact-selection-enter" aria-hidden="true">
            ↵
          </span>
        </form>
      ) : (
        <>
          {MARKS.map(({ mark, label, keys, Icon }) => (
            <Button
              variant="subtle"
              size="xs"
              key={mark}
              className="artifact-selection-button"
              aria-label={label}
              aria-pressed={marks?.[mark] === true}
              title={`${label} (${mod()}${keys})`}
              onMouseDown={keep}
              onClick={() => session.formatSelection(mark)}
            >
              <Icon aria-hidden="true" />
            </Button>
          ))}
          <Button
            variant="subtle"
            size="xs"
            className="artifact-selection-button"
            aria-label="Link"
            aria-pressed={marks?.link !== undefined}
            title={`Link (${mod()}K)`}
            onMouseDown={keep}
            onClick={() => setLinking(true)}
          >
            <Link aria-hidden="true" />
          </Button>
          <span className="artifact-selection-divider" aria-hidden="true" />
          <Button
            variant="subtle"
            size="xs"
            className="artifact-selection-button"
            aria-label="Comment"
            title="Comment"
            onMouseDown={keep}
            onClick={onComment}
          >
            <MessageSquarePlus aria-hidden="true" />
          </Button>
          <Button
            variant="subtle"
            size="xs"
            className="artifact-selection-button"
            aria-label="Copy as Markdown"
            title="Copy as Markdown"
            onMouseDown={keep}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  session.selectionMarkdown(),
                );
                setStatus("Copied");
              } catch {
                setStatus("Couldn't copy");
              }
            }}
          >
            <Copy aria-hidden="true" />
          </Button>
          {sendToThread && thread !== undefined ? (
            <SendToThreadButton
              threadId={thread}
              session={session}
              onSent={setStatus}
            />
          ) : null}
        </>
      )}
      {status === undefined ? null : (
        <span className="artifact-selection-status" role="status">
          {status === "Copied" ? <Check aria-hidden="true" /> : null}
          {status}
        </span>
      )}
    </div>
  );
}

/** Send to Thread: quotes the selection into the Thread's composer. */
function SendToThreadButton({
  threadId,
  session,
  onSent,
}: {
  readonly threadId: ThreadId;
  readonly session: ArtifactSession;
  readonly onSent: (status: string) => void;
}) {
  const draft = useThreadDraftValue(threadId);
  return (
    <Button
      variant="subtle"
      size="xs"
      className="artifact-selection-button"
      aria-label="Send to Thread"
      title="Send to Thread"
      onMouseDown={keep}
      onClick={() => {
        draft.set(withQuote(draft.get(), session.selectionMarkdown()));
        const composer = document.querySelector<HTMLElement>(
          '[data-command-target="thread-composer"]',
        );
        composer?.focus();
        if (composer instanceof HTMLTextAreaElement)
          composer.setSelectionRange(
            composer.value.length,
            composer.value.length,
          );
        onSent("Added to your message");
      }}
    >
      <SendHorizontal aria-hidden="true" />
    </Button>
  );
}
