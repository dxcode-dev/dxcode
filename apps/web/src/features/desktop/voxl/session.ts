// One viewer's connection to the Thread's voxl desktop: the socket, the
// picture, the remote cursor, input, the remote clipboard, and the desktop's
// size. dx's port of voxl's web client (tembo/voxl 176f8be, MIT, © 2026
// Tembo); the viewer (../desktop-viewer.tsx) owns status, retries, and the
// rules for when a session runs.
import { createCursor } from "./cursor.js";
import { attachInput } from "./input.js";
import {
  Bin,
  cmd,
  type Hello,
  type ServerMessage,
  WATCH_COMMANDS,
} from "./protocol.js";
import { createVideo } from "./video.js";

/** How long a closed socket waits before the session opens another. */
export const RECONNECT_DELAY_MS = 1_000;
/** A new desktop size is asked for once the pane has kept its size this long. */
const RESIZE_DEBOUNCE_MS = 250;

export type VoxlConnection = "connecting" | "open" | "closed";

export interface VoxlSessionOptions {
  readonly canvas: HTMLCanvasElement;
  /** Takes focus (control) and pointer input. */
  readonly surface: HTMLElement;
  /** The phone keyboard's hidden text input. */
  readonly textInput?: HTMLTextAreaElement;
  /** What the text input holds after each edit. */
  readonly textInputRest?: string;
  /** Opens the desktop's socket (dx Core's Thread route). */
  readonly createWebSocket: () => WebSocket;
  /** The socket opened or closed. */
  readonly onConnection?: (state: VoxlConnection) => void;
  /** A frame was drawn on the canvas. */
  readonly onPicture?: () => void;
  /** The remote clipboard changed: text, or a PNG image. */
  readonly onClipboard?: (content: string | Blob) => void;
}

export class VoxlSession {
  readonly #options: VoxlSessionOptions;
  readonly #video: ReturnType<typeof createVideo>;
  readonly #cursor: ReturnType<typeof createCursor>;
  readonly #detachInput: () => void;
  #socket: WebSocket | undefined;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #disposed = false;
  #desk = { w: 0, h: 0 };
  #readOnly = false;
  #resizable = false;
  #wantedSize: { readonly w: number; readonly h: number } | undefined;
  #sentSize = "";
  #resizeTimer: ReturnType<typeof setTimeout> | undefined;
  #lastLocalPaste: string | undefined;
  #videoOn = true;

  constructor(options: VoxlSessionOptions) {
    this.#options = options;
    this.#video = createVideo(options.canvas, {
      send: (command) => this.#send(command),
      drawn: () => options.onPicture?.(),
    });
    this.#cursor = createCursor(options.canvas, () => this.#scale());
    this.#detachInput = attachInput({
      surface: options.surface,
      canvas: options.canvas,
      textInput: options.textInput,
      textInputRest: options.textInputRest ?? "",
      desk: () => this.#desk,
      send: (command) => this.#sendInput(command),
      sendBinary: (type, bytes) => {
        if (!this.controlled || this.#readOnly) return;
        const message = new Uint8Array(bytes.byteLength + 1);
        message[0] = type;
        message.set(bytes, 1);
        this.#sendRaw(message.buffer);
      },
      releaseAll: () => this.#send(cmd.releaseAll),
      pasted: (text) => {
        this.#lastLocalPaste = text;
      },
    });
    document.addEventListener("visibilitychange", this.#onVisibility);
  }

  /** Whether this viewer holds control: its surface or text input has focus. */
  get controlled() {
    const focused = document.activeElement;
    return (
      focused !== null &&
      (focused === this.#options.surface || focused === this.#options.textInput)
    );
  }

  /** Opens the socket now, and reopens it whenever it closes. */
  connect() {
    if (this.#disposed) return;
    this.#running = true;
    clearTimeout(this.#reconnect);
    if (this.#socket === undefined) this.#open();
  }

  /** Closes the socket and stops reopening it. */
  disconnect() {
    this.#running = false;
    clearTimeout(this.#reconnect);
    const socket = this.#socket;
    this.#socket = undefined;
    this.#video.reset();
    if (socket !== undefined) {
      socket.removeEventListener("close", this.#onClose);
      socket.close();
      this.#options.onConnection?.("closed");
    }
  }

  dispose() {
    this.disconnect();
    this.#disposed = true;
    clearTimeout(this.#resizeTimer);
    this.#detachInput();
    document.removeEventListener("visibilitychange", this.#onVisibility);
  }

  /** Takes control: focuses the surface. */
  focus() {
    this.#options.surface.focus({ preventScroll: true });
  }

  /** Takes control with the phone keyboard: focuses the text input. */
  focusTextInput() {
    const input = this.#options.textInput;
    if (input === undefined) return this.focus();
    input.focus({ preventScroll: true });
  }

  /**
   * The desktop size the pane wants, in desktop pixels. Asked for once the
   * pane keeps it briefly, and again after each reconnect.
   */
  resize(width: number, height: number) {
    this.#wantedSize = { w: width, h: height };
    clearTimeout(this.#resizeTimer);
    this.#resizeTimer = setTimeout(() => this.#sendSize(), RESIZE_DEBOUNCE_MS);
  }

  #scale() {
    const box = this.#options.canvas.getBoundingClientRect();
    const { w, h } = this.#desk;
    return w && h ? Math.min(box.width / w, box.height / h) : 1;
  }

  #sendSize() {
    const size = this.#wantedSize;
    if (!this.#resizable || size === undefined || this.#readOnly) return;
    const key = `${size.w},${size.h}`;
    if (key === this.#sentSize) return;
    if (this.#send(cmd.resize(size.w, size.h))) this.#sentSize = key;
  }

  #open() {
    this.#options.onConnection?.("connecting");
    const socket = this.#options.createWebSocket();
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      if (socket !== this.#socket) return;
      this.#options.onConnection?.("open");
      this.#send(cmd.video(this.#videoOn));
    });
    socket.addEventListener("close", this.#onClose);
    socket.addEventListener("message", (event: MessageEvent) => {
      if (socket !== this.#socket) return;
      if (typeof event.data === "string") this.#onText(event.data);
      else if (event.data instanceof ArrayBuffer) this.#onBinary(event.data);
    });
  }

  readonly #onClose = (event: Event) => {
    if (event.target !== this.#socket) return;
    this.#socket = undefined;
    this.#video.reset();
    this.#options.onConnection?.("closed");
    if (!this.#running || this.#disposed) return;
    this.#reconnect = setTimeout(() => {
      if (this.#running && this.#socket === undefined) this.#open();
    }, RECONNECT_DELAY_MS);
  };

  #onText(text: string) {
    let message: ServerMessage;
    try {
      message = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    switch (message.t) {
      case "ping":
        this.#send(cmd.pong(message.s));
        break;
      case "close":
        this.#socket?.close();
        break;
      case "hello":
        this.#onHello(message);
        break;
      case "clip":
        if (message.d === this.#lastLocalPaste) break;
        this.#options.onClipboard?.(message.d);
        break;
    }
  }

  #onHello(hello: Hello) {
    this.#desk = { w: hello.w, h: hello.h };
    this.#readOnly = hello.readOnly === true;
    this.#resizable = hello.resize !== undefined;
    this.#video.configure(hello.w, hello.h, hello.stripes ?? []);
    this.#cursor.apply();
    // Each hello starts a stream; a reconnected server forgets the size.
    this.#sentSize = "";
    this.#sendSize();
  }

  #onBinary(buffer: ArrayBuffer) {
    const bytes = new Uint8Array(buffer);
    switch (bytes[0]) {
      case Bin.Video:
        this.#video.receive(bytes);
        break;
      case Bin.Cursor:
        this.#cursor.set(buffer);
        break;
      case Bin.ClipImage:
        this.#options.onClipboard?.(
          new Blob([bytes.subarray(1)], { type: "image/png" }),
        );
        break;
    }
  }

  // The stream pauses while the page is hidden, and held keys are let go.
  readonly #onVisibility = () => {
    const on = !document.hidden;
    if (!on) this.#send(cmd.releaseAll);
    if (on === this.#videoOn) return;
    this.#videoOn = on;
    if (on) this.#video.reset();
    this.#send(cmd.video(on));
  };

  #sendInput(command: string) {
    if (!this.controlled) return false;
    if (this.#readOnly && !WATCH_COMMANDS.has(command.split(",")[0] ?? ""))
      return false;
    return this.#send(command);
  }

  #send(command: string) {
    return this.#sendRaw(command);
  }

  #sendRaw(data: string | ArrayBuffer) {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN)
      return false;
    socket.send(data);
    return true;
  }
}
