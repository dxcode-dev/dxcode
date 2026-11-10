import type { UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../shared/auth/auth-context.js";
import { SidebarArchive } from "./sidebar-archive.js";
import { SidebarThreadNavigation } from "./sidebar-thread-navigation.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const openNewThread = vi.hoisted(() => vi.fn());
vi.mock("../../shared/new-thread-surface.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../shared/new-thread-surface.js")
  >()),
  useNewThreadSurface: () => ({ openNewThread }),
}));
// Archived rows link to their Thread; a plain anchor stands in for the router.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    params,
    to,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    readonly params: { readonly threadId: string };
    readonly to: string;
  }) => (
    <a href={to.replace("$threadId", params.threadId)} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("./thread-context-menu.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thread-context-menu.js")>()),
  ThreadContextMenu: ({ children }: { readonly children: React.ReactNode }) =>
    children,
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
      expandedThreads={new Set()}
      onToggleThread={vi.fn()}
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

  // Fails if an archived Space is missing from Archived, shows an Orb as if
  // it ran one, or if an ordinary archived Thread loses its Orb.
  it("lists an archived Space with its Space mark beside archived Threads", async () => {
    const archived = (id: string, title: string, kind?: "space") => ({
      id,
      title,
      projectId: "prj_00000000-0000-4000-8000-000000000001",
      visibility: "private",
      createdAt: "2026-10-10T10:00:00.000Z",
      updatedAt: "2026-10-10T10:00:00.000Z",
      lastActivityAt: "2026-10-10T10:00:00.000Z",
      activityStatus: "idle",
      lifecycleState: "archived",
      agentUrl: `/v1/agents/dx/${id}`,
      mode: "medium",
      ...(kind === undefined ? {} : { kind, color: "red" }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json({
          status: "success",
          data: {
            items: [
              archived(
                "thr_00000000-0000-4000-8000-000000000201",
                "Checkout v2",
                "space",
              ),
              archived(
                "thr_00000000-0000-4000-8000-000000000202",
                "Fix coupon rounding",
              ),
            ],
          },
        }),
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const row = (title: string) =>
      [...container.querySelectorAll<HTMLElement>(".thread-row")].find(
        (element) => element.textContent?.includes(title),
      );
    try {
      await React.act(() =>
        root.render(
          <AuthContext
            value={{
              identity: {
                id: "user-1" as UserId,
                name: "Owner",
                email: "owner@example.com",
              },
              logout: vi.fn(),
            }}
          >
            <QueryClientProvider client={client}>
              <Navigation collapsed={false} toggle={vi.fn()} />
            </QueryClientProvider>
          </AuthContext>,
        ),
      );
      await vi.waitFor(() => expect(row("Checkout v2")).toBeDefined());
      const space = row("Checkout v2");
      const thread = row("Fix coupon rounding");
      expect(
        space?.querySelector("[role='img'][aria-label='Space']"),
      ).not.toBeNull();
      expect(space?.querySelector("[data-activity-status]")).toBeNull();
      expect(thread?.querySelector("[aria-label='Space']")).toBeNull();
      expect(thread?.querySelector("[data-activity-status]")).not.toBeNull();
    } finally {
      await React.act(() => root.unmount());
      client.clear();
      container.remove();
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
