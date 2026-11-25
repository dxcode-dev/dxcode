import type { ThreadData } from "@dx/api";
import type { ProjectId } from "@dx/domain";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../../styles.css";
import { SidebarThreadNavigation } from "./sidebar-thread-navigation.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const openNewThread = vi.hoisted(() => vi.fn());
vi.mock("../../shared/new-thread-surface.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../shared/new-thread-surface.js")
  >()),
  useNewThreadSurface: () => ({ openNewThread }),
}));
afterEach(() => vi.clearAllMocks());

const projectId = "prj_website" as ProjectId;

function Navigation({
  collapsed,
  onToggleGroup,
  onNavigate,
}: {
  readonly collapsed: boolean;
  readonly onToggleGroup: (id: string) => void;
  readonly onNavigate: () => void;
}) {
  return (
    <SidebarThreadNavigation
      projectNames={new Map([[projectId, "Website"]])}
      onNavigate={onNavigate}
      onThreadNavigate={vi.fn()}
      onThreadPointerEnter={vi.fn()}
      onThreadPointerLeave={vi.fn()}
      onSetArchived={vi.fn()}
      onSetPinned={vi.fn()}
      collapsedGroups={new Set(collapsed ? [projectId] : [])}
      expandedThreads={new Set()}
      onToggleThread={vi.fn()}
      onToggleGroup={onToggleGroup}
      onLoadMore={vi.fn()}
      hasMore={false}
      loadingMore={false}
      query=""
      visibleThreadCount={1}
      sections={[
        {
          id: projectId,
          label: "Website",
          project: true,
          projectId,
          threads: [] as ReadonlyArray<ThreadData>,
        },
        { id: "no-project", label: "No Project", project: true, threads: [] },
      ]}
    />
  );
}

it("starts a Thread in a Project from its heading's New thread, which shows on hover", async () => {
  const container = document.createElement("div");
  // Clear of the top-left corner where other files' fixtures sit.
  container.style.cssText = "width: 280px; margin: 320px 0 0 480px";
  document.body.append(container);
  const root = createRoot(container);
  const onToggleGroup = vi.fn();
  const onNavigate = vi.fn();
  const heading = () =>
    container.querySelector<HTMLElement>(
      '[data-thread-section="prj_website"] .thread-group-project-heading',
    ) as HTMLElement;
  const newThread = () =>
    container.querySelector<HTMLButtonElement>(
      "[aria-label='New thread in Website']",
    ) as HTMLButtonElement;
  try {
    await React.act(() =>
      root.render(
        <Navigation
          collapsed={false}
          onToggleGroup={onToggleGroup}
          onNavigate={onNavigate}
        />,
      ),
    );
    // No Project has no Project to start in, so it offers no New thread.
    expect(
      container.querySelectorAll("[aria-label^='New thread in']"),
    ).toHaveLength(1);
    // Hidden at rest; hovering the heading shows it before the chevron.
    // Test files run side by side and share one pointer, so park it first.
    await userEvent.unhover(heading());
    await vi.waitFor(() => expect(newThread().checkVisibility()).toBe(false));
    await userEvent.hover(heading());
    await vi.waitFor(() => expect(newThread().checkVisibility()).toBe(true));
    const chevron = heading().querySelector(
      ".thread-group-meta svg.lucide-chevron-down",
    ) as Element;
    expect(newThread().getBoundingClientRect().right).toBeLessThanOrEqual(
      chevron.getBoundingClientRect().left,
    );

    await userEvent.click(newThread());
    expect(openNewThread).toHaveBeenCalledExactlyOnceWith(projectId);
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onToggleGroup).not.toHaveBeenCalled();

    // The rest of the heading, chevron included, still toggles the section.
    // The chevron sits at the row's end whether New thread shows or not.
    const row = heading().getBoundingClientRect();
    const end = chevron.getBoundingClientRect();
    await userEvent.click(heading(), {
      position: { x: end.left - row.left + end.width / 2, y: row.height / 2 },
    });
    expect(onToggleGroup).toHaveBeenCalledExactlyOnceWith(projectId);
    const toggle = heading().querySelector("button.thread-group-heading");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  } finally {
    await React.act(() => root.unmount());
    container.remove();
  }
});
