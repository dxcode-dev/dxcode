// @vitest-environment happy-dom

import type { ThreadListItem } from "@dx/api";
import type { ProjectId, ThreadId } from "@dx/domain";
import { DateTime } from "effect";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadHoverPreview } from "./thread-hover-preview.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-000000000001" as ThreadId;
const thread = {
  id: threadId,
  title: "Compact hover card",
  projectId: "prj_00000000-0000-4000-8000-000000000001" as ProjectId,
  createdAt: DateTime.makeUnsafe("2026-09-09T07:00:00.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-09-09T09:00:00.000Z"),
  lastActivityAt: DateTime.makeUnsafe("2026-09-09T09:30:00.000Z"),
  lifecycleState: "active",
  activityStatus: "idle",
  mode: "medium",
  changes: { additions: 84, deletions: 7, files: 3 },
} as unknown as ThreadListItem;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("thread hover preview", () => {
  it("shows compact thread metadata without conversation or reply UI", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T10:00:00.000Z"));
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await React.act(() =>
      root.render(
        <ThreadHoverPreview
          anchor={{ right: 240, top: 80 }}
          projectName="dx"
          thread={thread}
          onPointerEnter={vi.fn()}
          onPointerLeave={vi.fn()}
        />,
      ),
    );

    const preview = document.querySelector('[aria-label="Preview dx thread"]');
    expect(preview?.textContent).toContain("Compact hover card");
    expect(preview?.textContent).toContain("Created 3h ago, updated 1h ago");
    expect(preview?.textContent).toContain("+84");
    expect(preview?.textContent).toContain("-7");
    expect(preview?.textContent).toContain("~3");
    expect(preview?.textContent).toContain("Modemedium");
    expect(preview?.textContent).toContain("Projectdx");
    expect(preview?.querySelector('[aria-label="Orb idle"]')).not.toBeNull();
    expect(preview?.querySelector("input, button")).toBeNull();
    expect(preview?.textContent).not.toContain("agent response");
    expect(fetch).not.toHaveBeenCalled();

    await React.act(() => root.unmount());
  });

  it("renders list-owned mode and activity", async () => {
    const newerThread = {
      ...thread,
      title: "Newest list title",
      updatedAt: DateTime.makeUnsafe("2026-09-09T10:00:00.000Z"),
      lastActivityAt: DateTime.makeUnsafe("2026-09-09T10:00:00.000Z"),
      activityStatus: "working",
      mode: "high",
    } as ThreadListItem;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await React.act(() =>
      root.render(
        <ThreadHoverPreview
          anchor={{ right: 240, top: 80 }}
          projectName="dx"
          thread={newerThread}
          onPointerEnter={vi.fn()}
          onPointerLeave={vi.fn()}
        />,
      ),
    );

    const preview = document.querySelector('[aria-label="Preview dx thread"]');
    expect(preview?.textContent).toContain("Newest list title");
    expect(preview?.textContent).toContain("Modehigh");
    expect(preview?.querySelector('[aria-label="Orb working"]')).not.toBeNull();

    await React.act(() => root.unmount());
  });

  it("hides unavailable and zero-valued change totals", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await React.act(() =>
      root.render(
        <ThreadHoverPreview
          anchor={{ right: 240, top: 80 }}
          projectName="dx"
          thread={{
            ...thread,
            changes: { additions: 0, deletions: 0, files: 0 },
          }}
          onPointerEnter={vi.fn()}
          onPointerLeave={vi.fn()}
        />,
      ),
    );

    const preview = document.querySelector('[aria-label="Preview dx thread"]');
    expect(preview?.querySelector(".thread-preview-change-totals")).toBeNull();
    expect(preview?.textContent).not.toContain("+0");
    expect(preview?.textContent).not.toContain("-0");
    expect(preview?.textContent).not.toContain("~0");

    await React.act(() => root.unmount());
  });

  it("does not fetch when optional list projections are unavailable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await React.act(() =>
      root.render(
        <ThreadHoverPreview
          anchor={{ right: 240, top: 80 }}
          projectName="dx"
          thread={{ ...thread, mode: undefined, changes: undefined }}
          onPointerEnter={vi.fn()}
          onPointerLeave={vi.fn()}
        />,
      ),
    );

    const preview = document.querySelector('[aria-label="Preview dx thread"]');
    expect(preview?.querySelector(".thread-preview-change-totals")).toBeNull();
    expect(preview?.textContent).toContain("Mode—");
    expect(preview?.textContent).not.toContain("+0");
    expect(fetch).not.toHaveBeenCalled();

    await React.act(() => root.unmount());
  });
});
