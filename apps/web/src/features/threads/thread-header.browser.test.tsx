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

vi.mock("../../shared/thread-archive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/thread-archive.js")>()),
  useOptionalThreadArchive: () => archive,
}));

import { automationKeys } from "./automations/automations-queries.js";
import { ThreadHeader as BareThreadHeader } from "./thread-header.js";

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
        .querySelector('[aria-label="Thread actions"]')
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
        .querySelector('[aria-label="Thread actions"]')
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
});
