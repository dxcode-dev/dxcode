import type { ThreadData } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
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

import { ApiError } from "../../shared/api/client.js";
import { useThreadArchive } from "../../shared/thread-archive.js";
import { Toaster } from "../../shared/ui/sonner.js";
import { ThreadArchiveProvider } from "./thread-archive.js";

const threadId = "thr_00000000-0000-4000-8000-000000000071" as ThreadId;
const childId = "thr_00000000-0000-4000-8000-000000000072" as ThreadId;

function ArchiveControls() {
  const archive = useThreadArchive();
  return (
    <>
      <button type="button" onClick={() => archive.setArchived(threadId, true)}>
        Archive from touchpoint
      </button>
      <button
        type="button"
        onClick={() => archive.setArchived(threadId, true, true)}
      >
        Archive with children
      </button>
      <button
        type="button"
        onClick={() => archive.setArchived(threadId, false)}
      >
        Unarchive from touchpoint
      </button>
    </>
  );
}

/** The app's one Toaster: every notice is a toast in its live region. */
const toasts = () => [
  ...document.querySelectorAll<HTMLElement>(
    '[aria-live="polite"] [data-sonner-toast]',
  ),
];
const onlyToast = () => {
  const all = toasts();
  expect(all).toHaveLength(1);
  return all[0] as HTMLElement;
};
const titleOf = (element: HTMLElement) =>
  element.querySelector("[data-title]")?.textContent;
const buttonIn = (element: ParentNode, name: string) =>
  [...element.querySelectorAll("button")].find(
    (button) =>
      button.textContent?.trim() === name ||
      button.getAttribute("aria-label") === name,
  );
const click = (element: Element | undefined | null) =>
  React.act(() =>
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );

const render = async () => {
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
          <ArchiveControls />
        </ThreadArchiveProvider>
        <Toaster position="bottom-right" closeButton />
      </QueryClientProvider>,
    ),
  );
  return { container, root };
};

afterEach(async () => {
  archiveMutation.execute.mockReset();
  await React.act(() => toast.dismiss());
  document.body.replaceChildren();
});

describe("Thread archive notices", () => {
  it("confirms an archive at once, and Undo before it returns unarchives in the same toast", async () => {
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
    const { container, root } = await render();

    await click(buttonIn(container, "Archive from touchpoint"));
    // The confirmation and its Undo show while the request is in flight.
    await vi.waitFor(() =>
      expect(titleOf(onlyToast())).toBe("Archived thread"),
    );
    expect(buttonIn(onlyToast(), "Dismiss notification")).toBeDefined();
    await click(buttonIn(onlyToast(), "Undo"));
    await vi.waitFor(() =>
      expect(titleOf(onlyToast())).toBe("Unarchived thread"),
    );
    expect(buttonIn(onlyToast(), "Undo")).toBeUndefined();

    await React.act(async () => {
      resolveArchive?.({
        thread: { id: threadId, lifecycleState: "archived" } as ThreadData,
      });
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(archiveMutation.execute).toHaveBeenCalledTimes(2),
    );
    expect(archiveMutation.execute.mock.calls[0]?.[0]).toEqual({
      threadId,
      archived: true,
    });
    expect(archiveMutation.execute.mock.calls[1]?.[0]).toEqual({
      threadId,
      archived: false,
    });
    // The archive's answer does not bring back its own toast.
    expect(titleOf(onlyToast())).toBe("Unarchived thread");

    await React.act(() => root.unmount());
  });

  it("says the Orb is still stopping when the archive worked but its Orb couldn't stop yet (#1740)", async () => {
    archiveMutation.execute.mockResolvedValueOnce({
      thread: { id: threadId, lifecycleState: "archived" } as ThreadData,
      orbStopping: true,
    });
    const { container, root } = await render();

    await click(buttonIn(container, "Archive from touchpoint"));
    await vi.waitFor(() =>
      expect(onlyToast().querySelector("[data-description]")?.textContent).toBe(
        "Its Orb is still stopping.",
      ),
    );
    // Still the archive's notice, with its Undo: nothing failed.
    expect(titleOf(onlyToast())).toBe("Archived thread");
    expect(buttonIn(onlyToast(), "Undo")).toBeDefined();
    expect(onlyToast().getAttribute("data-type")).not.toBe("error");

    await React.act(() => root.unmount());
  });

  it("Undo restores the children the archive changed", async () => {
    archiveMutation.execute
      .mockResolvedValueOnce({
        thread: { id: threadId, lifecycleState: "archived" } as ThreadData,
        changedChildThreadIds: [childId],
      })
      .mockResolvedValueOnce({
        thread: { id: threadId, lifecycleState: "active" } as ThreadData,
      });
    const { container, root } = await render();

    await click(buttonIn(container, "Archive with children"));
    await vi.waitFor(() =>
      expect(titleOf(onlyToast())).toBe("Archived threads"),
    );
    await click(buttonIn(onlyToast(), "Undo"));
    expect(archiveMutation.execute.mock.calls[0]?.[0]).toEqual({
      threadId,
      archived: true,
      children: true,
    });
    await vi.waitFor(() =>
      expect(archiveMutation.execute).toHaveBeenCalledTimes(2),
    );
    const undo = archiveMutation.execute.mock.calls[1]?.[0];
    expect(undo).toMatchObject({ threadId, archived: false });
    // The Undo restores the children the archive's answer named.
    await expect(Promise.resolve(undo?.children)).resolves.toEqual([childId]);
    await vi.waitFor(() =>
      expect(titleOf(onlyToast())).toBe("Unarchived thread"),
    );
    await React.act(() => root.unmount());
  });

  it("reports a failed request and dismisses on request", async () => {
    // The server's own reason, as the API client throws it.
    archiveMutation.execute.mockRejectedValueOnce(
      new ApiError(409, "Thread is already archived.", "THREAD_ARCHIVED"),
    );
    const { container, root } = await render();

    await click(buttonIn(container, "Unarchive from touchpoint"));
    await vi.waitFor(() =>
      expect(titleOf(onlyToast())).toBe("Thread is already archived."),
    );
    expect(onlyToast().dataset.type).toBe("error");
    expect(buttonIn(onlyToast(), "Undo")).toBeUndefined();

    await click(buttonIn(onlyToast(), "Dismiss notification"));
    await vi.waitFor(() => expect(toasts()).toHaveLength(0));
    await React.act(() => root.unmount());
  });
});
