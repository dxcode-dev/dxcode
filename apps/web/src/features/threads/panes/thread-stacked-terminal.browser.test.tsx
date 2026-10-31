import type { ThreadId } from "@dx/domain";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import "../../../styles.css";
import { paneLayoutWith } from "../../../testing/pane-layouts.js";
import { ThreadTerminal } from "../../terminal/thread-terminal.js";
import { type PaneLayoutAction, reducePaneLayout } from "./pane-layout.js";
import type { PaneContents } from "./pane-views.js";
import { ThreadStackedLayout } from "./thread-stacked-layout.js";
import "./panes.css";

// Issue #1118, on a phone (390x844):
// - the "Environment changed" notice covers the on-screen key bar;
// - no phone control reaches Refresh Environment, so the notice never clears;
// - a Refresh Environment item outside the Terminal's form submits nothing;
// - the notice still names a desktop-only menu.

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readonly sent: unknown[] = [];
  readyState = 0;
  binaryType = "";
  close = vi.fn();
  constructor(readonly url: string) {
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

const loadEmulator = (() =>
  Promise.resolve({
    mountBrowserTerminal: async () => ({
      terminal: {
        cols: 40,
        rows: 30,
        write: () => {},
        reset: () => {},
        resize: () => {},
        onResize: () => ({ dispose: () => {} }),
      },
      setVisible: () => {},
      dispose: () => {},
    }),
  })) as unknown as React.ComponentProps<typeof ThreadTerminal>["loadEmulator"];

const restart = JSON.stringify({ v: 1, type: "restart" });

function StackedHarness({ terminal }: { readonly terminal: React.ReactNode }) {
  const [layout, setLayout] = React.useState(() =>
    paneLayoutWith(["terminal"]),
  );
  const dispatch = (action: PaneLayoutAction) =>
    setLayout((current) => reducePaneLayout(current, action));
  const contents: PaneContents = {
    agent: <div>Agent</div>,
    views: { terminal },
    file: () => null,
    dirtyTabs: new Set(),
  };
  return (
    <div
      className="thread-page"
      style={{ display: "flex", flexDirection: "column", height: "100vh" }}
    >
      <ThreadStackedLayout
        layout={layout}
        contents={contents}
        dispatch={dispatch}
      />
    </div>
  );
}

afterEach(async () => {
  document.body.replaceChildren();
  FakeSocket.instances = [];
  vi.unstubAllGlobals();
  await page.viewport(1280, 800);
});

describe("the phone Terminal with a changed environment", () => {
  it("keeps every key bar key tappable and refreshes from Terminal Actions", async () => {
    await page.viewport(390, 844);
    vi.stubGlobal("WebSocket", FakeSocket);
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirm);
    document.body.style.margin = "0";
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <StackedHarness
          terminal={
            <ThreadTerminal
              loadEmulator={loadEmulator}
              threadId={"thr_00000000-0000-4000-8000-000000001118" as ThreadId}
            />
          }
        />,
      ),
    );
    const terminalTab = container.querySelector<HTMLButtonElement>(
      'button[role="tab"][aria-label="Terminal"]',
    );
    await React.act(() => terminalTab?.click());
    await React.act(async () => {});
    const socket = FakeSocket.instances.at(-1) as FakeSocket;
    socket.emit("open");
    await React.act(async () => {});
    await React.act(() =>
      socket.emit(
        "message",
        JSON.stringify({
          v: 1,
          type: "ready",
          terminal: "default",
          dimensions: { columns: 40, rows: 30 },
          replayBytes: 2,
          replayTruncated: false,
          restartRequired: true,
        }),
      ),
    );

    const notice = container.querySelector<HTMLElement>(
      ".thread-terminal-environment-notice",
    );
    expect(notice?.textContent).toBe(
      "Environment changed. Use Terminal Actions to refresh and restart.",
    );
    const keyBar = container.querySelector<HTMLElement>(".terminal-keys");
    expect(keyBar).not.toBeNull();
    const noticeBox = notice?.getBoundingClientRect() as DOMRect;
    const keyBarBox = keyBar?.getBoundingClientRect() as DOMRect;
    expect(noticeBox.bottom).toBeLessThanOrEqual(keyBarBox.top);
    const keys = [
      ...container.querySelectorAll<HTMLButtonElement>(".terminal-key"),
    ];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const box = key.getBoundingClientRect();
      if (box.left < 0 || box.right > window.innerWidth) continue;
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      expect(key.contains(hit), key.getAttribute("aria-label") ?? "").toBe(
        true,
      );
    }

    const actions = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Terminal Actions"]',
    );
    expect(actions).not.toBeNull();
    const actionsBox = actions?.getBoundingClientRect() as DOMRect;
    expect(actionsBox.width).toBeGreaterThanOrEqual(32);
    expect(actionsBox.height).toBeGreaterThanOrEqual(32);
    expect(
      actions?.contains(
        document.elementFromPoint(
          actionsBox.left + actionsBox.width / 2,
          actionsBox.top + actionsBox.height / 2,
        ),
      ),
    ).toBe(true);
    await React.act(() => actions?.click());
    await React.act(async () => {});
    const item = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((candidate) =>
      candidate.textContent?.includes("Refresh Environment"),
    );
    expect(item?.form).toBe(container.querySelector("form"));
    await React.act(() => item?.click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(socket.sent.filter((value) => value === restart)).toHaveLength(1);
    await React.act(() => root.unmount());
  });
});
