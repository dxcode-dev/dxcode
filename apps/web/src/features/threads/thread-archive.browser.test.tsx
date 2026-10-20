import type { ThreadData } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const archiveMutation = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("../../shared/auth/auth-context.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../shared/auth/auth-context.js")
  >()),
  useAuthenticatedIdentity: () => ({ identity: { id: "archive-user" } }),
}));

vi.mock("./thread-mutations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thread-mutations.js")>()),
  setThreadArchivedMutationOptions: () => ({
    mutationKey: ["threads", "archive"],
    mutationFn: archiveMutation.execute,
  }),
}));

import { useThreadArchive } from "../../shared/thread-archive.js";
import { ThreadArchiveProvider } from "./thread-archive.js";

const threadId = "thr_00000000-0000-4000-8000-000000000071" as ThreadId;

function ArchiveControl() {
  const archive = useThreadArchive();
  return (
    <button type="button" onClick={() => archive.setArchived(threadId, true)}>
      Archive from touchpoint
    </button>
  );
}

afterEach(() => {
  archiveMutation.execute.mockReset();
  document.body.replaceChildren();
});

describe("Thread archive journey feedback", () => {
  it("shows progress, confirms archive, and supports Undo", async () => {
    let resolveArchive:
      | ((archived: { thread: ThreadData }) => void)
      | undefined;
    archiveMutation.execute
      .mockImplementationOnce(
        () =>
          new Promise<{ thread: ThreadData }>((resolve) => {
            resolveArchive = resolve;
          }),
      )
      .mockResolvedValueOnce({
        thread: { id: threadId, lifecycleState: "active" } as ThreadData,
      });
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThreadArchiveProvider>
            <ArchiveControl />
          </ThreadArchiveProvider>
        </QueryClientProvider>,
      ),
    );

    await React.act(() =>
      container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Archiving thread…",
    );
    await React.act(() =>
      container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(archiveMutation.execute).toHaveBeenCalledOnce();

    await React.act(async () => {
      resolveArchive?.({
        thread: { id: threadId, lifecycleState: "archived" } as ThreadData,
      });
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        "Archived threadUndo",
      ),
    );

    await React.act(() =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Undo")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(archiveMutation.execute.mock.calls[0]?.[0]).toEqual({
      threadId,
      archived: true,
    });
    expect(archiveMutation.execute.mock.calls[1]?.[0]).toEqual({
      threadId,
      archived: false,
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        "Unarchived thread",
      ),
    );

    await React.act(() => root.unmount());
  });
});
