// @vitest-environment happy-dom

import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadContextMenu } from "./thread-context-menu.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const thread = {
  id: "thr_00000000-0000-4000-8000-000000000081",
  lifecycleState: "active" as const,
  pinnedAt: undefined,
};

describe("Thread context archive touchpoints", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  const renderMenu = async (lifecycleState: "active" | "archived") => {
    const onSetArchived = vi.fn();
    const onSetPinned = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <ThreadContextMenu
          thread={{ ...thread, lifecycleState }}
          onSetArchived={onSetArchived}
          onSetPinned={onSetPinned}
          archiving={false}
          pinning={false}
        >
          <div>Thread row</div>
        </ThreadContextMenu>,
      ),
    );
    const trigger = container.querySelector(".thread-context-trigger");
    if (trigger === null) throw new Error("Expected context menu trigger.");
    return { container, onSetArchived, root, trigger };
  };

  it("offers Archive from the desktop context menu", async () => {
    const mounted = await renderMenu("active");
    await React.act(() =>
      mounted.trigger.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      ),
    );

    const menu = document.querySelector(".thread-context-menu");
    expect(menu?.textContent).toContain("Pin");
    expect(menu?.textContent).not.toContain("Hide");
    expect(menu?.textContent).toContain("Archive");
    expect(menu?.textContent).toContain("Copy Thread URL");
    const archive = Array.from(
      document.querySelectorAll<HTMLElement>(".thread-context-item"),
    ).find((item) => item.textContent?.trim() === "Archive");
    await React.act(() => archive?.click());
    expect(mounted.onSetArchived).toHaveBeenCalledExactlyOnceWith(true);
    await React.act(() => mounted.root.unmount());
  });

  it("omits Hide after a 500 ms mobile long press", async () => {
    const mounted = await renderMenu("active");
    const touchStart = new Event("touchstart", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(touchStart, "touches", {
      value: [{ clientX: 24, clientY: 32 }],
    });

    await React.act(() => mounted.trigger.dispatchEvent(touchStart));
    await React.act(() => vi.advanceTimersByTime(499));
    expect(document.querySelector(".thread-context-menu")).toBeNull();
    await React.act(() => vi.advanceTimersByTime(1));

    const menu = document.querySelector(".thread-context-menu");
    expect(menu?.textContent).toContain("Archive");
    expect(menu?.textContent).toContain("Copy Thread URL");
    expect(menu?.textContent).not.toContain("Hide");
    const archive = Array.from(
      document.querySelectorAll<HTMLElement>(".thread-context-item"),
    ).find((item) => item.textContent?.trim() === "Archive");
    await React.act(() => archive?.click());
    expect(mounted.onSetArchived).toHaveBeenCalledExactlyOnceWith(true);
    await React.act(() => mounted.root.unmount());
  });

  it("omits Hide for a keyboard-generated context-menu event", async () => {
    const mounted = await renderMenu("active");
    await React.act(() =>
      mounted.trigger.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          detail: 0,
        }),
      ),
    );

    const menu = document.querySelector(".thread-context-menu");
    expect(menu?.textContent).toContain("Archive");
    expect(menu?.textContent).not.toContain("Hide");
    await React.act(() => mounted.root.unmount());
  });
});
