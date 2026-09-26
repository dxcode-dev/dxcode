// @vitest-environment happy-dom

import type { ProjectData, ThreadData } from "@dx/api";
import type { UserId } from "@dx/domain";
import { DateTime } from "effect";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const archive = vi.hoisted(() => ({
  setArchived: vi.fn(),
  pendingThreadId: undefined as ThreadData["id"] | undefined,
}));

vi.mock("../../shared/thread-archive.js", () => ({
  useThreadArchive: () => archive,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    className,
    onClick,
    to,
  }: {
    readonly children: React.ReactNode;
    readonly className?: string;
    readonly onClick?: () => void;
    readonly to: string;
  }) => (
    <a className={className} href={to} onClick={onClick}>
      {children}
    </a>
  ),
  useLocation: ({
    select,
  }: {
    readonly select: (location: { readonly pathname: string }) => unknown;
  }) => select({ pathname: "/" }),
  useNavigate: () => vi.fn(),
}));

vi.mock("./sidebar-account-menu.js", () => ({
  SidebarAccountMenu: () => null,
}));

vi.mock("../../shared/new-thread-surface.js", () => ({
  useNewThreadSurface: () => ({
    openNewThread: vi.fn(),
  }),
}));

vi.mock("./thread-hover-preview.js", () => ({
  ThreadHoverPreview: ({
    thread,
    onPointerEnter,
    onPointerLeave,
  }: {
    readonly thread: ThreadData;
    readonly onPointerEnter: () => void;
    readonly onPointerLeave: () => void;
  }) => (
    <aside
      aria-label={`Preview ${thread.id}`}
      data-activity-status={thread.activityStatus}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    />
  ),
}));

import { AppSidebar } from "./app-sidebar.js";

const act = React.act;
const userId = "user-1" as UserId;
const project = {
  id: "project-1",
  name: "Project",
} as unknown as ProjectData;
const threads = [
  {
    id: "thread-1",
    projectId: project.id,
    title: "First thread",
    createdAt: DateTime.makeUnsafe("2026-08-25T10:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-08-25T11:00:00.000Z"),
    lastActivityAt: DateTime.makeUnsafe("2026-08-25T11:00:00.000Z"),
    lifecycleState: "active",
  },
  {
    id: "thread-2",
    projectId: project.id,
    title: "Second thread",
    createdAt: DateTime.makeUnsafe("2026-08-25T10:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-08-25T12:00:00.000Z"),
    lastActivityAt: DateTime.makeUnsafe("2026-08-25T12:00:00.000Z"),
    lifecycleState: "active",
  },
] as unknown as ReadonlyArray<ThreadData>;

const dispatchPointer = (element: Element, type: "over" | "out") => {
  element.dispatchEvent(new Event(`pointer${type}`, { bubbles: true }));
};

const requiredThreadRow = (root: ParentNode, title: string) => {
  const row = [...root.querySelectorAll<HTMLElement>(".thread-row-shell")].find(
    (element) => element.textContent?.includes(title),
  );
  if (!row) throw new Error(`Missing thread row: ${title}`);
  return row;
};

const requiredElement = (root: ParentNode, label: string) => {
  const element = root.querySelector(`[aria-label="${label}"]`);
  if (element === null) throw new Error(`Missing test element: ${label}`);
  return element;
};

describe("sidebar thread preview intent", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mounted: boolean;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T13:00:00Z"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mounted = true;
    await act(() =>
      root.render(
        <AppSidebar
          userId={userId}
          projects={[project]}
          threads={threads}
          onCollapse={vi.fn()}
          onNavigate={vi.fn()}
          onLoadMore={vi.fn()}
          loadingMore={false}
          hasMore={false}
        />,
      ),
    );
  });

  afterEach(async () => {
    if (mounted) await act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("keeps the toolbar free of deployment labels and organization controls", () => {
    expect(container.querySelector(".deployment-identity")).toBeNull();
    expect(container.querySelector('[aria-label="Organize"]')).toBeNull();
    expect(container.querySelector(".dx-wordmark")?.textContent).toBe("dx");
  });

  it("opens on the trailing edge after a 500 ms dwell and switches primed rows immediately", async () => {
    const first = requiredThreadRow(container, "First thread");
    const second = requiredThreadRow(container, "Second thread");

    await act(() => dispatchPointer(first, "over"));
    await act(() => vi.advanceTimersByTime(499));
    expect(
      document.querySelector('[aria-label="Preview thread-1"]'),
    ).toBeNull();

    await act(() => vi.advanceTimersByTime(1));
    expect(
      document.querySelector('[aria-label="Preview thread-1"]'),
    ).not.toBeNull();

    await act(() => dispatchPointer(second, "over"));
    expect(
      document.querySelector('[aria-label="Preview thread-2"]'),
    ).not.toBeNull();

    await act(() => dispatchPointer(second, "out"));
    await act(() => vi.advanceTimersByTime(159));
    expect(
      document.querySelector('[aria-label="Preview thread-2"]'),
    ).not.toBeNull();
    await act(() => vi.advanceTimersByTime(1));
    expect(
      document.querySelector('[aria-label="Preview thread-2"]'),
    ).toBeNull();
  });

  it("cancels a pending open on leave and a pending close on preview re-entry", async () => {
    const first = requiredThreadRow(container, "First thread");

    await act(() => dispatchPointer(first, "over"));
    await act(() => vi.advanceTimersByTime(300));
    await act(() => dispatchPointer(first, "out"));
    await act(() => vi.advanceTimersByTime(500));
    expect(
      document.querySelector('[aria-label="Preview thread-1"]'),
    ).toBeNull();

    await act(() => dispatchPointer(first, "over"));
    await act(() => vi.advanceTimersByTime(500));
    const preview = requiredElement(document, "Preview thread-1");

    await act(() => dispatchPointer(first, "out"));
    await act(() => vi.advanceTimersByTime(100));
    await act(() => dispatchPointer(preview, "over"));
    await act(() => vi.advanceTimersByTime(100));
    expect(
      document.querySelector('[aria-label="Preview thread-1"]'),
    ).not.toBeNull();
  });

  it("updates an open preview when the sidebar list settles activity", async () => {
    const first = requiredThreadRow(container, "First thread");
    await act(() => dispatchPointer(first, "over"));
    await act(() => vi.advanceTimersByTime(500));

    const workingThreads = threads.map((thread) =>
      thread.id === "thread-1"
        ? ({ ...thread, activityStatus: "working" } as ThreadData)
        : thread,
    );
    await act(() =>
      root.render(
        <AppSidebar
          userId={userId}
          projects={[project]}
          threads={workingThreads}
          onCollapse={vi.fn()}
          onNavigate={vi.fn()}
          onLoadMore={vi.fn()}
          loadingMore={false}
          hasMore={false}
        />,
      ),
    );

    expect(
      requiredElement(document, "Preview thread-1").getAttribute(
        "data-activity-status",
      ),
    ).toBe("working");
  });

  it("dismisses on thread click and waits for the pointer to leave before hovering that selected row again", async () => {
    const first = requiredThreadRow(container, "First thread");
    const link = first.querySelector("a");
    if (link === null) throw new Error("Missing first thread link");

    await act(() => dispatchPointer(first, "over"));
    await act(() => vi.advanceTimersByTime(500));
    expect(
      document.querySelector('[aria-label="Preview thread-1"]'),
    ).not.toBeNull();

    await act(() =>
      link.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(
      document.querySelector('[aria-label="Preview thread-1"]'),
    ).toBeNull();
    await act(() => vi.advanceTimersByTime(500));
    expect(
      document.querySelector('[aria-label="Preview thread-1"]'),
    ).toBeNull();

    await act(() => dispatchPointer(first, "out"));
    await act(() => dispatchPointer(first, "over"));
    await act(() => vi.advanceTimersByTime(499));
    expect(
      document.querySelector('[aria-label="Preview thread-1"]'),
    ).toBeNull();
    await act(() => vi.advanceTimersByTime(1));
    expect(
      document.querySelector('[aria-label="Preview thread-1"]'),
    ).not.toBeNull();
  });

  it("cancels pending hover on click without suppressing a later hover on another row", async () => {
    const first = requiredThreadRow(container, "First thread");
    const second = requiredThreadRow(container, "Second thread");
    const firstLink = first.querySelector("a");
    if (firstLink === null) throw new Error("Missing first thread link");

    await act(() => dispatchPointer(first, "over"));
    await act(() => vi.advanceTimersByTime(499));
    await act(() =>
      firstLink.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await act(() => vi.advanceTimersByTime(1));
    expect(
      document.querySelector('[aria-label="Preview thread-1"]'),
    ).toBeNull();

    await act(() => dispatchPointer(first, "out"));
    await act(() =>
      firstLink.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await act(() => dispatchPointer(second, "over"));
    await act(() => vi.advanceTimersByTime(500));
    expect(
      document.querySelector('[aria-label="Preview thread-2"]'),
    ).not.toBeNull();
  });

  it("cancels pending intent when the sidebar unmounts", async () => {
    const first = requiredThreadRow(container, "First thread");

    await act(() => dispatchPointer(first, "over"));
    expect(vi.getTimerCount()).toBe(1);

    await act(() => root.unmount());
    mounted = false;
    expect(vi.getTimerCount()).toBe(0);
    await act(() => vi.runAllTimers());
    expect(
      document.querySelector('[aria-label="Preview thread-1"]'),
    ).toBeNull();
  });

  it("shows Projects while Puck and Activity are unavailable", () => {
    const dock = container.querySelector('[aria-label="Primary navigation"]');
    expect(dock).not.toBeNull();
    expect(dock?.children).toHaveLength(1);
    expect(
      Array.from(dock?.children ?? [], (item) => item.textContent?.trim()),
    ).toEqual(["Projects"]);
    expect(dock?.querySelectorAll("button:disabled")).toHaveLength(0);
    expect(dock?.querySelector('a[href="/projects"]')).not.toBeNull();
    expect(dock?.querySelectorAll("svg")).toHaveLength(1);
  });

  it("hides the unavailable Multiplayer destination", () => {
    expect(container.textContent).not.toContain("Multiplayer");
    expect(
      container.querySelector('[title="Multiplayer is not available yet"]'),
    ).toBeNull();
  });

  it.each([false, true])(
    "shows only an available archive when there are no active threads: %s",
    async (archiveAvailable) => {
      await act(() =>
        root.render(
          <AppSidebar
            userId={"user-1" as never}
            archiveAvailable={archiveAvailable}
            projects={[project]}
            threads={[]}
            onCollapse={vi.fn()}
            onNavigate={vi.fn()}
            onLoadMore={vi.fn()}
            loadingMore={false}
            hasMore={false}
          />,
        ),
      );
      expect(container.textContent).not.toContain("Multiplayer");
      expect(
        container.querySelector('[data-thread-section="inactive"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-thread-section="archived"]') !== null,
      ).toBe(archiveAvailable);
    },
  );

  it("starts inactive threads collapsed and reveals them on demand", async () => {
    const inactive = {
      ...threads[0],
      lastActivityAt: DateTime.makeUnsafe("2026-08-20T10:00:00Z"),
    } as ThreadData;
    await act(() =>
      root.render(
        <AppSidebar
          projects={[project]}
          threads={[inactive]}
          onCollapse={vi.fn()}
          onNavigate={vi.fn()}
          onLoadMore={vi.fn()}
          loadingMore={false}
          hasMore={false}
        />,
      ),
    );
    const section = container.querySelector('[data-thread-section="inactive"]');
    expect(
      section?.querySelector("button")?.getAttribute("data-collapsed"),
    ).toBe("true");
    expect(section?.textContent).not.toContain("First thread");
    await act(() =>
      section
        ?.querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(section?.textContent).toContain("First thread");
  });

  it("keeps archived Threads in a separate default-collapsed section", async () => {
    const archived = {
      ...threads[1],
      id: "thread-archived",
      title: "Archived thread title",
      lifecycleState: "archived",
    } as ThreadData;
    const active = threads[0];
    if (active === undefined) throw new Error("Missing active Thread fixture");

    await act(() =>
      root.render(
        <AppSidebar
          projects={[project]}
          threads={[active, archived]}
          onCollapse={vi.fn()}
          onNavigate={vi.fn()}
          onLoadMore={vi.fn()}
          loadingMore={false}
          hasMore={false}
        />,
      ),
    );

    const archivedSection = container.querySelector(
      '[data-thread-section="archived"]',
    );
    expect(
      archivedSection?.querySelector("button")?.getAttribute("data-collapsed"),
    ).toBe("true");
    expect(archivedSection?.textContent).toContain("Archived1");
    expect(archivedSection?.textContent).not.toContain("Archived thread title");
    expect(
      container.querySelector('[data-thread-section="project-1"]')?.textContent,
    ).toContain("First thread");
    expect(
      container.querySelector('[data-thread-section="project-1"]')?.textContent,
    ).not.toContain("Archived thread title");

    await act(() =>
      archivedSection
        ?.querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(
      container.querySelector('[data-thread-section="archived"]')?.textContent,
    ).toContain("Archived thread title");
  });
});

describe("sidebar extension composition", () => {
  it("places supplied presentation between threads and primary navigation without Multiplayer", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(() =>
      root.render(
        <AppSidebar
          projects={[project]}
          threads={threads}
          onCollapse={vi.fn()}
          onNavigate={vi.fn()}
          onLoadMore={vi.fn()}
          loadingMore={false}
          hasMore={false}
          extensionRegion={<div data-testid="extension-region" />}
        />,
      ),
    );

    const extension = container.querySelector(
      '[data-testid="extension-region"]',
    );
    expect(extension?.previousElementSibling?.getAttribute("aria-label")).toBe(
      "Threads",
    );
    expect(container.textContent).not.toContain("Multiplayer");
    expect(extension?.nextElementSibling?.getAttribute("aria-label")).toBe(
      "Primary navigation",
    );

    await act(() => root.unmount());
    container.remove();
  });
});

describe("mobile sidebar commands", () => {
  it("closes the mobile drawer before opening thread search", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onNavigate = vi.fn();
    const onOpenSearch = vi.fn();

    await act(() =>
      root.render(
        <AppSidebar
          projects={[project]}
          threads={threads}
          collapseLabel="Close sidebar"
          onCollapse={vi.fn()}
          onNavigate={onNavigate}
          onOpenSearch={onOpenSearch}
          onLoadMore={vi.fn()}
          loadingMore={false}
          hasMore={false}
        />,
      ),
    );

    await act(() =>
      requiredElement(container, "Search threads").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      ),
    );

    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onOpenSearch).toHaveBeenCalledOnce();

    await act(() => root.unmount());
    container.remove();
  });
});
