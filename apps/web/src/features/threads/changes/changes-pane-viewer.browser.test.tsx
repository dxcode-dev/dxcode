import type {
  ThreadChangesCaptureId,
  ThreadChangesCommitSha,
  ThreadChangesPath,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@pierre/diffs/worker/worker-portable.js?url&no-inline",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@pierre/diffs/worker/worker-portable.js?url&no-inline")
    >()),
    default: "/assets/worker-portable.js",
  }),
);

import type { ChangesTransport } from "./changes-api.js";
import { ChangesPane } from "./changes-pane.js";
import { preloadChangesPane } from "./changes-pane-loader.js";

await preloadChangesPane();

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "thr_00000000-0000-4000-8000-000000001659" as ThreadId;
const sha = "a".repeat(40) as ThreadChangesCommitSha;

afterEach(() => document.body.replaceChildren());

// A View-only member of a shared Thread (#1659): the list says which files
// changed and by how much; a file's contents are the Orb's, so expanding it
// never asks for its diff and nothing offers to open it.
describe("Changes pane for a View-only member", () => {
  it("lists changed files without reading their contents", async () => {
    const getDiff = vi.fn<ChangesTransport["getDiff"]>();
    const transport: ChangesTransport = {
      getChanges: async (_thread, range) => ({
        kind: "changes",
        captureId:
          "chg_00000000-0000-4000-8000-000000001659" as ThreadChangesCaptureId,
        freshness: "complete",
        capturedAt: "2026-11-04T00:00:00.000Z",
        range,
        truncated: false,
        baseline: sha,
        head: sha,
        ahead: 0,
        summary: { additions: 1, deletions: 0, files: 1 },
        files: [
          {
            path: ".env" as ThreadChangesPath,
            status: "untracked",
            additions: 1,
            deletions: 0,
            binary: false,
            truncated: false,
          },
        ],
        commits: [],
      }),
      getDiff,
      push: vi.fn(),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ChangesPane
            threadId={threadId}
            transport={transport}
            onReviewPrompt={() => undefined}
            onOpenFile={vi.fn()}
            contentsHidden
          />
        </QueryClientProvider>,
      ),
    );
    await React.act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    const row = container.querySelector<HTMLButtonElement>(
      ".changes-file-trigger",
    );
    expect(row?.textContent).toContain(".env");
    expect(row?.textContent).toContain("+1");

    await React.act(() => row?.click());
    expect(container.querySelector(".changes-diff-region")?.textContent).toBe(
      "Only contributors can see what changed inside a file.",
    );
    expect(getDiff).not.toHaveBeenCalled();

    await React.act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Actions for .env"]')
        ?.click(),
    );
    const open = [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent?.includes("Open File"),
    );
    expect(open?.hasAttribute("data-disabled")).toBe(true);
    await React.act(() => root.unmount());
    client.clear();
  });
});
