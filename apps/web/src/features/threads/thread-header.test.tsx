// @vitest-environment happy-dom

import type { ThreadDetailData } from "@dx/api";
import { defaultThreadModelSelection } from "@dx/domain";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const archive = vi.hoisted(() => ({
  pendingThreadId: undefined,
  setArchived: vi.fn(),
}));

vi.mock("../../shared/thread-archive.js", () => ({
  useOptionalThreadArchive: () => archive,
}));

import { ThreadHeader } from "./thread-header.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const thread = {
  id: "thr_00000000-0000-4000-8000-000000000096",
  title:
    "A long authoritative title that remains available without replacing it with display text",
  visibility: "private",
  lifecycleState: "active",
  activityStatus: "idle",
  agentInitialization: { selection: defaultThreadModelSelection() },
} as ThreadDetailData;

const model = {
  rows: [],
  turns: [],
  outline: [],
  capabilities: {
    paging: { available: false as const },
    subagents: { available: false as const },
  },
};

afterEach(() => {
  archive.setArchived.mockReset();
  document.body.replaceChildren();
});

describe("ThreadHeader", () => {
  const render = async (element: React.ReactNode) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(() => root.render(element));
    return container;
  };

  it("shows the loading title instead of the fallback while it is generated", async () => {
    const container = await render(
      <ThreadHeader thread={{ ...thread, titlePending: true }} />,
    );
    const title = container.querySelector(".thread-title");
    expect(
      title?.querySelector('[role="status"]')?.getAttribute("aria-label"),
    ).toBe("Generating thread title");
    expect(title?.textContent).toBe("");
    expect(title?.getAttribute("title")).toBeNull();
  });

  it("presents authoritative metadata and the defined no-project state", async () => {
    const container = await render(<ThreadHeader thread={thread} />);
    const titleBar = container.querySelector(".thread-title-bar");
    expect(titleBar?.firstElementChild?.className).toBe("thread-title-orb");
    expect(titleBar?.children.item(1)?.className).toBe("thread-title");
    expect(
      container.querySelector(`[title="${thread.title}"]`)?.textContent,
    ).toBe(thread.title);
    expect(
      container.querySelector('[title="No project"]')?.textContent,
    ).toContain("No project");
    expect(container.querySelector('[title="Mode: medium"]')).toBeTruthy();
    expect(container.querySelector('[title="Privacy: private"]')).toBeTruthy();
    expect(
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Multiplayer is unavailable in this version"]',
        )
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("passes working and idle activity to the Orb and keeps archived Orbs idle", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await React.act(() =>
      root.render(
        <ThreadHeader
          thread={{ ...thread, activityStatus: "working" as const }}
        />,
      ),
    );
    expect(
      container
        .querySelector('[aria-label="Orb working"]')
        ?.getAttribute("data-activity-status"),
    ).toBe("working");

    await React.act(() =>
      root.render(
        <ThreadHeader
          thread={{ ...thread, activityStatus: "idle" as const }}
        />,
      ),
    );
    expect(
      container
        .querySelector('[aria-label="Orb idle"]')
        ?.getAttribute("data-activity-status"),
    ).toBe("idle");

    await React.act(() =>
      root.render(
        <ThreadHeader
          thread={{
            ...thread,
            lifecycleState: "archived" as const,
            activityStatus: "working" as const,
          }}
        />,
      ),
    );
    expect(
      container
        .querySelector('[aria-label="Orb paused"]')
        ?.getAttribute("data-activity-status"),
    ).toBe("idle");
    await React.act(() => root.unmount());
  });

  it("forwards the existing right-pane toggle callback", async () => {
    const onToggle = vi.fn();
    const container = await render(
      <ThreadHeader
        thread={thread}
        model={model}
        rightPaneCollapsed={false}
        onToggleRightPane={onToggle}
      />,
    );
    const toggle = container.querySelector('[aria-label="Hide Right Pane"]');
    expect(toggle?.parentElement?.classList.contains("thread-title-bar")).toBe(
      true,
    );
    const actions = container.querySelector('[aria-label="Thread actions"]');
    expect(
      actions && toggle
        ? actions.compareDocumentPosition(toggle) &
            Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).not.toBe(0);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    await React.act(() =>
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("keeps the right-pane toggle icon stable across open states", async () => {
    const expanded = await render(
      <ThreadHeader
        thread={thread}
        rightPaneCollapsed={false}
        onToggleRightPane={vi.fn()}
      />,
    );
    const collapsed = await render(
      <ThreadHeader
        thread={thread}
        rightPaneCollapsed
        onToggleRightPane={vi.fn()}
      />,
    );

    expect(
      expanded.querySelector(".thread-right-pane-toggle svg")?.outerHTML,
    ).toBe(collapsed.querySelector(".thread-right-pane-toggle svg")?.outerHTML);
  });

  it("archives from the open-Thread menu", async () => {
    const container = await render(
      <ThreadHeader thread={thread} model={model} />,
    );
    await React.act(() =>
      container
        .querySelector('[aria-label="Thread actions"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    const archiveItem = Array.from(
      document.querySelectorAll<HTMLElement>(".thread-menu-item"),
    ).find((item) => item.textContent?.trim() === "Archive");
    expect(archiveItem).toBeDefined();
    await React.act(() => archiveItem?.click());
    expect(archive.setArchived).toHaveBeenCalledExactlyOnceWith(
      thread.id,
      true,
    );
  });

  it("shows archived status and unarchives only from the Thread menu", async () => {
    const archived = { ...thread, lifecycleState: "archived" as const };
    const container = await render(
      <ThreadHeader thread={archived} model={model} />,
    );

    expect(container.querySelector(".thread-archived-badge")?.textContent).toBe(
      "Archived thread",
    );
    expect(container.textContent).not.toContain("Undo");
    await React.act(() =>
      container
        .querySelector('[aria-label="Thread actions"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    const unarchiveItem = Array.from(
      document.querySelectorAll<HTMLElement>(".thread-menu-item"),
    ).find((item) => item.textContent?.trim() === "Unarchive");
    expect(unarchiveItem).toBeDefined();
    await React.act(() => unarchiveItem?.click());
    expect(archive.setArchived).toHaveBeenCalledExactlyOnceWith(
      archived.id,
      false,
    );
  });
});
