import type { MacDesktopWindow } from "@dx/api";
import {
  AppWindow,
  ChevronDown,
  ChevronUp,
  Eye,
  Keyboard,
  LoaderCircle,
  Monitor,
} from "lucide-react";
import type * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { Chip } from "../../shared/ui/chip.js";
import type { StreamedWindow } from "./voxl/protocol.js";
import "./desktop-apps.css";
import "./desktop-window-picker.css";

// Window mode on a Mac runner's Desktop: instead of the whole screen, the
// viewer streams one of the Mac's windows (an iOS Simulator, an Android
// emulator). The Desktop opens view-only, since it shows a real Mac someone
// may be using (maybe the very Mac running this browser); the row's first
// chip turns control on, so clicks and keys reach the Mac.
// Icons: only ones the Thread page's first load already has as their own
// chunks, so this lazy row adds none to it (TriangleAlert would).

/** A switch under way: to a window, or to the whole screen. */
export type WindowPickerPending = number | "screen";

export interface DesktopWindowPickerProps {
  /** The Mac's on-screen app windows (Core's `macWindows`). */
  readonly windows: ReadonlyArray<MacDesktopWindow>;
  /** The window streamed now, or undefined for the whole screen. */
  readonly current: StreamedWindow | undefined;
  /** Every choice shows; closed, only what streams now. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** A window, or undefined for the whole screen. */
  readonly onPick: (window: MacDesktopWindow | undefined) => void;
  /** Clicks and keys go to the Mac; off, the Desktop is view-only. */
  readonly interactive: boolean;
  readonly onInteractiveChange: (interactive: boolean) => void;
  readonly pending?: WindowPickerPending | undefined;
}

const windowLabel = (window: {
  readonly app: string;
  readonly title: string;
}) =>
  window.title === "" || window.title === window.app
    ? window.app
    : `${window.app} — ${window.title}`;

const SPINNER = (
  <LoaderCircle className="desktop-app-spinner" aria-hidden="true" />
);

/** Keeps keyboard focus on the desktop when a choice is pressed. */
const keepFocus = (event: React.PointerEvent | React.MouseEvent) =>
  event.preventDefault();

/** View-only, or control: clicks and keys reach the Mac. */
export function DesktopControlToggle({
  interactive,
  onInteractiveChange,
  divider = true,
}: {
  readonly interactive: boolean;
  readonly onInteractiveChange: (interactive: boolean) => void;
  /** A divider after it, before the window choices. */
  readonly divider?: boolean;
}) {
  return (
    <>
      <Chip
        size="sm"
        className="desktop-window-control"
        aria-pressed={interactive}
        title={
          interactive
            ? "Clicks and keys go to this Mac. Turn off to only watch."
            : "View only. Turn on to click and type on this Mac."
        }
        onClick={() => onInteractiveChange(!interactive)}
      >
        {interactive ? (
          <Keyboard aria-hidden="true" />
        ) : (
          <Eye aria-hidden="true" />
        )}
        <span>{interactive ? "Control" : "View only"}</span>
      </Chip>
      {divider ? (
        <span className="desktop-apps-divider" aria-hidden="true" />
      ) : null}
    </>
  );
}

/** The row above a Mac runner's live Desktop that picks what it streams. */
export function DesktopWindowPicker({
  windows,
  current,
  open,
  onOpenChange,
  onPick,
  interactive,
  onInteractiveChange,
  pending,
}: DesktopWindowPickerProps) {
  const busy = pending !== undefined;
  if (!open) {
    const label = current === undefined ? "Whole screen" : windowLabel(current);
    return (
      <div
        className="desktop-apps desktop-windows"
        role="toolbar"
        aria-label="Stream a window"
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
      >
        <DesktopControlToggle
          interactive={interactive}
          onInteractiveChange={onInteractiveChange}
        />
        <Chip
          size="sm"
          className="desktop-window-choice"
          aria-expanded={false}
          aria-label={`Streaming ${label}. Choose a window`}
          title="Choose a window to stream"
          onClick={() => onOpenChange(true)}
        >
          {current === undefined ? (
            <Monitor aria-hidden="true" />
          ) : (
            <AppWindow aria-hidden="true" />
          )}
          <span>{label}</span>
          <ChevronDown aria-hidden="true" />
        </Chip>
      </div>
    );
  }
  return (
    <div
      className="desktop-apps desktop-windows"
      role="toolbar"
      aria-label="Stream a window"
      aria-busy={busy}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
    >
      <DesktopControlToggle
        interactive={interactive}
        onInteractiveChange={onInteractiveChange}
      />
      <Chip
        size="sm"
        className="desktop-window-choice"
        aria-pressed={current === undefined}
        aria-label="Whole screen"
        title="Whole screen"
        disabled={busy}
        onClick={() => onPick(undefined)}
      >
        {pending === "screen" ? SPINNER : <Monitor aria-hidden="true" />}
        <span>Whole screen</span>
      </Chip>
      <span className="desktop-apps-divider" aria-hidden="true" />
      {windows.length === 0 ? (
        <span className="desktop-windows-empty">
          No windows open on this Mac
        </span>
      ) : (
        windows.map((window) => {
          const label = windowLabel(window);
          return (
            <Chip
              key={window.id}
              size="sm"
              className="desktop-window-choice"
              aria-pressed={current?.id === window.id}
              aria-label={label}
              title={label}
              disabled={busy}
              onClick={() => onPick(window)}
            >
              {pending === window.id ? (
                SPINNER
              ) : (
                <AppWindow aria-hidden="true" />
              )}
              <span>{label}</span>
            </Chip>
          );
        })
      )}
      <Button
        variant="subtle"
        size="icon-xs"
        className="desktop-windows-hide"
        aria-label="Hide the window list"
        title="Hide the window list"
        onClick={() => onOpenChange(false)}
      >
        <ChevronUp aria-hidden="true" />
      </Button>
    </div>
  );
}
