import { ArrowDown } from "lucide-react";
import type * as React from "react";
import { useState } from "react";
import {
  useScrollPinnedToEnd,
  useVirtualRows,
} from "../hooks/use-virtual-rows.js";
import { cn } from "../utils.js";
import { Button } from "./button.js";
import { EmptyState } from "./empty-state.js";
import "./log-view.css";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** One line of output. `text` is drawn as plain text, never as HTML. */
export interface LogLine {
  readonly key: string;
  readonly text: string;
  /** A short timestamp shown before the text, such as "12:04:31". */
  readonly time?: string;
  /** Colors the line's marker; a line without one has none. */
  readonly level?: LogLevel;
}

/** Each row's height in px; log-view.css sets the same value. */
const ROW_HEIGHT = 20;
/** Up to this many lines, a screen reader hears new ones as they arrive. */
const LIVE_LINES = 100;

/** The widest line in characters, so the rows scroll sideways as one. */
const widestLine = (lines: ReadonlyArray<LogLine>) => {
  let widest = 0;
  for (const line of lines) {
    const width =
      line.text.length + (line.time === undefined ? 0 : line.time.length + 2);
    if (width > widest) widest = width;
  }
  return widest;
};

/**
 * Lines of output, newest at the bottom, such as a build or a plugin's
 * log. Rows are one line each at a fixed height, and only the rows in view
 * are drawn, so 10,000 lines scroll smoothly; a long line scrolls sideways.
 * With `follow` (the default) it stays on the newest line while the reader
 * is at the bottom; scrolling up stops that and shows Jump to newest.
 */
export function LogView({
  label,
  lines,
  height = 320,
  follow = true,
  empty,
  className,
}: {
  /** Names the log for assistive tech: "Build output". */
  readonly label: string;
  readonly lines: ReadonlyArray<LogLine>;
  /** Height of the scroll box in px. */
  readonly height?: number;
  /** Keep the newest line in view while the reader is at the bottom. */
  readonly follow?: boolean;
  /** What an empty log says: "No output yet." */
  readonly empty?: React.ReactNode;
  readonly className?: string;
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const totalSize = lines.length * ROW_HEIGHT;
  const { rows } = useVirtualRows({
    scrollElement: scroller,
    count: lines.length,
    rowHeight: ROW_HEIGHT,
    overscan: 12,
  });
  const following = follow && atBottom;
  useScrollPinnedToEnd(scroller, following, totalSize);
  const widest = widestLine(lines);
  const jumpToNewest = () => {
    if (scroller === null) return;
    scroller.scrollTo({ top: scroller.scrollHeight });
    scroller.focus({ preventScroll: true });
    setAtBottom(true);
  };
  return (
    <div className={cn("dx-log-view", className)}>
      <div
        ref={setScroller}
        className="dx-log-view-scroll"
        role="log"
        aria-label={label}
        aria-live={lines.length <= LIVE_LINES ? "polite" : "off"}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the log must scroll from the keyboard.
        tabIndex={0}
        style={{ height }}
        onScroll={(event) => {
          const box = event.currentTarget;
          setAtBottom(
            box.scrollHeight - box.scrollTop - box.clientHeight <=
              ROW_HEIGHT / 2,
          );
        }}
      >
        {lines.length === 0 ? (
          <EmptyState title={empty ?? "No output yet."} />
        ) : (
          <div
            className="dx-log-view-rows"
            style={{ height: totalSize, minWidth: `calc(${widest}ch + 2rem)` }}
          >
            {rows.map(({ index, start }) => {
              const line = lines[index];
              if (line === undefined) return null;
              return (
                <div
                  key={line.key}
                  className="dx-log-view-row"
                  data-level={line.level}
                  style={{ transform: `translateY(${start}px)` }}
                >
                  <span className="dx-log-view-level" data-level={line.level}>
                    {line.level === undefined ? null : (
                      <span className="dx-log-view-level-name">
                        {line.level}
                      </span>
                    )}
                  </span>
                  {line.time === undefined ? null : (
                    <span className="dx-log-view-time">{line.time}</span>
                  )}
                  <span className="dx-log-view-text">{line.text}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {follow && !atBottom && lines.length > 0 ? (
        <Button
          size="xs"
          variant="secondary"
          className="dx-log-view-jump"
          onClick={jumpToNewest}
        >
          <ArrowDown aria-hidden="true" />
          Jump to newest
        </Button>
      ) : null}
    </div>
  );
}
