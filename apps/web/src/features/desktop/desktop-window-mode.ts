import type { MacDesktopWindow } from "@dx/api";
import * as React from "react";
import { toast } from "sonner";
import type { WindowPickerPending } from "./desktop-window-picker.js";
import type { VoxlSession, VoxlTarget } from "./voxl/session.js";

/**
 * A Mac's voxl answers a window or whole-screen choice with a new stream
 * within this long, or the choice failed.
 */
const TARGET_SWITCH_MS = 8_000;

/**
 * Window mode on a Mac runner's Desktop: what voxl streams (the whole
 * screen or one window), the picker's state, and whether this viewer sends
 * input. A Mac runner's Desktop opens view-only (`startsViewOnly`): it shows
 * a real Mac someone may be using, maybe the very Mac running this browser,
 * whose whole screen would mirror into the viewer and feed its pointer and
 * keys back. The person turns control on to click and type.
 *
 * Every handler reads only refs and state setters, so the React Compiler
 * keeps them stable for the session's callback ref.
 */
export function useWindowMode(
  remoteRef: React.RefObject<VoxlSession | undefined>,
) {
  const viewOnlyRef = React.useRef(false);
  const startsViewOnlyRef = React.useRef(false);
  const [startsViewOnly, setStartsViewOnly] = React.useState(false);
  const [interactive, setInteractiveState] = React.useState(false);
  const interactiveRef = React.useRef(false);
  const [target, setTargetState] = React.useState<VoxlTarget>();
  const targetRef = React.useRef<VoxlTarget | undefined>(undefined);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pending, setPendingState] = React.useState<WindowPickerPending>();
  const pendingTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const setPending = (next: WindowPickerPending | undefined) => {
    clearTimeout(pendingTimer.current);
    setPendingState(next);
    if (next === undefined) return;
    pendingTimer.current = setTimeout(() => {
      setPendingState(undefined);
      toast.error("The Mac didn't switch. Try again.");
    }, TARGET_SWITCH_MS);
  };
  /** Why the Mac ignores input (Accessibility off), told when control turns on. */
  const inputOffRef = React.useRef<string | undefined>(undefined);
  /** View-only until the person turns control on. */
  const applyViewOnly = () => {
    const next = startsViewOnlyRef.current && !interactiveRef.current;
    viewOnlyRef.current = next;
    remoteRef.current?.setViewOnly(next);
  };
  const mode = {
    /** For a new session, before any state renders. */
    viewOnlyRef,
    target,
    pickerOpen,
    setPickerOpen,
    pending,
    /** A Mac runner's Desktop: view-only until control is turned on. */
    startsViewOnly,
    /** Clicks and keys reach the Mac. */
    interactive,
    /** Turning control off releases whatever the Mac still holds down. */
    setInteractive: (on: boolean) => {
      if (on && inputOffRef.current !== undefined) toast(inputOffRef.current);
      interactiveRef.current = on;
      setInteractiveState(on);
      applyViewOnly();
      remoteRef.current?.focus();
    },
    /**
     * Core said the Desktop opens view-only (a Mac runner's), and why the
     * Mac ignores input if it does: shown only when control turns on, never
     * over the stream.
     */
    onReady: (inputOff: string | undefined, next: boolean) => {
      inputOffRef.current = inputOff;
      startsViewOnlyRef.current = next;
      setStartsViewOnly(next);
      applyViewOnly();
    },
    /** Each stream says what it shows; a window choice took when it names it. */
    onTarget: (next: VoxlTarget) => {
      targetRef.current = next;
      setTargetState(next);
      setPending(undefined);
    },
    onWindowClosed: (id: number) => {
      const closed = targetRef.current?.window;
      setPending(undefined);
      toast(
        closed?.id === id
          ? `${closed.app} closed. Showing the whole screen.`
          : "That window is gone. Pick another.",
      );
    },
    /** A window, or undefined for the whole screen. */
    pick: (window: MacDesktopWindow | undefined) => {
      const session = remoteRef.current;
      if (session === undefined) return;
      const streaming = targetRef.current?.window?.id;
      if (window === undefined) {
        if (streaming !== undefined && !session.streamDisplay())
          return toast.error("Couldn't switch to the whole screen. Try again.");
        if (streaming !== undefined) setPending("screen");
      } else if (streaming !== window.id) {
        if (!session.streamWindow(window.id))
          return toast.error(`Couldn't stream ${window.app}. Try again.`);
        setPending(window.id);
      }
      setPickerOpen(false);
      session.focus();
    },
    dispose: () => clearTimeout(pendingTimer.current),
  };
  // The handlers read only refs and state setters, so the first render's
  // stay valid: one object for the whole session, which a callback ref that
  // must never change can capture.
  const [session] = React.useState<WindowModeSession>(() => ({
    onReady: mode.onReady,
    voxl: { onTarget: mode.onTarget, onWindowClosed: mode.onWindowClosed },
    viewOnlyRef: mode.viewOnlyRef,
    dispose: mode.dispose,
  }));
  return { ...mode, session };
}

/** What a Desktop session needs from window mode; the same every render. */
export interface WindowModeSession {
  /** Core's answer: the Mac's input notice, and whether it opens view-only. */
  readonly onReady: (
    notice: string | undefined,
    startsViewOnly: boolean,
  ) => void;
  /** The voxl session's window mode callbacks. */
  readonly voxl: {
    readonly onTarget: (next: VoxlTarget) => void;
    readonly onWindowClosed: (id: number) => void;
  };
  readonly viewOnlyRef: React.RefObject<boolean>;
  readonly dispose: () => void;
}
