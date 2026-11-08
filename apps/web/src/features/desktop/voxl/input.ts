// Mouse, wheel, touch, keyboard, and paste input on the desktop surface,
// ported from voxl's web client (web/src/client/{pointer,touch,keyboard}.ts
// at tembo/voxl 176f8be, MIT, © 2026 Tembo). dx's changes: input reaches
// the desktop only while this viewer holds control (the surface or its text
// input has focus, which a click on the surface gives); pointer positions
// map onto the letterboxed picture inside the canvas; key events stay out of
// dx's own shortcuts; and the phone keyboard's text input keeps a character
// in it after each edit, so Backspace always has something to delete.
import { Bin, cmd } from "./protocol.js";

export interface InputTarget {
  readonly surface: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly textInput: HTMLTextAreaElement | undefined;
  /** The text input's value after each edit. */
  readonly textInputRest: string;
  /** The desktop's size in pixels; 0 until the server says hello. */
  desk(): { readonly w: number; readonly h: number };
  /** Sends a command if this viewer holds control; says whether it did. */
  send(command: string): boolean;
  /** Sends a binary message (type byte, then bytes) if this viewer holds control. */
  sendBinary(type: number, bytes: Uint8Array): void;
  /** Releases every held key and button, whether or not this viewer holds control. */
  releaseAll(): void;
  /** Local clipboard text pasted into the desktop, so its echo is not copied back. */
  pasted(text: string): void;
}

/** DOM button -> X button (left, middle, right, back, forward). */
const BUTTONS = [1, 2, 3, 8, 9];

const SLOP = 10;
const LONG_PRESS = 550;
/**
 * A tap this soon (GTK's and Qt's double-click time) and this close (CSS px)
 * after the last one clicks the same spot, so double taps double-click even
 * though the finger lands a little off.
 */
const MULTI_TAP_MS = 400;
const MULTI_TAP_PX = 24;
/** How long Ctrl+V waits for the paste event that carries the local clipboard. */
const PASTE_WAIT_MS = 150;

const NAMED: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  Insert: 0xff63,
  CapsLock: 0xffe5,
  NumLock: 0xff7f,
  ScrollLock: 0xff14,
  Pause: 0xff13,
  PrintScreen: 0xff61,
  ContextMenu: 0xff67,
  AltGraph: 0xfe03,
  " ": 0x20,
};
for (let i = 1; i <= 24; i++) NAMED[`F${i}`] = 0xffbd + i;
const BY_CODE: Record<string, number> = {
  ShiftLeft: 0xffe1,
  ShiftRight: 0xffe2,
  AltLeft: 0xffe9,
  AltRight: 0xffea,
  NumpadEnter: 0xff0d,
};
const XK_BACKSPACE = 0xff08;
const XK_RETURN = 0xff0d;
const XK_DELETE = 0xffff;
const XK_CONTROL_L = 0xffe3;
const XK_CONTROL_R = 0xffe4;
const XK_SUPER_L = 0xffeb;
const XK_SUPER_R = 0xffec;

/** Keysym of a printable character (Latin-1 directly, Unicode via 0x01000000 + code point). */
const charKeysym = (cp: number) =>
  (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)
    ? cp
    : 0x01000000 + cp;

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// The shortcut key is Command on a Mac and Control elsewhere: the Linux
// desktop gets Control for a Mac viewer's Command.
const modifierKeysym = (code: string): number | undefined => {
  const control = code.startsWith("Control");
  const meta = code.startsWith("Meta") || code.startsWith("OS");
  if (!control && !meta) return undefined;
  const right = code.endsWith("Right");
  if (isMac && code.startsWith("Meta"))
    return right ? XK_CONTROL_R : XK_CONTROL_L;
  if (control) return right ? XK_CONTROL_R : XK_CONTROL_L;
  return right ? XK_SUPER_R : XK_SUPER_L;
};

const keysymOf = (event: KeyboardEvent): number => {
  const modifier = modifierKeysym(event.code);
  if (modifier !== undefined) return modifier;
  const byCode = BY_CODE[event.code];
  if (byCode !== undefined) {
    if (event.code === "AltRight" && event.key === "AltGraph") return 0xfe03;
    return byCode;
  }
  // A shortcut with Caps Lock on reports an upper-case letter; send the
  // key's own letter, or the desktop would add Shift (Ctrl+C would become
  // Ctrl+Shift+C).
  const key =
    (event.ctrlKey || event.altKey || event.metaKey) &&
    !event.shiftKey &&
    /^[A-Z]$/.test(event.key)
      ? event.key.toLowerCase()
      : event.key;
  const named = NAMED[key];
  if (named !== undefined) return named;
  if (!key || key === "Dead" || key === "Unidentified" || key === "Process")
    return 0;
  if ([...key].length !== 1) return 0;
  return charKeysym(key.codePointAt(0) ?? 0);
};

const toPng = async (file: File): Promise<ArrayBuffer> => {
  if (file.type === "image/png") return file.arrayBuffer();
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  return (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
};

/** Attaches every input listener; the returned function removes them. */
export function attachInput(target: InputTarget): () => void {
  const { surface, canvas, textInput, send } = target;
  const cleanups: Array<() => void> = [];
  const on = <K extends keyof HTMLElementEventMap>(
    element: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ) => {
    element.addEventListener(type, listener, options);
    cleanups.push(() => element.removeEventListener(type, listener, options));
  };

  /** The picture's box on screen: the canvas letterboxes it (object-fit: contain). */
  const picture = () => {
    const { w, h } = target.desk();
    const box = canvas.getBoundingClientRect();
    const scale = Math.min(box.width / w, box.height / h) || 1;
    return {
      scale,
      left: box.left + (box.width - w * scale) / 2,
      top: box.top + (box.height - h * scale) / 2,
    };
  };
  const toDesk = (p: { clientX: number; clientY: number }) => {
    const { w, h } = target.desk();
    const { scale, left, top } = picture();
    const x = Math.round((p.clientX - left) / scale);
    const y = Math.round((p.clientY - top) / scale);
    return [
      Math.max(0, Math.min(w - 1, x)),
      Math.max(0, Math.min(h - 1, y)),
    ] as const;
  };
  let lastMove = "";
  const move = (p: { clientX: number; clientY: number }, force = false) => {
    if (!target.desk().w) return;
    const [x, y] = toDesk(p);
    const command = cmd.move(x, y);
    // Moves without control are not sent, so the next one must be.
    if ((command !== lastMove || force) && send(command)) lastMove = command;
  };
  /** Desktop pixels per on-screen pixel. */
  const deskPerPx = () => 1 / picture().scale;

  // Scroll is sent in desktop pixels, batched per frame; the server turns it
  // into smooth scrolling, or wheel clicks on X servers that can't.
  let scrollX = 0;
  let scrollY = 0;
  let scrollQueued = false;
  const queueScroll = (dx: number, dy: number) => {
    scrollX += dx;
    scrollY += dy;
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      if (Math.abs(scrollX) < 0.5 && Math.abs(scrollY) < 0.5) return;
      send(cmd.scroll(scrollX, scrollY));
      scrollX = 0;
      scrollY = 0;
    });
  };

  // Touch: tap = click, drag = left-drag, long press = right click, two
  // fingers = scroll (content follows the fingers).
  const points = new Map<number, { x: number; y: number }>();
  let touchMode: "pending" | "drag" | "scroll" | "done" | null = null;
  let touchStart = { x: 0, y: 0 };
  let longPress: ReturnType<typeof setTimeout> | undefined;
  let lastMid: readonly [number, number] = [0, 0];
  let lastTap = { x: 0, y: 0, t: Number.NEGATIVE_INFINITY };
  const midpoint = (): readonly [number, number] => {
    let x = 0;
    let y = 0;
    for (const point of points.values()) {
      x += point.x;
      y += point.y;
    }
    return [x / points.size, y / points.size];
  };
  const moveTo = (x: number, y: number) =>
    move({ clientX: x, clientY: y }, true);
  const click = (button: number) => {
    send(cmd.button(button, true));
    send(cmd.button(button, false));
  };
  const touchDown = (event: PointerEvent) => {
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (points.size === 1) {
      touchMode = "pending";
      touchStart = { x: event.clientX, y: event.clientY };
      longPress = setTimeout(() => {
        if (touchMode !== "pending") return;
        moveTo(touchStart.x, touchStart.y);
        click(3);
        touchMode = "done";
        navigator.vibrate?.(10);
      }, LONG_PRESS);
    } else if (points.size === 2) {
      clearTimeout(longPress);
      if (touchMode === "drag") send(cmd.button(1, false));
      touchMode = "scroll";
      lastMid = midpoint();
    }
  };
  const touchMove = (event: PointerEvent) => {
    const point = points.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;
    if (
      touchMode === "pending" &&
      Math.hypot(point.x - touchStart.x, point.y - touchStart.y) > SLOP
    ) {
      clearTimeout(longPress);
      touchMode = "drag";
      moveTo(touchStart.x, touchStart.y);
      send(cmd.button(1, true));
    }
    if (touchMode === "drag") moveTo(point.x, point.y);
    else if (touchMode === "scroll" && points.size >= 2) {
      const mid = midpoint();
      const k = deskPerPx();
      queueScroll((lastMid[0] - mid[0]) * k, (lastMid[1] - mid[1]) * k);
      lastMid = mid;
    }
  };
  const touchUp = (event: PointerEvent) => {
    if (!points.delete(event.pointerId)) return;
    if (touchMode === "pending") {
      clearTimeout(longPress);
      const now = performance.now();
      const at =
        now - lastTap.t < MULTI_TAP_MS &&
        Math.hypot(touchStart.x - lastTap.x, touchStart.y - lastTap.y) <
          MULTI_TAP_PX
          ? lastTap
          : touchStart;
      lastTap = { x: at.x, y: at.y, t: now };
      moveTo(at.x, at.y);
      click(1);
      touchMode = "done";
    } else if (touchMode === "drag") {
      send(cmd.button(1, false));
      touchMode = "done";
    } else if (touchMode === "scroll" && points.size < 2) touchMode = "done";
    if (points.size === 0) touchMode = null;
  };
  const touchCancel = (event: PointerEvent) => {
    clearTimeout(longPress);
    if (touchMode === "drag") send(cmd.button(1, false));
    points.delete(event.pointerId);
    if (points.size === 0) touchMode = null;
  };
  cleanups.push(() => clearTimeout(longPress));

  on(surface, "pointermove", (event) => {
    if (event.pointerType === "touch") touchMove(event);
    else move(event);
  });
  on(surface, "pointerdown", (event) => {
    // A click on the surface takes control (focus); keep the phone
    // keyboard's text input focused when it has it.
    if (document.activeElement !== textInput)
      surface.focus({ preventScroll: true });
    event.preventDefault();
    try {
      surface.setPointerCapture(event.pointerId);
    } catch {}
    if (event.pointerType === "touch") {
      touchDown(event);
      return;
    }
    move(event);
    send(cmd.button(BUTTONS[event.button] ?? 1, true));
  });
  on(surface, "pointerup", (event) => {
    event.preventDefault();
    if (event.pointerType === "touch") {
      touchUp(event);
      return;
    }
    move(event);
    send(cmd.button(BUTTONS[event.button] ?? 1, false));
  });
  on(surface, "pointercancel", (event) => {
    if (event.pointerType === "touch") touchCancel(event);
    else target.releaseAll();
  });
  on(surface, "contextmenu", (event) => event.preventDefault());
  on(
    surface,
    "wheel",
    (event) => {
      event.preventDefault();
      move(event);
      const k =
        (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1) *
        deskPerPx();
      queueScroll(event.deltaX * k, event.deltaY * k);
    },
    { passive: false },
  );

  // Keys are sent as X keysyms; the server maps them to keycodes, so the
  // browser's layout decides what each key types.
  const down = new Map<string, number>();
  let pendingPaste: {
    code: string;
    keysym: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  const press = (code: string, keysym: number) => {
    down.set(code, keysym);
    send(cmd.key(keysym, true));
  };
  const tap = (keysym: number) => {
    send(cmd.key(keysym, true));
    send(cmd.key(keysym, false));
  };
  const release = (code: string) => {
    const keysym = down.get(code);
    if (keysym === undefined) return;
    down.delete(code);
    send(cmd.key(keysym, false));
  };
  const flushPaste = () => {
    if (!pendingPaste) return;
    const paste = pendingPaste;
    pendingPaste = null;
    clearTimeout(paste.timer);
    press(paste.code, paste.keysym);
  };
  cleanups.push(() => {
    if (pendingPaste) clearTimeout(pendingPaste.timer);
  });
  const onKeyDown = (event: KeyboardEvent) => {
    // The desktop's keys never reach dx's own shortcuts.
    event.stopPropagation();
    if (event.isComposing) return;
    const keysym = keysymOf(event);
    if (!keysym) return;
    const accel = isMac ? event.metaKey : event.ctrlKey;
    if (
      accel &&
      !event.altKey &&
      (event.key === "v" || event.key === "V") &&
      !event.repeat
    ) {
      // Let the browser deliver the paste event first, so the remote
      // clipboard holds the local contents before the shortcut lands.
      pendingPaste = {
        code: event.code,
        keysym,
        timer: setTimeout(flushPaste, PASTE_WAIT_MS),
      };
      return;
    }
    event.preventDefault();
    const held = down.get(event.code);
    if (event.repeat && held !== undefined) {
      send(cmd.key(held, true));
      return;
    }
    press(event.code, keysym);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    event.stopPropagation();
    event.preventDefault();
    if (pendingPaste && pendingPaste.code === event.code) flushPaste();
    release(event.code);
    // macOS swallows the key-ups of keys released while Command is held.
    if (isMac && (event.code === "MetaLeft" || event.code === "MetaRight")) {
      for (const code of down.keys())
        if (!/^(Shift|Control|Alt|Meta)/.test(code)) release(code);
    }
  };
  const onPaste = (event: ClipboardEvent) => {
    event.preventDefault();
    const data = event.clipboardData;
    const text = data?.getData("text/plain");
    if (text) {
      target.pasted(text);
      send(cmd.clipboard(text));
      flushPaste();
      return;
    }
    const file = data
      ? [...data.items]
          .find(
            (item) => item.kind === "file" && item.type.startsWith("image/"),
          )
          ?.getAsFile()
      : null;
    if (!file) {
      flushPaste();
      return;
    }
    // Hold the paste shortcut until the image is on the remote clipboard.
    if (pendingPaste) {
      clearTimeout(pendingPaste.timer);
      pendingPaste.timer = setTimeout(flushPaste, 3_000);
    }
    toPng(file)
      .then((png) => target.sendBinary(Bin.ClipImageUp, new Uint8Array(png)))
      .catch(() => undefined)
      .finally(flushPaste);
  };
  const releaseAll = () => {
    down.clear();
    target.releaseAll();
  };
  for (const element of textInput ? [surface, textInput] : [surface]) {
    on(element, "keydown", onKeyDown);
    on(element, "keyup", onKeyUp);
    on(element, "paste", onPaste);
    // Control ends when focus leaves both the surface and its text input.
    on(element, "focusout", (event) => {
      const next = event.relatedTarget;
      if (next !== surface && next !== textInput) releaseAll();
    });
  }

  // Text that arrives without usable key presses (IME, dead keys, phone
  // keyboards) is typed as individual keysyms.
  if (textInput) {
    const typeText = (text: string) => {
      for (const character of text)
        tap(
          character === "\n"
            ? XK_RETURN
            : charKeysym(character.codePointAt(0) ?? 0),
        );
    };
    const rest = () => {
      textInput.value = target.textInputRest;
    };
    on(textInput, "compositionend", (event) => {
      if (event.data) typeText(event.data);
      rest();
    });
    on(textInput, "input", (event) => {
      const input = event as InputEvent;
      if (input.isComposing) return;
      if (input.inputType === "insertText" && input.data) typeText(input.data);
      else if (input.inputType === "deleteContentBackward") tap(XK_BACKSPACE);
      else if (input.inputType === "deleteContentForward") tap(XK_DELETE);
      else if (
        input.inputType === "insertLineBreak" ||
        input.inputType === "insertParagraph"
      )
        tap(XK_RETURN);
      rest();
    });
  }
  const onWindowBlur = () => releaseAll();
  window.addEventListener("blur", onWindowBlur);
  cleanups.push(() => window.removeEventListener("blur", onWindowBlur));

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
}
