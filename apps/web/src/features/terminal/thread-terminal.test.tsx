// @vitest-environment happy-dom

import type { ThreadId } from "@dx/domain";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const emulator = vi.hoisted(() => ({
  mount: vi.fn(),
  input: undefined as undefined | ((data: string) => void),
  onResize: undefined as
    | undefined
    | ((size: { cols: number; rows: number }) => void),
  write: vi.fn(),
  reset: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  resizeDispose: vi.fn(),
}));

vi.mock("./ghostty-browser-emulator.js", () => ({
  mountBrowserTerminal: emulator.mount,
}));

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readonly sent: unknown[] = [];
  readyState = 0;
  binaryType = "";
  close = vi.fn();
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
  emit(type: string, data?: unknown) {
    if (type === "open") this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(
      type === "message" ? new MessageEvent(type, { data }) : new Event(type),
    );
  }
}

import { ThreadDesktopLayout } from "../threads/thread-desktop-layout.js";
import { ThreadTerminal } from "./thread-terminal.js";

afterEach(() => {
  document.body.replaceChildren();
  FakeSocket.instances = [];
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const browserTerminal = () => ({
  terminal: {
    cols: 120,
    rows: 40,
    write: emulator.write,
    reset: emulator.reset,
    resize: emulator.resize,
    onResize: (listener: typeof emulator.onResize) => {
      emulator.onResize = listener;
      return { dispose: emulator.resizeDispose };
    },
  },
  dispose: emulator.dispose,
});

const render = async (
  threadId = "thr_00000000-0000-4000-8000-000000000183",
  mountTerminal: (
    element: HTMLElement,
    input: (data: string) => void,
  ) => Promise<ReturnType<typeof browserTerminal>> = async (
    _element,
    input,
  ) => {
    emulator.input = input;
    return browserTerminal();
  },
  onWorkspaceStatusChange?: (status?: string) => void,
  withTabs = false,
) => {
  emulator.mount.mockImplementation(mountTerminal);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const terminal = (
    <ThreadTerminal
      threadId={threadId as ThreadId}
      onWorkspaceStatusChange={onWorkspaceStatusChange}
    />
  );
  await React.act(() =>
    root.render(
      withTabs ? (
        <ThreadDesktopLayout
          rightPaneCollapsed={false}
          main={null}
          terminal={terminal}
          changes={<div>Changes</div>}
        />
      ) : (
        terminal
      ),
    ),
  );
  await React.act(async () => {});
  return {
    container,
    root,
    socket: FakeSocket.instances.at(-1) as FakeSocket,
  };
};

const ready = JSON.stringify({
  v: 1,
  type: "ready",
  terminal: "default",
  dimensions: { columns: 120, rows: 40 },
  replayBytes: 2,
  replayTruncated: false,
  restartRequired: false,
});

describe("ThreadTerminal browser protocol v1", () => {
  it("selects Terminal into loading, then connects after a paused wake", async () => {
    emulator.mount.mockImplementation(async (_element, input) => {
      emulator.input = input;
      return browserTerminal();
    });
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <ThreadDesktopLayout
          changes={<div>Changes</div>}
          main={<div>Agent</div>}
          rightPaneCollapsed={false}
          terminal={
            <ThreadTerminal
              threadId={"thr_00000000-0000-4000-8000-000000000183" as ThreadId}
            />
          }
        />,
      ),
    );
    expect(FakeSocket.instances).toHaveLength(0);

    await React.act(() =>
      container
        .querySelector<HTMLButtonElement>("#thread-workspace-tab-terminal")
        ?.click(),
    );
    await React.act(async () => {});
    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.emit("open");
    await React.act(() =>
      socket.emit(
        "message",
        JSON.stringify({ v: 1, type: "progress", phase: "waking" }),
      ),
    );

    expect(
      container.querySelector(
        ".thread-terminal-loading .workspace-loading-glyph",
      ),
    ).not.toBeNull();
    expect(container.querySelector(".dx-brand-mark")).toBeNull();
    expect(container.textContent).toContain("Waking terminal…");
    expect(container.textContent).not.toContain(
      "Terminal is temporarily unavailable.",
    );

    await React.act(() => socket.emit("message", ready));
    expect(container.textContent).toContain("Terminal ready");
    expect(container.querySelector(".thread-terminal-loading")).toBeNull();
    await React.act(() => root.unmount());
  });

  it("negotiates v1, attaches first, gates input, and sends validated resize", async () => {
    const { root, socket } = await render();
    expect(socket.protocols).toBe("dx-terminal.v1");
    socket.emit("open");
    expect(socket.sent).toEqual([
      JSON.stringify({
        v: 1,
        type: "attach",
        terminal: "default",
        dimensions: { columns: 120, rows: 40 },
      }),
    ]);

    emulator.input?.("gated");
    expect(socket.sent).toHaveLength(1);
    await React.act(() => socket.emit("message", ready));
    emulator.input?.("é");
    expect(socket.sent[1]).toEqual(new TextEncoder().encode("é"));
    emulator.onResize?.({ cols: 9_999, rows: -2 });
    expect(socket.sent[2]).toBe(
      JSON.stringify({
        v: 1,
        type: "resize",
        dimensions: { columns: 1_000, rows: 1 },
      }),
    );
    await React.act(() => root.unmount());
  });

  it("resets Ghostty before ordered replay and applies canonical dimensions", async () => {
    const { container, root, socket } = await render();
    socket.emit("open");
    await React.act(() =>
      socket.emit(
        "message",
        JSON.stringify({
          v: 1,
          type: "replay-start",
          reset: true,
          truncated: false,
        }),
      ),
    );
    expect(emulator.reset).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Restoring terminal…");
    socket.emit("message", Uint8Array.of(1).buffer);
    socket.emit("message", Uint8Array.of(2).buffer);
    await React.act(() => socket.emit("message", ready));
    expect(emulator.write.mock.calls.map(([bytes]) => [...bytes])).toEqual([
      [1],
      [2],
    ]);
    expect(emulator.resize).toHaveBeenCalledWith(120, 40);
    expect(container.textContent).toContain("Terminal ready");
    await React.act(() => root.unmount());
  });

  it("projects wake progress into the main-pane status owner", async () => {
    const onWorkspaceStatusChange = vi.fn();
    const { root, socket } = await render(
      "thr_00000000-0000-4000-8000-000000000183",
      undefined,
      onWorkspaceStatusChange,
    );
    socket.emit("open");
    await React.act(() =>
      socket.emit(
        "message",
        JSON.stringify({ v: 1, type: "progress", phase: "waking" }),
      ),
    );
    expect(onWorkspaceStatusChange).toHaveBeenLastCalledWith(
      "Waking up the Orb…",
    );

    await React.act(() => socket.emit("message", ready));
    expect(onWorkspaceStatusChange).toHaveBeenLastCalledWith(undefined);
    await React.act(() => root.unmount());
  });

  it("clears wake progress when the socket closes", async () => {
    const onWorkspaceStatusChange = vi.fn();
    const { root, socket } = await render(
      "thr_00000000-0000-4000-8000-000000000183",
      undefined,
      onWorkspaceStatusChange,
    );
    socket.emit("open");
    await React.act(() =>
      socket.emit(
        "message",
        JSON.stringify({ v: 1, type: "progress", phase: "waking" }),
      ),
    );

    await React.act(() => socket.emit("close"));

    expect(onWorkspaceStatusChange).toHaveBeenLastCalledWith(undefined);
    await React.act(() => root.unmount());
  });

  it("maps only fixed error codes and never renders private unknown fields", async () => {
    const { container, root, socket } = await render();
    socket.emit("open");
    await React.act(() =>
      socket.emit(
        "message",
        JSON.stringify({
          v: 1,
          type: "error",
          code: "resident-unavailable",
          retry: "manual",
        }),
      ),
    );
    expect(container.textContent).toContain(
      "Terminal is temporarily unavailable.",
    );
    expect(container.querySelector("button")?.textContent).toBe(
      "Retry terminal",
    );
    await React.act(() =>
      socket.emit(
        "message",
        JSON.stringify({
          v: 1,
          type: "error",
          code: "resident-unavailable",
          retry: "manual",
          cause: "provider secret terminal content",
        }),
      ),
    );
    expect(container.textContent).not.toContain("provider secret");
    await React.act(() => root.unmount());
  });

  it("reattaches on explicit retry and on focused pause policy", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { container, root, socket } = await render();
    socket.emit("open");
    await React.act(() => socket.emit("message", ready));
    const terminal = container.querySelector(".thread-terminal") as HTMLElement;
    terminal.tabIndex = -1;
    terminal.focus();
    await React.act(() =>
      socket.emit(
        "message",
        JSON.stringify({
          v: 1,
          type: "error",
          code: "workspace-paused",
          retry: "on-focus",
        }),
      ),
    );
    expect(FakeSocket.instances).toHaveLength(2);
    await React.act(() => root.unmount());
  });

  it("wakes the retained sandbox when the user returns after unarchiving", async () => {
    const { container, root, socket } = await render();
    socket.emit("open");
    await React.act(() => socket.emit("message", ready));
    await React.act(() =>
      socket.emit(
        "message",
        JSON.stringify({
          v: 1,
          type: "error",
          code: "thread-archived",
          retry: "after-unarchive",
        }),
      ),
    );

    await React.act(() =>
      container.querySelector<HTMLElement>(".thread-terminal-shell")?.focus(),
    );
    await React.act(async () => {});

    expect(FakeSocket.instances).toHaveLength(2);
    expect(container.textContent).toContain("Waking terminal…");
    await React.act(() => root.unmount());
  });

  it("requests generation-CAS resident recovery only after explicit manual retry", async () => {
    const { container, root, socket } = await render();
    socket.emit("open");
    await React.act(() =>
      socket.emit(
        "message",
        JSON.stringify({
          v: 1,
          type: "error",
          code: "terminal-exited",
          retry: "manual",
        }),
      ),
    );
    expect(container.querySelector("button")?.textContent).toBe(
      "Open terminal",
    );
    await React.act(() =>
      (container.querySelector("button") as HTMLButtonElement).click(),
    );
    const retrySocket = FakeSocket.instances.at(-1) as FakeSocket;
    retrySocket.emit("open");
    expect(retrySocket.sent[0]).toBe(
      JSON.stringify({
        v: 1,
        type: "attach",
        terminal: "default",
        dimensions: { columns: 120, rows: 40 },
        restartResident: true,
      }),
    );
    await React.act(() => root.unmount());
  });

  it("allows an owner to refresh the current environment", async () => {
    const confirm = vi
      .fn<(message?: string) => boolean>()
      .mockReturnValue(true);
    vi.stubGlobal("confirm", confirm);
    const { container, root, socket } = await render();
    socket.emit("open");
    await React.act(() => socket.emit("message", ready));
    const form = container.querySelector("form") as HTMLFormElement;

    expect(container.querySelector("button")).toBeNull();
    await React.act(() => form.requestSubmit());

    expect(confirm).toHaveBeenCalledWith(
      "Refresh Terminal environment? If values changed, dx restarts the shared shell and ends any running command or process in every open Terminal view.",
    );
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ v: 1, type: "restart" }));
    await React.act(() => root.unmount());
  });

  it("requires destructive confirmation before refreshing a changed environment", async () => {
    const confirm = vi
      .fn<(message?: string) => boolean>()
      .mockReturnValue(false);
    vi.stubGlobal("confirm", confirm);
    const { container, root, socket } = await render();
    socket.emit("open");
    await React.act(() =>
      socket.emit(
        "message",
        JSON.stringify({
          ...JSON.parse(ready),
          restartRequired: true,
        }),
      ),
    );
    expect(container.textContent).toContain(
      "Environment changed. Use the Terminal tab menu to refresh and restart.",
    );
    const form = container.querySelector("form") as HTMLFormElement;

    await React.act(() => form.requestSubmit());
    expect(confirm).toHaveBeenCalledWith(
      "Refresh and restart Terminal? Restarting ends the shared shell and any running command or process in every open Terminal view.",
    );
    expect(socket.sent).not.toContain(
      JSON.stringify({ v: 1, type: "restart" }),
    );

    confirm.mockReturnValue(true);
    await React.act(() => form.requestSubmit());
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ v: 1, type: "restart" }));
    await React.act(() => root.unmount());
  });

  it("refreshes from the Terminal tab menu without placing controls in the emulator", async () => {
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirm);
    const { container, root } = await render(
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(container.querySelector("form")).toBeNull();
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
    const options = container.querySelector(
      'button[aria-label="Terminal options"]',
    ) as HTMLButtonElement;
    await React.act(() => options.click());
    await React.act(async () => {});
    const socket = FakeSocket.instances.at(-1) as FakeSocket;
    socket.emit("open");
    const form = container.querySelector("form") as HTMLFormElement;
    await React.act(() => form.requestSubmit());
    expect(confirm).not.toHaveBeenCalled();
    await React.act(() => socket.emit("message", ready));
    expect(
      container
        .querySelector("#thread-workspace-tab-terminal")
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    const item = document.querySelector(
      '[role="menuitem"]',
    ) as HTMLButtonElement;
    expect(item.textContent).toContain("Refresh environment");
    expect(item.form).toBe(form);
    expect(form.querySelector("button")).toBeNull();
    await React.act(() => item.click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(
      socket.sent.filter(
        (value) => value === JSON.stringify({ v: 1, type: "restart" }),
      ),
    ).toHaveLength(1);
    await React.act(() => root.unmount());
  });

  it("uses one visible immediate reconnect without carrying resident recovery", async () => {
    const { root, socket } = await render();
    socket.emit("open");
    await React.act(() =>
      socket.emit(
        "message",
        JSON.stringify({
          v: 1,
          type: "error",
          code: "reconnect-required",
          retry: "immediate-once",
        }),
      ),
    );
    expect(FakeSocket.instances).toHaveLength(2);
    const automatic = FakeSocket.instances[1] as FakeSocket;
    automatic.emit("open");
    expect(automatic.sent[0]).toBe(
      JSON.stringify({
        v: 1,
        type: "attach",
        terminal: "default",
        dimensions: { columns: 120, rows: 40 },
      }),
    );

    await React.act(() =>
      automatic.emit(
        "message",
        JSON.stringify({
          v: 1,
          type: "error",
          code: "reconnect-required",
          retry: "immediate-once",
        }),
      ),
    );
    expect(FakeSocket.instances).toHaveLength(2);
    await React.act(() => root.unmount());
  });

  it.each(["close", "error"])(
    "shows an unannounced socket %s as disconnected and retries while visible",
    async (event) => {
      vi.useFakeTimers();
      const { container, root, socket } = await render();
      socket.emit("open");
      await React.act(() => socket.emit("message", ready));
      await React.act(() => socket.emit(event));
      expect(container.textContent).toContain("Terminal disconnected.");
      expect(container.querySelector("button")?.textContent).toBe(
        "Retry terminal",
      );
      await React.act(() => vi.advanceTimersByTimeAsync(250));
      expect(FakeSocket.instances).toHaveLength(2);
      expect(container.textContent).toContain("Waking terminal…");
      await React.act(() => root.unmount());
    },
  );

  it("reattaches promptly when the resident connection disappears", async () => {
    vi.useFakeTimers();
    const { container, root, socket } = await render();
    socket.emit("open");
    await React.act(() => socket.emit("message", ready));
    await React.act(() =>
      socket.emit(
        "message",
        JSON.stringify({
          v: 1,
          type: "progress",
          phase: "resident-restarting",
        }),
      ),
    );

    expect(container.textContent).toContain("Terminal disconnected.");
    await React.act(() => vi.advanceTimersByTimeAsync(250));
    expect(FakeSocket.instances).toHaveLength(2);
    expect(container.textContent).toContain("Waking terminal…");
    await React.act(() => root.unmount());
  });

  it("recovers an active terminal when daemon heartbeats stop without closing the socket", async () => {
    vi.useFakeTimers();
    const { container, root, socket } = await render();
    socket.emit("open");
    await React.act(() => socket.emit("message", ready));

    await React.act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(container.textContent).toContain("Terminal disconnected.");
    await React.act(() => vi.advanceTimersByTimeAsync(250));
    expect(FakeSocket.instances).toHaveLength(2);
    expect(container.textContent).toContain("Waking terminal…");
    await React.act(() => root.unmount());
  });

  it("keeps a ready terminal connected while daemon heartbeats continue", async () => {
    vi.useFakeTimers();
    const { container, root, socket } = await render();
    socket.emit("open");
    await React.act(() => socket.emit("message", ready));

    for (let elapsed = 0; elapsed < 30_000; elapsed += 2_000) {
      await React.act(() => vi.advanceTimersByTimeAsync(2_000));
      await React.act(() =>
        socket.emit("message", JSON.stringify({ v: 1, type: "heartbeat" })),
      );
    }
    expect(FakeSocket.instances).toHaveLength(1);
    expect(container.textContent).toContain("Terminal ready");
    await React.act(() => root.unmount());
  });

  it("does not reconnect while retained behind another tool and resumes on Terminal activation", async () => {
    vi.useFakeTimers();
    emulator.mount.mockImplementation(async (_element, input) => {
      emulator.input = input;
      return browserTerminal();
    });
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <ThreadDesktopLayout
          changes={<div>Changes</div>}
          main={<div>Agent</div>}
          rightPaneCollapsed={false}
          terminal={(active) => (
            <ThreadTerminal
              active={active}
              threadId={"thr_00000000-0000-4000-8000-000000000183" as ThreadId}
            />
          )}
        />,
      ),
    );
    const terminalTab = container.querySelector<HTMLButtonElement>(
      "#thread-workspace-tab-terminal",
    );
    const changesTab = container.querySelector<HTMLButtonElement>(
      "#thread-workspace-tab-changes",
    );
    await React.act(() => terminalTab?.click());
    await React.act(async () => {});
    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.emit("open");
    await React.act(() => socket.emit("message", ready));

    await React.act(() => changesTab?.click());
    await React.act(() => socket.emit("close"));
    await React.act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(FakeSocket.instances).toHaveLength(1);

    await React.act(() => terminalTab?.click());
    expect(FakeSocket.instances).toHaveLength(2);
    expect(container.textContent).toContain("Waking terminal…");
    await React.act(() => root.unmount());
  });

  it("keeps a healthy retained terminal ready across pane and document visibility changes", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    emulator.mount.mockImplementation(async (_element, input) => {
      emulator.input = input;
      return browserTerminal();
    });
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <ThreadDesktopLayout
          changes={<div>Changes</div>}
          main={<div>Agent</div>}
          rightPaneCollapsed={false}
          terminal={(active) => (
            <ThreadTerminal
              active={active}
              threadId={"thr_00000000-0000-4000-8000-000000000183" as ThreadId}
            />
          )}
        />,
      ),
    );
    const terminalTab = container.querySelector<HTMLButtonElement>(
      "#thread-workspace-tab-terminal",
    );
    const changesTab = container.querySelector<HTMLButtonElement>(
      "#thread-workspace-tab-changes",
    );
    await React.act(() => terminalTab?.click());
    await React.act(async () => {});
    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.emit("open");
    await React.act(() => socket.emit("message", ready));

    await React.act(() => changesTab?.click());
    await React.act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(FakeSocket.instances).toHaveLength(1);

    visibility = "hidden";
    await React.act(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await React.act(() => vi.advanceTimersByTimeAsync(30_000));
    visibility = "visible";
    await React.act(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await React.act(() => terminalTab?.click());

    expect(FakeSocket.instances).toHaveLength(1);
    expect(container.textContent).toContain("Terminal ready");
    expect(container.textContent).not.toContain("Terminal disconnected.");
    await React.act(() => root.unmount());
  });

  it("checks liveness again after a hidden terminal becomes active", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    const { container, root, socket } = await render();
    socket.emit("open");
    await React.act(() => socket.emit("message", ready));

    visibility = "hidden";
    await React.act(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await React.act(() => vi.advanceTimersByTimeAsync(30_000));
    visibility = "visible";
    await React.act(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await React.act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(FakeSocket.instances).toHaveLength(1);
    await React.act(() => vi.advanceTimersByTimeAsync(1));

    expect(container.textContent).toContain("Terminal disconnected.");
    await React.act(() => vi.advanceTimersByTimeAsync(250));
    expect(FakeSocket.instances).toHaveLength(2);
    await React.act(() => root.unmount());
  });

  it("waits for visible user presence before recovering a disconnected terminal", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    const { container, root, socket } = await render();
    socket.emit("open");
    await React.act(() => socket.emit("message", ready));
    await React.act(() => socket.emit("close"));

    await React.act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(container.textContent).toContain("Terminal disconnected.");

    visibility = "visible";
    await React.act(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(FakeSocket.instances).toHaveLength(2);
    expect(container.textContent).toContain("Waking terminal…");
    await React.act(() => root.unmount());
  });

  it("preserves the reconnect budget while offline and resumes on online intent", async () => {
    vi.useFakeTimers();
    let online = false;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    const { container, root, socket } = await render();
    socket.emit("open");
    await React.act(() => socket.emit("message", ready));
    await React.act(() => socket.emit("close"));

    await React.act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(container.textContent).toContain("Terminal disconnected.");

    online = true;
    await React.act(() => window.dispatchEvent(new Event("online")));
    expect(FakeSocket.instances).toHaveLength(2);
    expect(container.textContent).toContain("Waking terminal…");
    await React.act(() => root.unmount());
  });

  it("bounds automatic reconnects and leaves a manual fallback", async () => {
    vi.useFakeTimers();
    const { container, root, socket } = await render();
    socket.emit("open");
    await React.act(() => socket.emit("message", ready));

    for (const delay of [250, 1_000, 2_500]) {
      const failed = FakeSocket.instances.at(-1) as FakeSocket;
      await React.act(() => failed.emit("close"));
      await React.act(() => vi.advanceTimersByTimeAsync(delay));
    }
    const exhausted = FakeSocket.instances.at(-1) as FakeSocket;
    await React.act(() => exhausted.emit("close"));
    await React.act(() => vi.advanceTimersByTimeAsync(30_000));

    expect(FakeSocket.instances).toHaveLength(4);
    expect(container.textContent).toContain("Terminal disconnected.");
    expect(container.querySelector("button")?.textContent).toBe(
      "Retry terminal",
    );
    await React.act(() => root.unmount());
  });

  it("detaches before close and releases emulator resources", async () => {
    const { root, socket } = await render();
    socket.emit("open");
    await React.act(() => socket.emit("message", ready));
    await React.act(() => root.unmount());
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ v: 1, type: "detach" }));
    expect(socket.close).toHaveBeenCalledOnce();
    expect(emulator.resizeDispose).toHaveBeenCalledOnce();
    expect(emulator.dispose).toHaveBeenCalledOnce();
  });
});
