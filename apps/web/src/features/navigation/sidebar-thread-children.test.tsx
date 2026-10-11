// @vitest-environment happy-dom

import type { ThreadData } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

import { AuthContext } from "../../shared/auth/auth-context.js";
import { SidebarThreadChildrenProvider } from "./sidebar-thread-children.js";
import { SidebarThreadRows } from "./sidebar-thread-rows.js";

const parentId = "thr_00000000-0000-4000-8000-000000000101" as ThreadId;
const childId = "thr_00000000-0000-4000-8000-000000000102" as ThreadId;
const parent = {
  id: parentId,
  projectId: "prj_00000000-0000-4000-8000-000000000001",
  title: "Plugin platform direction",
  lifecycleState: "active",
  activityStatus: "idle",
  childCount: 2,
} as unknown as ThreadData & { readonly childCount: number };

const listedChild = (id: string, title: string) => ({
  id,
  title,
  projectId: "prj_00000000-0000-4000-8000-000000000001",
  visibility: "private",
  createdAt: "2026-10-10T10:00:00.000Z",
  updatedAt: "2026-10-10T10:00:00.000Z",
  lastActivityAt: "2026-10-10T10:00:00.000Z",
  activityStatus: "working",
  lifecycleState: "active",
  agentUrl: `/v1/agents/dx/${id}`,
  parentThreadId: parentId,
  mode: "medium",
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("sidebar child threads", () => {
  it("shows a parent's child count and lists its children under it only when expanded", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        status: "success",
        data: {
          items: [
            listedChild(childId, "0.3.0 hygiene: webhook 409 UX"),
            listedChild(
              "thr_00000000-0000-4000-8000-000000000103",
              "0.3.0 blocker: plugin integrity",
            ),
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await React.act(() =>
        root.render(
          <AuthContext.Provider
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
              <SidebarThreadChildrenProvider>
                <SidebarThreadRows
                  threads={[parent]}
                  activeThreadId={childId}
                  projectNames={new Map()}
                  onThreadNavigate={vi.fn()}
                  onThreadPointerEnter={vi.fn()}
                  onThreadPointerLeave={vi.fn()}
                  onSetArchived={vi.fn()}
                  onSetPinned={vi.fn()}
                />
              </SidebarThreadChildrenProvider>
            </QueryClientProvider>
          </AuthContext.Provider>,
        ),
      );
      const toggle = container.querySelector<HTMLButtonElement>(
        ".thread-children-toggle",
      );
      expect(toggle?.textContent).toBe("2");
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      expect(toggle?.title).toBe("2 threads");
      expect(container.querySelector(".thread-children")).toBeNull();
      expect(fetch).not.toHaveBeenCalled();

      await React.act(async () => {
        toggle?.click();
      });
      await vi.waitFor(() =>
        expect(container.querySelectorAll("[data-child]")).toHaveLength(2),
      );
      expect(String(fetch.mock.calls[0]?.[0])).toContain(
        `lifecycleState=active&parentThreadId=${parentId}`,
      );
      expect(toggle?.getAttribute("aria-expanded")).toBe("true");
      const children = [...container.querySelectorAll("[data-child]")];
      expect(children[0]?.textContent).toContain(
        "0.3.0 hygiene: webhook 409 UX",
      );
      expect(
        children[0]?.querySelector(
          ".thread-child-marker + .thread-executor-icon .thread-child-badge",
        ),
      ).not.toBeNull();
      expect(
        children[0]?.querySelector(".thread-row")?.getAttribute("aria-current"),
      ).toBe("page");
      // Children never carry their own child-count control.
      expect(
        container.querySelectorAll(".thread-children-toggle"),
      ).toHaveLength(1);

      await React.act(async () => {
        toggle?.click();
      });
      expect(container.querySelector(".thread-children")).toBeNull();
    } finally {
      await React.act(() => root.unmount());
      client.clear();
    }
  });

  it("shows no child control outside the sidebar's expansion owner", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await React.act(() =>
        root.render(
          <SidebarThreadRows
            threads={[parent]}
            projectNames={new Map()}
            onThreadNavigate={vi.fn()}
            onThreadPointerEnter={vi.fn()}
            onThreadPointerLeave={vi.fn()}
            onSetArchived={vi.fn()}
            onSetPinned={vi.fn()}
          />,
        ),
      );
      expect(container.querySelector(".thread-children-toggle")).toBeNull();
    } finally {
      await React.act(() => root.unmount());
    }
  });
});
