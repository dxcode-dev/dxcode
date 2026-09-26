// @vitest-environment happy-dom
import type { UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarArchive } from "./sidebar-archive.js";
import { SidebarThreadNavigation } from "./sidebar-thread-navigation.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const openNewThread = vi.hoisted(() => vi.fn());
vi.mock("../../shared/new-thread-surface.js", () => ({
  useNewThreadSurface: () => ({ openNewThread }),
}));
const rowProps = {
  projectNames: new Map<string, string>(),
  onNavigate: vi.fn(),
  onThreadNavigate: vi.fn(),
  onThreadPointerEnter: vi.fn(),
  onThreadPointerLeave: vi.fn(),
  onSetArchived: vi.fn(),
  onSetPinned: vi.fn(),
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function Navigation({
  collapsed,
  toggle,
  pending = false,
}: {
  readonly collapsed: boolean;
  readonly toggle: () => void;
  readonly pending?: boolean;
}) {
  return (
    <SidebarThreadNavigation
      {...rowProps}
      collapsedGroups={new Set(collapsed ? ["archived"] : [])}
      onToggleGroup={toggle}
      onLoadMore={vi.fn()}
      hasMore={false}
      loadingMore={pending}
      query=""
      visibleThreadCount={0}
      sections={[{ id: "archived", label: "Archived", threads: [] }]}
      archiveContent={
        <SidebarArchive {...rowProps} userId={"user-1" as UserId} />
      }
    />
  );
}

describe("sidebar archive and empty state", () => {
  it("makes no archive request until expanded, supports retry and next page, and retains cached pages", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ status: "error", data: {} }, { status: 500 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: "success",
          data: { items: [], nextCursor: "bmV4dA" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ status: "success", data: { items: [] } }),
      );
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    function Harness() {
      const [collapsed, setCollapsed] = React.useState(true);
      return (
        <QueryClientProvider client={client}>
          <Navigation
            collapsed={collapsed}
            toggle={() => setCollapsed((value) => !value)}
          />
        </QueryClientProvider>
      );
    }
    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === label,
      );
      if (!button) throw new Error(`Missing ${label}`);
      await React.act(async () => {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    };
    try {
      await React.act(() => root.render(<Harness />));
      expect(fetch).not.toHaveBeenCalled();
      await click("Archived");
      await vi.waitFor(() =>
        expect(container.textContent).toContain(
          "Could not load archived threads",
        ),
      );
      expect(String(fetch.mock.calls[0]?.[0])).toContain(
        "lifecycleState=archived",
      );
      await click("Retry");
      await click("Load more archived threads");
      expect(String(fetch.mock.calls[2]?.[0])).toContain("cursor=bmV4dA");
      expect(String(fetch.mock.calls[2]?.[0])).toContain(
        "lifecycleState=archived",
      );
      await click("Archived");
      await click("Archived");
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      await React.act(() => root.unmount());
      client.clear();
      container.remove();
    }
  });

  it("keeps a collapsed project count in its heading", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await React.act(() =>
        root.render(
          <SidebarThreadNavigation
            {...rowProps}
            collapsedGroups={new Set(["project"])}
            onToggleGroup={vi.fn()}
            onLoadMore={vi.fn()}
            hasMore={false}
            loadingMore={false}
            query=""
            visibleThreadCount={2}
            sections={[
              {
                id: "project",
                label: "Project",
                project: true,
                threads: [{}, {}] as never[],
              },
            ]}
          />,
        ),
      );
      const heading = container.querySelector(".thread-group-heading");
      expect(heading?.getAttribute("data-collapsed")).toBe("true");
      expect(heading?.getAttribute("aria-expanded")).toBe("false");
      expect(heading?.querySelector("small")?.textContent).toBe("2");
      expect(heading?.querySelector(".thread-group-meta svg")).toBeNull();
    } finally {
      await React.act(() => root.unmount());
    }
  });

  it("shows an actionable empty prompt and arrow only after loading completes", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await React.act(() =>
        root.render(<Navigation collapsed toggle={vi.fn()} pending />),
      );
      expect(container.querySelector(".sidebar-first-thread")).toBeNull();
      await React.act(() =>
        root.render(<Navigation collapsed toggle={vi.fn()} />),
      );
      expect(
        container.querySelector(".sidebar-first-thread svg path"),
      ).not.toBeNull();
      const button = container.querySelector<HTMLButtonElement>(
        ".sidebar-first-thread button",
      );
      expect(button?.textContent).toBe("Create new thread");
      await React.act(() => button?.click());
      expect(openNewThread).toHaveBeenCalledOnce();
      expect(rowProps.onNavigate).toHaveBeenCalledOnce();
    } finally {
      await React.act(() => root.unmount());
    }
  });
});
