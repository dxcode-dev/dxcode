import type { Terminal } from "ghostty-web";

/**
 * Wheel, trackpad, and touch scrolling for the browser Terminal.
 *
 * tmux runs the Terminal on the emulator's alternate screen, where
 * ghostty-web turns the wheel into Up and Down arrow keys: the shell walks its
 * history and replaces the command line. tmux asks for mouse reports (`mouse
 * on`), so a scroll goes to it as wheel reports instead, and tmux scrolls its
 * history in copy mode, or passes them to a full-screen app that wants the
 * mouse. Without mouse reporting the normal screen scrolls the emulator's own
 * buffer, and the alternate screen ignores the scroll. No scroll sends keys.
 */

/** tmux's copy mode scrolls five lines for each wheel report. */
const LINES_PER_REPORT = 5;
/** A touch that moves less than this is a tap, which focuses the Terminal. */
const TOUCH_SLOP_PIXELS = 8;
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const SGR_MOUSE = 1006;

export function attachTerminalScrolling(
  terminal: Terminal,
  element: HTMLElement,
  send: (data: string) => void,
): () => void {
  // Lines scrolled but not yet sent; positive scrolls toward newer output.
  let pending = 0;

  // The canvas holds the grid; the element around it may be taller.
  const grid = () => element.querySelector("canvas") ?? element;
  const lineHeight = () => {
    const height = grid().getBoundingClientRect().height;
    return terminal.rows > 0 && height > 0 ? height / terminal.rows : 16;
  };

  const report = (button: number, clientX: number, clientY: number) => {
    const box = grid().getBoundingClientRect();
    const column = Math.min(
      terminal.cols,
      Math.max(
        1,
        Math.floor(((clientX - box.left) / box.width) * terminal.cols) + 1,
      ),
    );
    const row = Math.min(
      terminal.rows,
      Math.max(
        1,
        Math.floor(((clientY - box.top) / box.height) * terminal.rows) + 1,
      ),
    );
    if (terminal.getMode(SGR_MOUSE)) return `\x1b[<${button};${column};${row}M`;
    // The legacy encoding cannot name a cell past 223.
    return `\x1b[M${String.fromCharCode(32 + button, 32 + Math.min(column, 223), 32 + Math.min(row, 223))}`;
  };

  /** `discrete` scrolls are wheel notches: each one moves at least once. */
  const scroll = (
    lines: number,
    clientX: number,
    clientY: number,
    discrete: boolean,
  ) => {
    if (lines === 0) return;
    if (Math.sign(lines) !== Math.sign(pending)) pending = 0;
    pending += lines;
    if (terminal.hasMouseTracking()) {
      let reports = Math.trunc(pending / LINES_PER_REPORT);
      if (reports === 0 && discrete) reports = Math.sign(pending);
      pending = discrete ? 0 : pending - reports * LINES_PER_REPORT;
      if (reports === 0) return;
      const button = reports < 0 ? WHEEL_UP : WHEEL_DOWN;
      send(report(button, clientX, clientY).repeat(Math.abs(reports)));
      return;
    }
    if (terminal.buffer.active.type === "alternate") {
      pending = 0;
      return;
    }
    const whole = Math.trunc(pending);
    pending -= whole;
    if (whole !== 0) terminal.scrollLines(whole);
  };

  terminal.attachCustomWheelEventHandler((event) => {
    if (!terminal.hasMouseTracking()) {
      // The emulator scrolls its own buffer; only the alternate screen's
      // arrow keys are stopped.
      return terminal.buffer.active.type === "alternate";
    }
    const lines =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * terminal.rows
          : event.deltaY / lineHeight();
    scroll(
      lines,
      event.clientX,
      event.clientY,
      event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL,
    );
    return true;
  });

  // A one-finger drag moves the content with the finger: dragging down shows
  // older output.
  let touch: { id: number; startY: number; lastY: number; dragging: boolean } =
    { id: -1, startY: 0, lastY: 0, dragging: false };
  const onTouchStart = (event: TouchEvent) => {
    const first = event.touches[0];
    if (event.touches.length !== 1 || first === undefined) {
      touch.id = -1;
      return;
    }
    touch = {
      id: first.identifier,
      startY: first.clientY,
      lastY: first.clientY,
      dragging: false,
    };
    pending = 0;
  };
  const onTouchMove = (event: TouchEvent) => {
    const point = [...event.touches].find(
      (candidate) => candidate.identifier === touch.id,
    );
    if (point === undefined || event.touches.length !== 1) return;
    if (
      !touch.dragging &&
      Math.abs(point.clientY - touch.startY) < TOUCH_SLOP_PIXELS
    )
      return;
    touch.dragging = true;
    event.preventDefault();
    const moved = point.clientY - touch.lastY;
    touch.lastY = point.clientY;
    scroll(-moved / lineHeight(), point.clientX, point.clientY, false);
  };
  // A drag is not a tap: keep the emulator's tap handler from focusing the
  // Terminal and opening the on-screen keyboard.
  const onTouchEnd = (event: TouchEvent) => {
    if (!touch.dragging) return;
    touch.dragging = false;
    touch.id = -1;
    event.preventDefault();
    event.stopPropagation();
  };

  const previousTouchAction = element.style.touchAction;
  element.style.touchAction = "none";
  element.addEventListener("touchstart", onTouchStart, {
    capture: true,
    passive: true,
  });
  element.addEventListener("touchmove", onTouchMove, {
    capture: true,
    passive: false,
  });
  element.addEventListener("touchend", onTouchEnd, { capture: true });
  element.addEventListener("touchcancel", onTouchEnd, { capture: true });

  return () => {
    terminal.attachCustomWheelEventHandler(undefined);
    element.removeEventListener("touchstart", onTouchStart, { capture: true });
    element.removeEventListener("touchmove", onTouchMove, { capture: true });
    element.removeEventListener("touchend", onTouchEnd, { capture: true });
    element.removeEventListener("touchcancel", onTouchEnd, { capture: true });
    element.style.touchAction = previousTouchAction;
  };
}
