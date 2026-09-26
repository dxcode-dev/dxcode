// @vitest-environment happy-dom

import type { ThreadData } from "@dx/api";
import type { ProjectId, ThreadId } from "@dx/domain";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params: _params,
    to: _to,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    readonly params: unknown;
    readonly to: string;
  }) => (
    <a href="/thread" {...props}>
      {children}
    </a>
  ),
}));

vi.mock("./thread-context-menu.js", () => ({
  ThreadContextMenu: ({ children }: { readonly children: React.ReactNode }) =>
    children,
}));

import { optimisticThreadData } from "../threads/thread-mutations.js";
import { SidebarThreadNavigation } from "./sidebar-thread-navigation.js";

const threadId = "thread-1" as ThreadId;
const projectId = "project-1" as ProjectId;
const thread = {
  id: threadId,
  projectId,
  title: "Resolved thread title",
  lifecycleState: "active",
  activityStatus: "idle",
} as unknown as ThreadData;
const active = {
  ...thread,
  id: "thr_00000000-0000-4000-8000-000000000091" as ThreadId,
  title: "Active thread",
} as ThreadData;
const archived = {
  ...active,
  id: "thr_00000000-0000-4000-8000-000000000092" as ThreadId,
  title: "Archived thread",
  lifecycleState: "archived",
  activityStatus: "working",
} as ThreadData;
const working = {
  ...active,
  id: "thr_00000000-0000-4000-8000-000000000093" as ThreadId,
  title: "Working thread",
  activityStatus: "working",
} as ThreadData;

const navigation = () => (
  <SidebarThreadNavigation
    collapsedGroups={new Set()}
    hasMore={false}
    loadingMore={false}
    projectNames={new Map([[projectId, "Project"]])}
    query=""
    sections={[{ id: "recent", threads: [thread] }]}
    visibleThreadCount={1}
    onLoadMore={vi.fn()}
    onNavigate={vi.fn()}
    onThreadNavigate={vi.fn()}
    onThreadPointerEnter={vi.fn()}
    onThreadPointerLeave={vi.fn()}
    onToggleGroup={vi.fn()}
    onSetArchived={vi.fn()}
    onSetPinned={vi.fn()}
  />
);

afterEach(() => {
  document.body.replaceChildren();
});

describe("sidebar thread title", () => {
  it("renders the server-owned title", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await React.act(() => root.render(navigation()));
    expect(container.textContent).toContain("Resolved thread title");
    await React.act(() => root.unmount());
  });
});

describe("sidebar selection and pending titles", () => {
  it("moves selection to one optimistic row, then reconciles its canonical title and failure route", async () => {
    const optimistic = optimisticThreadData(
      "thr_00000000-0000-4000-8000-000000000094" as ThreadId,
      projectId,
      "Candidate title" as ThreadData["title"],
    );
    const canonical = {
      ...thread,
      id: optimistic.id,
      title: "Canonical title",
    } as ThreadData;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (
      threads: ReadonlyArray<ThreadData>,
      activeThreadId: string,
    ) =>
      root.render(
        <SidebarThreadNavigation
          activeThreadId={activeThreadId}
          collapsedGroups={new Set()}
          hasMore={false}
          loadingMore={false}
          projectNames={new Map([[projectId, "Project"]])}
          query=""
          sections={[{ id: "project", threads }]}
          visibleThreadCount={threads.length}
          onLoadMore={vi.fn()}
          onNavigate={vi.fn()}
          onThreadNavigate={vi.fn()}
          onThreadPointerEnter={vi.fn()}
          onThreadPointerLeave={vi.fn()}
          onToggleGroup={vi.fn()}
          onSetArchived={vi.fn()}
          onSetPinned={vi.fn()}
        />,
      );

    await React.act(() => render([thread, optimistic], thread.id));
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(
      container.querySelector(".thread-row.selected")?.textContent,
    ).toContain("Resolved thread title");

    await React.act(() => render([thread, optimistic], optimistic.id));
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(
      container.querySelector(".thread-row.selected .thread-title-pending"),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Candidate title");

    await React.act(() => render([thread, canonical], canonical.id));
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(container.querySelector(".thread-title-pending")).toBeNull();
    expect(container.textContent).toContain("Canonical title");

    await React.act(() => render([thread], thread.id));
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(
      container.querySelector(".thread-row.selected")?.textContent,
    ).toContain("Resolved thread title");
    await React.act(() => root.unmount());
  });

  it("keeps a projectless pending Thread selected without fabricating a Project", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const pendingId = "thr_00000000-0000-4000-8000-000000000095" as ThreadId;
    const render = (threads: ReadonlyArray<ThreadData>) =>
      root.render(
        <SidebarThreadNavigation
          activeThreadId={pendingId}
          collapsedGroups={new Set()}
          hasMore={false}
          loadingMore={false}
          pendingCreation={{ id: pendingId }}
          projectNames={new Map([[projectId, "Project"]])}
          query=""
          sections={threads.length === 0 ? [] : [{ id: "project", threads }]}
          visibleThreadCount={threads.length}
          onLoadMore={vi.fn()}
          onNavigate={vi.fn()}
          onThreadNavigate={vi.fn()}
          onThreadPointerEnter={vi.fn()}
          onThreadPointerLeave={vi.fn()}
          onToggleGroup={vi.fn()}
          onSetArchived={vi.fn()}
          onSetPinned={vi.fn()}
        />,
      );

    await React.act(() => render([]));

    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(container.querySelector("[data-pending-thread-row]")).not.toBeNull();
    expect(container.textContent).not.toContain("Create new thread");

    const canonical = {
      ...thread,
      id: pendingId,
      title: "Canonical pending title",
    } as ThreadData;
    await React.act(() => render([canonical]));

    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(container.querySelector("[data-pending-thread-row]")).toBeNull();
    expect(container.textContent).toContain("Canonical pending title");
    await React.act(() => root.unmount());
  });

  it("makes a focused pending row the keyboard-command target", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const pendingId = "thr_00000000-0000-4000-8000-000000000096" as ThreadId;

    await React.act(() =>
      root.render(
        <SidebarThreadNavigation
          activeThreadId={pendingId}
          collapsedGroups={new Set()}
          hasMore={false}
          loadingMore={false}
          pendingCreation={{ id: pendingId }}
          projectNames={new Map([[projectId, "Project"]])}
          query=""
          sections={[{ id: "project", threads: [thread] }]}
          visibleThreadCount={1}
          onLoadMore={vi.fn()}
          onNavigate={vi.fn()}
          onThreadNavigate={vi.fn()}
          onThreadPointerEnter={vi.fn()}
          onThreadPointerLeave={vi.fn()}
          onToggleGroup={vi.fn()}
          onSetArchived={vi.fn()}
          onSetPinned={vi.fn()}
        />,
      ),
    );

    const canonicalRow = container.querySelector<HTMLElement>(
      `[data-command-sidebar-item]:not([aria-current="page"])`,
    );
    const pendingRow = container.querySelector<HTMLElement>(
      "[data-pending-thread-row] [data-command-sidebar-item]",
    );
    canonicalRow?.focus();
    expect(canonicalRow?.dataset.commandFocused).toBe("true");
    pendingRow?.focus();
    expect(pendingRow?.dataset.commandFocused).toBe("true");
    expect(canonicalRow?.dataset.commandFocused).toBeUndefined();
    await React.act(() => root.unmount());
  });
});

describe("sidebar archive hover actions", () => {
  it("archives active rows and unarchives archived rows from their hover controls", async () => {
    const onSetArchived = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <SidebarThreadNavigation
          collapsedGroups={new Set()}
          hasMore={false}
          loadingMore={false}
          projectNames={new Map([[active.projectId, "Project"]])}
          query=""
          sections={[
            { id: "project", threads: [active] },
            { id: "archived", label: "Archived", threads: [archived] },
          ]}
          visibleThreadCount={2}
          onLoadMore={vi.fn()}
          onNavigate={vi.fn()}
          onThreadNavigate={vi.fn()}
          onThreadPointerEnter={vi.fn()}
          onThreadPointerLeave={vi.fn()}
          onToggleGroup={vi.fn()}
          onSetArchived={onSetArchived}
          onSetPinned={vi.fn()}
        />,
      ),
    );

    const archive = container.querySelector('[aria-label="Archive thread"]');
    const unarchive = container.querySelector(
      '[aria-label="Unarchive thread"]',
    );
    expect(archive).not.toBeNull();
    expect(unarchive).not.toBeNull();
    expect(container.querySelector('[aria-label="Orb paused"]')).not.toBeNull();
    expect(
      container
        .querySelector('[aria-label="Orb paused"]')
        ?.getAttribute("data-working-animation"),
    ).toBeNull();

    await React.act(() =>
      archive?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await React.act(() =>
      unarchive?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onSetArchived).toHaveBeenNthCalledWith(1, active.id, true);
    expect(onSetArchived).toHaveBeenNthCalledWith(2, archived.id, false);
    await React.act(() => root.unmount());
  });
});

describe("sidebar Orb activity", () => {
  it("uses baseline Thread activity for accessible idle and working states", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <SidebarThreadNavigation
          collapsedGroups={new Set()}
          hasMore={false}
          loadingMore={false}
          projectNames={new Map([[projectId, "Project"]])}
          query=""
          sections={[{ id: "project", threads: [active, working] }]}
          visibleThreadCount={2}
          onLoadMore={vi.fn()}
          onNavigate={vi.fn()}
          onThreadNavigate={vi.fn()}
          onThreadPointerEnter={vi.fn()}
          onThreadPointerLeave={vi.fn()}
          onToggleGroup={vi.fn()}
          onSetArchived={vi.fn()}
          onSetPinned={vi.fn()}
        />,
      ),
    );

    const idleOrb = container.querySelector('[aria-label="Orb idle"]');
    const workingOrb = container.querySelector('[aria-label="Orb working"]');
    expect(idleOrb?.getAttribute("data-working-animation")).toBeNull();
    expect(workingOrb?.getAttribute("data-working-animation")).toBe(
      "inner-arc",
    );
    expect(workingOrb?.querySelector(".activity-inner-arc")).not.toBeNull();

    await React.act(() => root.unmount());
  });
});
