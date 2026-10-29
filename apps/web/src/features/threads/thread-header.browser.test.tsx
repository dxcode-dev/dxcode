import type { ThreadDetailData } from "@dx/api";
import { defaultThreadModelSelection } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const archive = vi.hoisted(() => ({
  pendingThreadId: undefined,
  setArchived: vi.fn(),
}));
const layoutMode = vi.hoisted(() => ({ compact: false }));

vi.mock("../../shared/thread-archive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/thread-archive.js")>()),
  useOptionalThreadArchive: () => archive,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  // The compact menu's Project entry is a Link; no router renders here.
  Link: ({
    children,
    ...props
  }: React.ComponentProps<"a"> & { readonly to?: string }) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock("./panes/thread-layout-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./panes/thread-layout-mode.js")>()),
  useThreadLayoutMode: () => ({
    stacked: layoutMode.compact,
    compact: layoutMode.compact,
    coarse: false,
  }),
}));
vi.mock("../../shared/auth/auth-context.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../shared/auth/auth-context.js")
  >()),
  useAuthenticatedIdentity: () => ({
    identity: { id: "usr_00000000000000000000000000000001" },
  }),
}));

import { automationKeys } from "./automations/automations-queries.js";
import { defaultPaneLayout } from "./panes/pane-layout.js";
import { ViewsMenuButton } from "./panes/pane-menus.js";
import { ThreadHeader as BareThreadHeader } from "./thread-header.js";
// The title bar's layout rules live in the app stylesheet.
import "../../styles.css";

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

// The app's query client; this Thread has no schedule or GitHub listeners.
const queryClient = new QueryClient();
queryClient.setQueryData(automationKeys.thread(thread.id), {
  githubSubscriptions: [],
  pullRequests: [],
  ciRuns: [],
});

function ThreadHeader(props: React.ComponentProps<typeof BareThreadHeader>) {
  return (
    <QueryClientProvider client={queryClient}>
      <BareThreadHeader {...props} />
    </QueryClientProvider>
  );
}

const model = {
  rows: [],
  turns: [],
  outline: [],
  capabilities: {
    paging: { available: false as const },
    subagents: { available: false as const },
  },
  rowsByTurn: new Map(),
};

const roots: Root[] = [];

afterEach(async () => {
  // A menu still closing keeps its portal; unmount before clearing the page.
  for (const root of roots.splice(0)) await React.act(() => root.unmount());
  archive.setArchived.mockReset();
  layoutMode.compact = false;
  document.body.replaceChildren();
});

describe("ThreadHeader", () => {
  const render = async (element: React.ReactNode) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await React.act(() => root.render(element));
    return container;
  };

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

  it("archives from the open-Thread menu", async () => {
    const container = await render(
      <ThreadHeader thread={thread} transcript={() => model} />,
    );
    await React.act(() =>
      container
        .querySelector('[aria-label="More Actions"]')
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
      <ThreadHeader thread={archived} transcript={() => model} />,
    );

    expect(container.querySelector(".thread-archived-badge")?.textContent).toBe(
      "Archived thread",
    );
    expect(container.textContent).not.toContain("Undo");
    await React.act(() =>
      container
        .querySelector('[aria-label="More Actions"]')
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

  describe("compact overflow", () => {
    // Failure list: the bar overflows its box; a control hides although it
    // fits; a hidden control is missing from More Actions, or a shown one is
    // listed there too; a control stays hidden after the bar grows; the
    // menu entry does not open its sheet.
    const busy = {
      ...thread,
      id: "thr_00000000-0000-4000-8000-000000000097",
      visibility: "workspace",
      sharing: { workspaceAccess: "view" },
      participants: [
        {
          userId: "usr_00000000000000000000000000000001",
          name: "You",
          owner: true,
        },
        { userId: "usr_00000000000000000000000000000002", name: "Ada" },
        { userId: "usr_00000000000000000000000000000003", name: "Grace" },
      ],
    } as unknown as ThreadDetailData;
    queryClient.setQueryData(automationKeys.thread(busy.id), {
      githubSubscriptions: [
        {
          id: "ghs_00000000000000000000000000000001",
          title: "PR #1 comments",
          repository: "acme/app",
          filterKind: "pr-comments",
          target: "comments on #1",
          url: "https://github.com/acme/app/pull/1",
          destination: "this-thread",
          automatic: true,
          enabled: true,
          state: "active",
          createdAt: "2026-10-29T00:00:00.000Z",
        },
      ],
      pullRequests: [
        {
          repository: "acme/app",
          number: 1,
          url: "https://github.com/acme/app/pull/1",
          state: "open",
          title: "Add the thing",
        },
      ],
      ciRuns: [
        {
          repository: "acme/app",
          sha: "0123456789abcdef0123456789abcdef01234567",
          result: "passed",
          url: "https://github.com/acme/app/actions/runs/1",
          checks: [],
          at: "2026-10-29T00:00:00.000Z",
        },
      ],
    });
    const mountAt = async (width: number, subject = busy) => {
      layoutMode.compact = true;
      const container = document.createElement("div");
      container.style.cssText = `width: ${width}px;`;
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      await React.act(() =>
        root.render(<ThreadHeader thread={subject} transcript={() => model} />),
      );
      // ResizeObserver delivers after layout; wait for the bar to settle.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return container;
    };
    const visibleItems = (container: HTMLElement) =>
      [...container.querySelectorAll<HTMLElement>("[data-title-bar-item]")]
        .filter((slot) => getComputedStyle(slot).display !== "none")
        .map((slot) => slot.dataset.titleBarItem);
    const bar = (container: HTMLElement) => {
      const node = container.querySelector<HTMLElement>(".thread-title-bar");
      if (node === null) throw new Error("No title bar.");
      return node;
    };
    const openMenu = async (container: HTMLElement) => {
      const trigger = container.querySelector<HTMLButtonElement>(
        '[aria-label="More Actions"]',
      );
      if (trigger === null) throw new Error("No More Actions.");
      await React.act(() => trigger.click());
      await vi.waitFor(() =>
        expect(document.querySelector(".thread-actions-menu")).not.toBeNull(),
      );
      return [
        ...document.querySelectorAll<HTMLElement>(
          '.thread-actions-menu [role="menuitem"]',
        ),
      ];
    };

    it("moves the controls that do not fit a narrow bar into More Actions and opens them from there", async () => {
      const container = await mountAt(260);
      const header = bar(container);
      expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
      // The title kept its minimum and elided; the controls gave way from
      // the end: the badge, then the people.
      const title = header.querySelector<HTMLElement>(".thread-title");
      expect(title?.getBoundingClientRect().width).toBeGreaterThanOrEqual(72);
      expect(visibleItems(container)).toEqual(["pulls", "ci", "listeners"]);
      const items = await openMenu(container);
      const labels = items.map((item) => item.textContent?.trim());
      expect(labels).toContain("3 people in this thread");
      expect(labels).toContain("Share…");
      expect(labels).not.toContain("Pull requests");
      expect(labels).not.toContain("CI");
    });

    it("lists the automations in More Actions once the bar is too narrow for them, and opens the sheet", async () => {
      const container = await mountAt(150);
      const header = bar(container);
      expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
      expect(visibleItems(container)).toEqual([]);
      const items = await openMenu(container);
      const labels = items.map((item) => item.textContent?.trim());
      expect(labels).toEqual(
        expect.arrayContaining([
          "Pull requests",
          "CI",
          "Schedule and GitHub events",
          "3 people in this thread",
          "Share…",
        ]),
      );
      const pulls = items.find(
        (item) => item.textContent?.trim() === "Pull requests",
      );
      if (pulls === undefined) throw new Error("No Pull requests entry.");
      await React.act(() => pulls.click());
      await vi.waitFor(() =>
        expect(
          document.querySelector(".automation-sheet")?.textContent,
        ).toContain("Add the thing"),
      );
    });

    it("keeps every control inline when the bar has room, and brings them back when it grows", async () => {
      const container = await mountAt(260);
      expect(visibleItems(container)).toEqual(["pulls", "ci", "listeners"]);
      container.style.width = "700px";
      await vi.waitFor(() =>
        expect(visibleItems(container)).toEqual([
          "pulls",
          "ci",
          "listeners",
          "participants",
          "privacy",
        ]),
      );
      const header = bar(container);
      expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
      const items = await openMenu(container);
      const labels = items.map((item) => item.textContent?.trim());
      expect(labels).not.toContain("Pull requests");
      expect(labels).not.toContain("3 people in this thread");
    });
  });

  describe("menu shortcuts", () => {
    // Failure: the shortcut's bordered box stretches across the item's
    // free space, so its keys float at the right end of a wide empty box.
    const keycapBoxes = () =>
      [...document.querySelectorAll<HTMLElement>(".shortcut-keycaps")].map(
        (box) => {
          const keys = [...box.querySelectorAll("kbd")];
          const content = keys.reduce(
            (width, key) => width + key.getBoundingClientRect().width,
            0,
          );
          const item = box.closest<HTMLElement>('[role="menuitem"]');
          if (item === null) throw new Error("A shortcut outside a menu item.");
          return {
            text: keys.map((key) => key.textContent).join(""),
            slack: box.getBoundingClientRect().width - content,
            gapToItemEnd:
              item.getBoundingClientRect().right -
              box.getBoundingClientRect().right,
          };
        },
      );

    it("hug their keys at the end of More Actions items", async () => {
      const container = await render(
        <ThreadHeader thread={thread} transcript={() => model} />,
      );
      const trigger = container.querySelector<HTMLButtonElement>(
        '[aria-label="More Actions"]',
      );
      await React.act(() => trigger?.click());
      await vi.waitFor(() =>
        expect(document.querySelector(".shortcut-keycaps")).not.toBeNull(),
      );
      const boxes = keycapBoxes();
      expect(boxes.map(({ text }) => text)).toEqual([
        expect.stringMatching(/C$/),
      ]);
      for (const box of boxes) {
        // 4px padding each side, 1px border each side, 2px between keys.
        expect(box.slack).toBeLessThanOrEqual(16);
        // Right-aligned inside the item's 8px padding.
        expect(box.gapToItemEnd).toBeLessThanOrEqual(10);
      }
    });

    it("hug their keys at the end of Views items", async () => {
      const container = await render(
        <ViewsMenuButton
          layout={defaultPaneLayout()}
          contents={{
            agent: null,
            views: { files: <div />, changes: <div />, terminal: <div /> },
            file: () => null,
            dirtyTabs: new Set(),
          }}
          onOpen={() => undefined}
        />,
      );
      const trigger = container.querySelector<HTMLButtonElement>(
        '[aria-label="Views"]',
      );
      await React.act(() => trigger?.click());
      await vi.waitFor(() =>
        expect(
          document.querySelectorAll(".shortcut-keycaps").length,
        ).toBeGreaterThanOrEqual(3),
      );
      for (const box of keycapBoxes()) {
        expect(box.slack).toBeLessThanOrEqual(16);
        expect(box.gapToItemEnd).toBeLessThanOrEqual(10);
      }
    });
  });
});
