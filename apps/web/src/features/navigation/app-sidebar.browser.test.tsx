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

vi.mock("../../shared/thread-archive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/thread-archive.js")>()),
  useThreadArchive: () => archive,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
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
    <a
      className={className}
      href={to}
      // A real anchor would navigate the test page away.
      onClick={(event) => {
        event.preventDefault();
        onClick?.();
      }}
    >
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

vi.mock("./sidebar-account-menu.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sidebar-account-menu.js")>()),
  SidebarAccountMenu: () => null,
}));

vi.mock("./notification-inbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./notification-inbox.js")>()),
  NotificationInbox: () => null,
}));

vi.mock("./needs-you-inbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./needs-you-inbox.js")>()),
  NeedsYouInbox: () => null,
}));

vi.mock("../../shared/new-thread-surface.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../shared/new-thread-surface.js")
  >()),
  useNewThreadSurface: () => ({
    openNewThread: vi.fn(),
  }),
}));

vi.mock("./thread-hover-preview.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thread-hover-preview.js")>()),
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

// These cases cover preview intent; the synced layout has its own journey.
vi.mock("./sidebar-layout.js", async (importOriginal) => {
  const layout = await importOriginal<typeof import("./sidebar-layout.js")>();
  return {
    ...layout,
    useSyncedSidebarLayout: () => layout.useLocalSidebarLayout(),
  };
});

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
    // These tests drive hover with dispatched pointer events. An earlier
    // file's real click can leave Playwright's cursor where these rows
    // render; Chromium then sends its own pointerover at a random step and
    // restarts the 500 ms intent (#1296). Rows that real input cannot hit
    // see only the dispatched events.
    container.style.pointerEvents = "none";
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
      link.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      ),
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
      firstLink.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      ),
    );
    await act(() => vi.advanceTimersByTime(1));
    expect(
      document.querySelector('[aria-label="Preview thread-1"]'),
    ).toBeNull();

    await act(() => dispatchPointer(first, "out"));
    await act(() =>
      firstLink.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      ),
    );
    await act(() => dispatchPointer(second, "over"));
    await act(() => vi.advanceTimersByTime(500));
    expect(
      document.querySelector('[aria-label="Preview thread-2"]'),
    ).not.toBeNull();
  });

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
        ?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        ),
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
        ?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        ),
    );
    expect(
      container.querySelector('[data-thread-section="archived"]')?.textContent,
    ).toContain("Archived thread title");
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
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      ),
    );

    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onOpenSearch).toHaveBeenCalledOnce();

    await act(() => root.unmount());
    container.remove();
  });
});
