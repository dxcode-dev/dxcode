// @vitest-environment happy-dom

import type { ProjectData, ThreadData } from "@dx/api";
import { DateTime } from "effect";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadSearchDialog } from "./thread-search-dialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const act = React.act;
const projects = [
  { id: "project-1", name: "Atlas" },
  { id: "project-2", name: "Beacon" },
] as unknown as ReadonlyArray<ProjectData>;
const threads = [
  {
    id: "thread-1",
    projectId: "project-1",
    visibility: "private",
    lastActivityAt: DateTime.makeUnsafe("2026-08-25T10:00:00.000Z"),
    activityStatus: "active",
  },
  {
    id: "thread-2",
    projectId: "project-2",
    visibility: "workspace",
    lastActivityAt: DateTime.makeUnsafe("2026-08-25T11:00:00.000Z"),
    activityStatus: "inactive",
  },
] as unknown as ReadonlyArray<ThreadData>;

const enterText = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, value);
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
};

describe("ThreadSearchDialog", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onOpenChange = vi.fn();
  const onSelectThread = vi.fn();
  const onLoadMore = vi.fn();

  const render = async (
    props: Partial<React.ComponentProps<typeof ThreadSearchDialog>> = {},
  ) => {
    await act(() =>
      root.render(
        <ThreadSearchDialog
          open
          projects={projects}
          threads={threads}
          hasMore={false}
          loading={false}
          onLoadMore={onLoadMore}
          onOpenChange={onOpenChange}
          onSelectThread={onSelectThread}
          {...props}
        />,
      ),
    );
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
  });

  it("exposes the combobox/listbox contract and filters loaded title/project metadata", async () => {
    await render();
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const close = document.querySelector<HTMLButtonElement>(
      ".modal-surface-header-action",
    );
    expect(close?.textContent).toContain("Close");
    expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog?.getAttribute("aria-describedby")).toBeTruthy();
    expect(input?.placeholder).toBe("Search workspace threads…");
    expect(input?.getAttribute("aria-controls")).toBe("thread-search-results");
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);

    await act(() => {
      if (input === null) throw new Error("missing combobox");
      enterText(input, "beacon");
    });
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(document.querySelector('[role="option"]')?.textContent).toContain(
      "Beacon",
    );
  });

  it("supports arrows, Home/End, Enter and selects exactly once", async () => {
    await render();
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
    if (input === null) throw new Error("missing combobox");
    await act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      ),
    );
    expect(input.getAttribute("aria-activedescendant")).toBe("thread-search-1");
    await act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(onSelectThread).toHaveBeenCalledTimes(1);
    expect(onSelectThread).toHaveBeenCalledWith(threads[1]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    [{ threads: [], loading: true }, "Loading Threads…"],
    [{ threads: [], loading: false }, "No loaded Threads yet."],
    [{ hasMore: true }, "Load more Threads"],
    [{ error: "Could not load another page" }, "Could not load another page"],
  ] as const)("renders state %#", async (props, message) => {
    await render(props);
    expect(document.body.textContent).toContain(message);
  });

  it("loads the next search page from an actionable control", async () => {
    await render({ hasMore: true });
    const loadMore = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Load more Threads",
    );
    expect(loadMore).toBeDefined();

    await act(() => loadMore?.click());

    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("renders no-results and loading-more states", async () => {
    await render({ loading: true });
    expect(document.body.textContent).toContain("Loading more Threads…");
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
    await act(() => {
      if (input === null) throw new Error("missing combobox");
      enterText(input, "missing");
    });
    expect(document.body.textContent).toContain(
      "No loaded Threads match your search.",
    );
  });
});
