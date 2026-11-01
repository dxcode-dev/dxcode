import type { ThreadId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const snoozeMutation = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("../../shared/auth/auth-context.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../shared/auth/auth-context.js")
  >()),
  useAuthenticatedIdentity: () => ({ identity: { id: "snooze-user" } }),
}));

vi.mock("./thread-mutations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thread-mutations.js")>()),
  setThreadSnoozedMutationOptions: () => ({
    mutationKey: ["threads", "snooze"],
    mutationFn: snoozeMutation.execute,
  }),
}));

import { useOptionalThreadSnooze } from "../../shared/thread-snooze.js";
import { Toaster } from "../../shared/ui/sonner.js";
import { ThreadSnoozeProvider } from "./thread-snooze.js";

const threadId = "thr_00000000-0000-4000-8000-000000000081" as ThreadId;

function SnoozeControls() {
  const snooze = useOptionalThreadSnooze();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          snooze?.snooze(threadId, new Date(Date.now() + 60 * 60 * 1_000))
        }
      >
        Snooze for an hour
      </button>
      <button type="button" onClick={() => snooze?.wake(threadId)}>
        Wake now
      </button>
    </>
  );
}

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
        <ThreadSnoozeProvider>
          <SnoozeControls />
        </ThreadSnoozeProvider>
        <Toaster position="bottom-right" closeButton />
      </QueryClientProvider>,
    ),
  );
  return { container, root };
};

afterEach(async () => {
  snoozeMutation.execute.mockReset();
  await React.act(() => toast.dismiss());
  document.body.replaceChildren();
});

describe("Thread snooze notices", () => {
  it("confirms a snooze, and Undo wakes the Thread and closes the toast", async () => {
    snoozeMutation.execute.mockResolvedValue({});
    const { container, root } = await render();

    await click(buttonIn(container, "Snooze for an hour"));
    await vi.waitFor(() =>
      expect(titleOf(onlyToast())).toMatch(/^Snoozed until /u),
    );
    expect(buttonIn(onlyToast(), "Dismiss notification")).toBeDefined();

    await click(buttonIn(onlyToast(), "Undo"));
    await vi.waitFor(() => expect(toasts()).toHaveLength(0));
    expect(snoozeMutation.execute).toHaveBeenCalledTimes(2);
    expect(snoozeMutation.execute.mock.calls[1]?.[0]).toEqual({
      threadId,
      snoozedUntil: null,
    });
    await React.act(() => root.unmount());
  });

  it("reports a failed snooze and a failed wake as error toasts", async () => {
    snoozeMutation.execute
      .mockRejectedValueOnce(new Error("Snooze is unavailable."))
      .mockRejectedValueOnce(new Error(""));
    const { container, root } = await render();

    await click(buttonIn(container, "Snooze for an hour"));
    await vi.waitFor(() =>
      expect(titleOf(onlyToast())).toBe("Snooze is unavailable."),
    );
    expect(onlyToast().dataset.type).toBe("error");
    expect(buttonIn(onlyToast(), "Undo")).toBeUndefined();

    await click(buttonIn(container, "Wake now"));
    await vi.waitFor(() =>
      expect(titleOf(onlyToast())).toBe("Thread could not be woken."),
    );

    await click(buttonIn(onlyToast(), "Dismiss notification"));
    await vi.waitFor(() => expect(toasts()).toHaveLength(0));
    await React.act(() => root.unmount());
  });
});
