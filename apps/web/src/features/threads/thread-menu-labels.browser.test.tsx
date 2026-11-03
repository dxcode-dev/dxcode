import type { ThreadDetailData } from "@dx/api";
import { defaultThreadModelSelection, type UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DateTime } from "effect";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  // The menu's Thread and Project entries are Links; no router renders here.
  Link: ({
    children,
    ...props
  }: React.ComponentProps<"a"> & { readonly to?: string }) => (
    <a {...props}>{children}</a>
  ),
}));

import { AuthContext } from "../../shared/auth/auth-context.js";
import { ThreadArchiveContext } from "../../shared/thread-archive.js";
import { ThreadEditingContext } from "../../shared/thread-editing.js";
import { ThreadSnoozeContext } from "../../shared/thread-snooze.js";
import { orbMemoryKeys } from "./orb-memory/orb-memory-queries.js";
import { threadCostQueryOptions } from "./thread-cost-queries.js";
import { ThreadMenu } from "./thread-menu.js";
// The menu's widths live in the app stylesheet.
import "../../styles.css";

// A Thread the requester owns, so the menu lists Share, Pin, Snooze, Archive,
// Rename, Color, Delete, its Orb, and its cost; its child also lists Open
// Source Thread.
const thread = {
  createdAt: DateTime.makeUnsafe("2026-10-31T00:00:00.000Z"),
  id: "thr_00000000-0000-4000-8000-000000001148",
  projectId: "prj_00000000000000000000000000001148",
  title: "More Actions labels",
  visibility: "private",
  lifecycleState: "active",
  activityStatus: "idle",
  agentInitialization: { selection: defaultThreadModelSelection() },
  executionWorkspace: { ready: true, preparationStatus: null },
} as ThreadDetailData;
const child = {
  ...thread,
  id: "thr_00000000-0000-4000-8000-000000001149",
  parentThreadId: thread.id,
} as ThreadDetailData;

// Claude Code runs on the person's own plan, so its cost is not tracked.
const claudeCode = {
  ...thread,
  id: "thr_00000000-0000-4000-8000-000000001155",
  agentInitialization: {
    selection: { kind: "model", model: "claude-code/claude-opus-5-5" },
  },
} as ThreadDetailData;

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

const editing = {
  openRename: () => undefined,
  openDelete: () => undefined,
  setColor: () => undefined,
  childCount: () => 0,
  pinned: () => false,
  setPinned: () => undefined,
};
const snooze = {
  snooze: () => undefined,
  snoozeCustom: () => undefined,
  wake: () => undefined,
};
const archive = { setArchived: () => undefined };

const auth = {
  identity: {
    id: "usr_00000000000000000000000000001155" as UserId,
    name: "Owner",
    email: "owner@example.com",
  },
  logout: () => undefined,
};

// The Orb is paused and the cost is known.
const queryClient = new QueryClient();
for (const shown of [thread, child, claudeCode]) {
  queryClient.setQueryData(orbMemoryKeys.thread(shown.id), {
    workspace: "paused",
    processes: [],
  });
  queryClient.setQueryData(
    threadCostQueryOptions(
      auth.identity.id,
      shown.id,
      DateTime.toEpochMillis(shown.createdAt),
    ).queryKey,
    {
      amountMicros: 6_390_000,
      currency: "USD",
      estimated: true,
      knownEvents: 12,
      unknownEvents: 0,
      since: undefined,
    },
  );
}
queryClient.setDefaultOptions({
  queries: { staleTime: Number.POSITIVE_INFINITY },
});

const roots: Root[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await React.act(() => root.unmount());
  document.body.replaceChildren();
  await page.viewport(1280, 800);
});

/** Every label in the open menus that the browser cut with an ellipsis. */
const cutLabels = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>(
      ".thread-menu-popup .thread-menu-item > span:not([role='img']):not(.shortcut-keycaps)",
    ),
  )
    .filter((label) => label.scrollWidth > label.clientWidth)
    .map(
      (label) =>
        `${label.textContent} (${label.clientWidth}px of ${label.scrollWidth}px)`,
    );

const menuLabels = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>(
      ".thread-actions-menu:not(.thread-actions-submenu) > .thread-menu-item",
    ),
    (item) => item.textContent?.trim(),
  );

describe("More Actions", () => {
  for (const [width, height, showDetails, shown] of [
    [1440, 900, false, thread],
    [1440, 900, false, child],
    [390, 844, true, thread],
    [1440, 900, false, claudeCode],
    [390, 844, true, claudeCode],
  ] as const) {
    const kind =
      shown === child
        ? "a child Thread"
        : shown === claudeCode
          ? "a Claude Code Thread"
          : "a Thread";
    it(`shows every label in full for ${kind} at ${width}x${height}`, async () => {
      await page.viewport(width, height);
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      await React.act(() =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <AuthContext value={auth}>
              <ThreadArchiveContext value={archive}>
                <ThreadEditingContext value={editing}>
                  <ThreadSnoozeContext value={snooze}>
                    <ThreadMenu
                      thread={shown}
                      project={{ name: "dx" }}
                      transcript={() => model}
                      onOpenShare={() => undefined}
                      showDetails={showDetails}
                    />
                  </ThreadSnoozeContext>
                </ThreadEditingContext>
              </ThreadArchiveContext>
            </AuthContext>
          </QueryClientProvider>,
        ),
      );
      await React.act(() =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="More Actions"]')
          ?.click(),
      );
      await vi.waitFor(() =>
        expect(document.querySelector(".shortcut-keycaps")).not.toBeNull(),
      );
      expect(menuLabels()).toEqual(
        expect.arrayContaining([
          ...(shown === child
            ? [expect.stringMatching(/Open Source Thread$/)]
            : ["Snooze"]),
          "Open Thread Tree",
          expect.stringMatching(/^Copy Thread URL.*C$/),
          "Copy Thread ID",
          "Export",
          "OrbPaused",
          "$6.39",
          ...(shown === claudeCode ? ["Claude Code Costs Not Tracked"] : []),
          "Share…",
          "Pin",
          "Archive",
          "Rename",
          "Color",
          "Delete",
          "Report Bug",
        ]),
      );
      expect(cutLabels()).toEqual([]);

      // The submenus' items too.
      for (const name of shown === child ? ["Export"] : ["Export", "Snooze"]) {
        const trigger = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".thread-actions-menu .thread-menu-item",
          ),
        ).find((item) => item.textContent?.trim() === name);
        await React.act(() => trigger?.click());
        await vi.waitFor(() =>
          expect(
            document.querySelector(".thread-actions-submenu .thread-menu-item"),
          ).not.toBeNull(),
        );
        expect(cutLabels()).toEqual([]);
      }

      // The whole menu stays on screen.
      const popup = document.querySelector<HTMLElement>(
        ".thread-actions-menu:not(.thread-actions-submenu)",
      );
      expect(popup?.getBoundingClientRect().width).toBeLessThanOrEqual(
        width - 8,
      );
    });
  }
});
