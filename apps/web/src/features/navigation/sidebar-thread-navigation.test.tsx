// @vitest-environment happy-dom

import type { ProjectData, ThreadData } from "@dx/api";
import type { ProjectId, ThreadId } from "@dx/domain";
import { DateTime } from "effect";
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
import {
  buildThreadSections,
  withPendingThreads,
} from "./sidebar-thread-utils.js";

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

afterEach(() => {
  document.body.replaceChildren();
});

describe("sidebar selection and pending titles", () => {
  it("moves selection to one optimistic row, then reconciles its canonical title and failure route", async () => {
    const optimistic = optimisticThreadData(
      "thr_00000000-0000-4000-8000-000000000094" as ThreadId,
      projectId,
      "Candidate title" as ThreadData["title"],
      Date.now(),
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

  it("keeps a pending No Project Thread in the No Project section from send to listing", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const hiddenProjectId = "prj_hidden-no-project" as ProjectId;
    const pendingId = "thr_00000000-0000-4000-8000-000000000095" as ThreadId;
    const earlier = {
      ...thread,
      id: "thr_00000000-0000-4000-8000-000000000097" as ThreadId,
      projectId: hiddenProjectId,
      title: "Earlier No Project thread",
      lastActivityAt: DateTime.makeUnsafe(Date.now() - 60_000),
    } as ThreadData;
    const named = {
      ...thread,
      lastActivityAt: DateTime.makeUnsafe(Date.now() - 30_000),
    } as ThreadData;
    const projectNames = new Map([[projectId, "Project"]]);
    const pending = [
      {
        id: pendingId,
        title: "Fallback title" as ThreadData["title"],
        startedAt: Date.now(),
      },
    ];
    const render = (listed: ReadonlyArray<ThreadData>) => {
      const threads = withPendingThreads(listed, pending, projectNames, true);
      const sections = buildThreadSections(
        [{ id: projectId, name: "Project" } as ProjectData],
        threads,
        Date.now(),
      );
      return root.render(
        <SidebarThreadNavigation
          activeThreadId={pendingId}
          collapsedGroups={new Set()}
          hasMore={false}
          loadingMore={false}
          projectNames={projectNames}
          query=""
          sections={sections}
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
    };
    const placement = () => {
      const row = container.querySelector<HTMLElement>(
        '.thread-row[aria-current="page"]',
      );
      const section = row?.closest<HTMLElement>("[data-thread-section]");
      return {
        section: section?.querySelector(".thread-group-heading")?.textContent,
        index: [...(section?.querySelectorAll(".thread-row") ?? [])].indexOf(
          row as HTMLElement,
        ),
        sectionIndex: [
          ...container.querySelectorAll("[data-thread-section]"),
        ].indexOf(section as HTMLElement),
        pending: row?.querySelector(".thread-title-pending") !== null,
      };
    };

    await React.act(() => render([named, earlier]));
    expect(placement()).toEqual({
      section: expect.stringContaining("No Project"),
      index: 0,
      sectionIndex: 0,
      pending: true,
    });
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);

    // A list refetch that does not include it yet cannot remove it.
    await React.act(() => render([named]));
    expect(placement()).toMatchObject({
      section: expect.stringContaining("No Project"),
      index: 0,
      sectionIndex: 0,
    });

    const listed = {
      ...thread,
      id: pendingId,
      projectId: hiddenProjectId,
      title: "Canonical pending title",
      lastActivityAt: DateTime.makeUnsafe(pending[0]?.startedAt ?? 0),
    } as ThreadData;
    await React.act(() => render([listed, named, earlier]));
    expect(placement()).toEqual({
      section: expect.stringContaining("No Project"),
      index: 0,
      sectionIndex: 0,
      pending: false,
    });
    expect(container.textContent).toContain("Canonical pending title");
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    await React.act(() => root.unmount());
  });

  it("makes a focused pending row the keyboard-command target", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const pending = optimisticThreadData(
      "thr_00000000-0000-4000-8000-000000000096" as ThreadId,
      projectId,
      "Pending title" as ThreadData["title"],
      Date.now(),
    );

    await React.act(() =>
      root.render(
        <SidebarThreadNavigation
          activeThreadId={pending.id}
          collapsedGroups={new Set()}
          hasMore={false}
          loadingMore={false}
          projectNames={new Map([[projectId, "Project"]])}
          query=""
          sections={[{ id: "project", threads: [pending, thread] }]}
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

    const canonicalRow = container.querySelector<HTMLElement>(
      `[data-command-sidebar-item]:not([aria-current="page"])`,
    );
    const pendingRow = container.querySelector<HTMLElement>(
      `[data-command-sidebar-item][aria-current="page"]`,
    );
    canonicalRow?.focus();
    expect(canonicalRow?.dataset.commandFocused).toBe("true");
    pendingRow?.focus();
    expect(pendingRow?.dataset.commandFocused).toBe("true");
    expect(canonicalRow?.dataset.commandFocused).toBeUndefined();
    await React.act(() => root.unmount());
  });
});

describe("pending creations in the sidebar", () => {
  const pendingId = "thr_00000000-0000-4000-8000-000000000098" as ThreadId;
  const creation = {
    id: pendingId,
    title: "Pending title" as ThreadData["title"],
    startedAt: Date.now(),
  };
  const projectNames = new Map([[projectId, "Project"]]);
  const sectionOf = (threads: ReadonlyArray<ThreadData>) =>
    buildThreadSections(
      [{ id: projectId, name: "Project" } as ProjectData],
      threads,
      Date.now(),
    ).find((section) => section.threads.some(({ id }) => id === pendingId));

  it("drops an admitted Thread the server no longer lists, such as an archived one", () => {
    const threads = withPendingThreads(
      [thread],
      [{ ...creation, submissionId: "submission-1" }],
      projectNames,
      true,
    );

    expect(threads.map(({ id }) => id)).toEqual([thread.id]);
  });

  it("keeps a pending No Project row out of a Project whose name is not loaded yet", () => {
    const unloadedProject = {
      ...thread,
      id: "thr_00000000-0000-4000-8000-000000000099" as ThreadId,
      projectId: "prj_second-page" as ProjectId,
      lastActivityAt: DateTime.makeUnsafe(Date.now() - 60_000),
    } as ThreadData;

    const incomplete = sectionOf(
      withPendingThreads([unloadedProject], [creation], projectNames, false),
    );
    const complete = sectionOf(
      withPendingThreads([unloadedProject], [creation], projectNames, true),
    );

    expect(incomplete?.label).toBe("No Project");
    expect(incomplete?.id).not.toBe("prj_second-page");
    expect(complete?.id).toBe("prj_second-page");
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
        ?.getAttribute("data-activity-status"),
    ).toBe("idle");

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
