import type {
  ThreadChangesCaptureId,
  ThreadChangesCommitSha,
  ThreadChangesData,
  ThreadChangesPath,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import "../../../styles.css";
import { paneLayoutWith } from "../../../testing/pane-layouts.js";
import {
  type PaneLayoutAction,
  reducePaneLayout,
} from "../panes/pane-layout.js";
import type { PaneContents } from "../panes/pane-views.js";
import { ThreadStackedLayout } from "../panes/thread-stacked-layout.js";
import "../panes/panes.css";
import type { ChangesTransport } from "./changes-api.js";
import { ChangesPane } from "./changes-pane.js";
import { preloadChangesPane } from "./changes-pane-loader.js";
import "./changes.css";

// The pane's code loads on demand; this test starts with it loaded.
await preloadChangesPane();

// #1152: on a phone, the Changes view put its commit range chevron at the end
// of the view row, where it covered the next tabs: tapping Terminal's close
// button opened the range menu. The chevron belongs to the Changes tab itself.

const threadId = "thr_00000000-0000-4000-8000-000000001152" as ThreadId;
const head = "b".repeat(40) as ThreadChangesCommitSha;
const changes: ThreadChangesData = {
  kind: "changes",
  captureId:
    "chg_00000000-0000-4000-8000-000000001152" as ThreadChangesCaptureId,
  freshness: "complete",
  capturedAt: "2026-10-31T12:00:00.000Z",
  range: { kind: "all" },
  truncated: false,
  baseline: "a".repeat(40) as ThreadChangesCommitSha,
  head,
  branch: "phone-fit",
  upstreamLabel: "origin/main",
  ahead: 1,
  summary: { additions: 4, deletions: 1, files: 1 },
  files: [
    {
      path: "src/example.ts" as ThreadChangesPath,
      status: "modified",
      additions: 4,
      deletions: 1,
      binary: false,
      truncated: false,
    },
  ],
  commits: [{ sha: head, shortSha: head.slice(0, 7), subject: "Fit phones" }],
};

const PHONES = [
  { width: 390, height: 844 },
  { width: 360, height: 740 },
] as const;

const box = (element: Element) => element.getBoundingClientRect();
const center = (element: Element) => {
  const rect = box(element);
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

function StackedHarness({
  transport,
}: {
  readonly transport: ChangesTransport;
}) {
  const [layout, setLayout] = React.useState(() =>
    paneLayoutWith(["changes", "files", "terminal", "desktop"]),
  );
  const dispatch = (action: PaneLayoutAction) =>
    setLayout((current) => reducePaneLayout(current, action));
  const contents: PaneContents = {
    agent: <div>Agent</div>,
    views: {
      changes: (
        <ChangesPane
          threadId={threadId}
          transport={transport}
          onReviewPrompt={() => undefined}
        />
      ),
      files: <div>Files</div>,
      terminal: <div>Terminal</div>,
      desktop: <div>Desktop</div>,
    },
    file: () => null,
    dirtyTabs: new Set(),
  };
  return (
    <div
      className="thread-page"
      data-stacked=""
      style={{ display: "flex", flexDirection: "column", height: "100vh" }}
    >
      <ThreadStackedLayout
        layout={layout}
        contents={contents}
        dispatch={dispatch}
      />
    </div>
  );
}

afterEach(async () => {
  document.body.replaceChildren();
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await page.viewport(1280, 800);
});

describe.each(PHONES)(
  "the phone Changes range at $width x $height",
  ({ width, height }) => {
    it("sits in the Changes tab, leaving every other tab and close button tappable (#1152)", async () => {
      await page.viewport(width, height);
      await cdp().send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 5,
      });
      document.body.style.margin = "0";
      const transport: ChangesTransport = {
        getChanges: vi.fn().mockResolvedValue(changes),
        getDiff: vi.fn(),
        push: vi.fn(),
      };
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const container = document.body.appendChild(
        document.createElement("div"),
      );
      const root = createRoot(container);
      await React.act(() =>
        root.render(
          <QueryClientProvider client={client}>
            <StackedHarness transport={transport} />
          </QueryClientProvider>,
        ),
      );
      await vi.waitFor(() =>
        expect(
          container.querySelector('[aria-label="Commit Range Options"]'),
        ).not.toBeNull(),
      );
      const row = container.querySelector(".stacked-view-row") as HTMLElement;
      const tabs = container.querySelector(".stacked-tabs") as HTMLElement;
      const chevron = container.querySelector(
        '[aria-label="Commit Range Options"]',
      ) as HTMLButtonElement;
      const changesTab = container.querySelector(
        '.stacked-tab[data-kind="changes"]',
      ) as HTMLElement;

      // The chevron is part of the Changes tab, between its label and close.
      expect(changesTab.contains(chevron)).toBe(true);
      const order = [...changesTab.querySelectorAll("button")].map((button) =>
        button.getAttribute("aria-label"),
      );
      expect(order).toEqual([
        "Changes",
        "Commit Range Options",
        "Close Changes",
      ]);
      // Nothing else takes the row from the tabs: any tab control whose center
      // is on screen is the element there, as the row first shows.
      expect(box(tabs).right).toBeGreaterThanOrEqual(box(row).right - 1);
      for (const button of tabs.querySelectorAll("button")) {
        const { x, y } = center(button);
        if (x < 0 || x > innerWidth) continue;
        expect(
          button.contains(document.elementFromPoint(x, y)),
          `${button.getAttribute("aria-label")} at x=${Math.round(x)}`,
        ).toBe(true);
      }

      // Every other tab and its close button is the element at its own center
      // once the row scrolls to it.
      for (const label of ["Files", "Terminal", "Desktop"]) {
        for (const name of [label, `Close ${label}`]) {
          const button = container.querySelector(
            `.stacked-tabs button[aria-label="${name}"]`,
          ) as HTMLElement;
          button.scrollIntoView({ inline: "nearest", block: "nearest" });
          const { x, y } = center(button);
          expect(button.contains(document.elementFromPoint(x, y)), name).toBe(
            true,
          );
        }
      }

      // The chevron is a 44px touch target and opens the range menu.
      changesTab.scrollIntoView({ inline: "nearest", block: "nearest" });
      const { x, y } = center(chevron);
      for (const [dx, dy] of [
        [0, -21],
        [0, 21],
        [-21, 0],
        [21, 0],
      ] as const)
        expect(
          chevron.contains(document.elementFromPoint(x + dx, y + dy)),
          `${dx},${dy} from the chevron's center`,
        ).toBe(true);
      await React.act(() => chevron.click());
      expect(container.querySelector(".changes-range-menu")).not.toBeNull();

      // Another view has no range chevron.
      await React.act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '.stacked-tabs button[aria-label="Files"]',
          )
          ?.click(),
      );
      await vi.waitFor(() =>
        expect(
          container.querySelector('[aria-label="Commit Range Options"]'),
        ).toBeNull(),
      );
      await React.act(() => root.unmount());
      client.clear();
    });
  },
);
