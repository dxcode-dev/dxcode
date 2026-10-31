/**
 * The Thread tree page, compiled and in Chromium, against a stubbed
 * `GET /v1/threads/:threadId/tree`.
 *
 * Ways it could fail, each covered below:
 *  1. A grandchild lists flat under the root instead of under its starter.
 *  2. A child whose starter is absent (started before dx recorded starters,
 *     or a starter the requester cannot read) disappears instead of sitting
 *     under the root, or at the top when the root is absent too.
 *  3. A starter cycle hangs the page or drops Threads.
 *  4. The Thread the page opened from is not marked current.
 *  5. Collapsing hides the wrong Threads, or does not say how many it hid.
 *  6. Working, unread, error, and archived Threads look alike.
 *  7. A missing Thread crashes the page instead of saying so; a truncated
 *     family does not say so.
 */
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    params,
    to: _to,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    readonly params: { readonly threadId: string };
    readonly to: string;
  }) => (
    <a href={`/threads/${params.threadId}`} {...props}>
      {children}
    </a>
  ),
}));

import { AuthContext } from "../../../shared/auth/auth-context.js";
import { ThreadTreePage } from "./thread-tree-page.js";

const id = (suffix: string) =>
  `thr_00000000-0000-4000-8000-000000000${suffix}` as ThreadId;
const root = id("a01");
const lead = id("a02");
const worker = id("a03");
const legacy = id("a04");
const second = id("a05");

const item = (
  threadId: ThreadId,
  title: string,
  minute: number,
  fields: Record<string, unknown> = {},
) => ({
  id: threadId,
  title,
  projectId: "prj_00000000-0000-4000-8000-000000000001",
  visibility: "private",
  createdAt: `2026-10-30T10:${String(minute).padStart(2, "0")}:00.000Z`,
  updatedAt: "2026-10-30T10:00:00.000Z",
  lastActivityAt: "2026-10-30T10:00:00.000Z",
  activityStatus: "idle",
  lifecycleState: "active",
  agentUrl: `/v1/agents/dx/${threadId}`,
  mode: "medium",
  ...(threadId === root ? {} : { parentThreadId: root }),
  ...fields,
});

const family = {
  rootThreadId: root,
  items: [
    item(root, "Chief of staff", 0),
    item(lead, "Engineering lead", 1, {
      startedByThreadId: root,
      unread: true,
    }),
    item(worker, "Issue owner #1100", 2, {
      startedByThreadId: lead,
      activityStatus: "working",
    }),
    item(legacy, "Started before starters", 3),
    item(second, "Issue owner #1141", 4, {
      startedByThreadId: lead,
      lifecycleState: "archived",
      turnFailed: true,
    }),
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const render = async (threadId: ThreadId, response: unknown, status = 200) => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(() =>
      Promise.resolve(Response.json(response, { status })),
    );
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const reactRoot = createRoot(container);
  await React.act(async () =>
    reactRoot.render(
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
          <ThreadTreePage threadId={threadId} />
        </QueryClientProvider>
      </AuthContext.Provider>,
    ),
  );
  await vi.waitFor(() =>
    expect(
      container
        .querySelector("[data-thread-tree-state]")
        ?.getAttribute("data-thread-tree-state"),
    ).not.toBe("loading"),
  );
  return {
    container,
    fetch,
    unmount: async () => {
      await React.act(() => reactRoot.unmount());
      client.clear();
    },
  };
};

/** Each row's title, indented by its depth. */
const outline = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-tree-node]")].map(
    (node) =>
      `${"  ".repeat(Number(node.dataset.depth))}${
        node.querySelector("[data-tree-title]")?.textContent
      }`,
  );

const row = (container: HTMLElement, threadId: ThreadId) =>
  container.querySelector<HTMLElement>(`[data-tree-node="${threadId}"]`);

describe("Thread tree page", () => {
  it("nests each Thread under the one that started it", async () => {
    const page = await render(worker, { status: "success", data: family });
    try {
      expect(page.fetch.mock.calls[0]?.[0]).toBe(`/v1/threads/${worker}/tree`);
      expect(outline(page.container)).toEqual([
        "Chief of staff",
        "  Engineering lead",
        "    Issue owner #1100",
        "    Issue owner #1141",
        "  Started before starters",
      ]);
      // The page opened from the worker marks it current.
      expect(
        row(page.container, worker)
          ?.querySelector("a")
          ?.getAttribute("aria-current"),
      ).toBe("page");
      expect(
        page.container.querySelectorAll('[aria-current="page"]'),
      ).toHaveLength(1);
      // Each row opens its Thread.
      expect(
        row(page.container, lead)?.querySelector("a")?.getAttribute("href"),
      ).toBe(`/threads/${lead}`);
      // Status reads apart.
      expect(
        row(page.container, worker)
          ?.querySelector("[data-activity-status]")
          ?.getAttribute("data-activity-status"),
      ).toBe("working");
      expect(
        row(page.container, lead)?.querySelector("[data-unread]"),
      ).not.toBeNull();
      expect(row(page.container, second)?.textContent).toContain("Error");
      expect(row(page.container, second)?.textContent).toContain("Archived");
      expect(row(page.container, legacy)?.textContent).not.toMatch(
        /Error|Archived/,
      );
      expect(page.container.textContent).toContain("5 threads");
    } finally {
      await page.unmount();
    }
  });

  it("collapses a Thread's subtree and says how many it hides", async () => {
    const page = await render(root, { status: "success", data: family });
    try {
      const toggle = row(
        page.container,
        lead,
      )?.querySelector<HTMLButtonElement>("button[aria-expanded]");
      expect(toggle?.getAttribute("aria-expanded")).toBe("true");
      // Leaves have no toggle.
      expect(
        row(page.container, worker)?.querySelector("button[aria-expanded]"),
      ).toBeNull();
      await React.act(async () => toggle?.click());
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      expect(outline(page.container)).toEqual([
        "Chief of staff",
        "  Engineering lead",
        "  Started before starters",
      ]);
      expect(
        row(page.container, lead)?.querySelector("[data-hidden-count]")
          ?.textContent,
      ).toBe("2");
      await React.act(async () => toggle?.click());
      expect(outline(page.container)).toHaveLength(5);
    } finally {
      await page.unmount();
    }
  });

  it("puts Threads whose starter or root is missing at the top, and survives a starter cycle", async () => {
    const page = await render(lead, {
      status: "success",
      data: {
        rootThreadId: root,
        // A member who may not read the root; two Threads name each other.
        items: [
          item(lead, "Engineering lead", 1, { startedByThreadId: root }),
          item(worker, "Issue owner #1100", 2, { startedByThreadId: lead }),
          item(legacy, "Loop A", 3, { startedByThreadId: second }),
          item(second, "Loop B", 4, { startedByThreadId: legacy }),
        ],
        truncated: true,
      },
    });
    try {
      const rows = outline(page.container);
      expect(rows.slice(0, 2)).toEqual([
        "Engineering lead",
        "  Issue owner #1100",
      ]);
      expect(rows).toHaveLength(4);
      expect(rows.filter((line) => /Loop/.test(line))).toHaveLength(2);
      expect(page.container.textContent).toMatch(/newest .*not shown/i);
    } finally {
      await page.unmount();
    }
  });

  it("says when the Thread cannot be found", async () => {
    const page = await render(
      root,
      {
        status: "error",
        data: {
          code: "THREAD_NOT_FOUND",
          message: "Thread not found.",
          requestId: "test",
        },
      },
      404,
    );
    try {
      expect(
        page.container
          .querySelector("[data-thread-tree-state]")
          ?.getAttribute("data-thread-tree-state"),
      ).toBe("error");
      expect(page.container.textContent).toContain("could not be loaded");
      expect(page.container.querySelector("[data-tree-node]")).toBeNull();
    } finally {
      await page.unmount();
    }
  });
});
