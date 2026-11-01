import type { ThreadDetailData } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sharing = vi.hoisted(() => ({ update: vi.fn() }));
const userId = "share-user" as UserId;

vi.mock("../../../shared/auth/auth-context.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../shared/auth/auth-context.js")
  >()),
  useAuthenticatedIdentity: () => ({ identity: { id: "share-user" } }),
}));

vi.mock("../../../shared/api/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/api/client.js")>()),
  updateThreadSharing: sharing.update,
}));

import { Toaster } from "../../../shared/ui/sonner.js";
import { settingsContextQueryOptions } from "../../settings/settings-context-queries.js";
import { ShareDialog } from "./share-dialog.js";

const thread = {
  id: "thr_00000000-0000-4000-8000-000000000091" as ThreadId,
  access: "owner",
  skipMultiplayerConfirmation: false,
} as unknown as ThreadDetailData;

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
const click = (element: Element | undefined | null) =>
  React.act(() =>
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );

afterEach(async () => {
  sharing.update.mockReset();
  await React.act(() => toast.dismiss());
  document.body.replaceChildren();
});

describe("Share dialog notices", () => {
  it("confirms a sharing change with a toast", async () => {
    sharing.update.mockResolvedValue({
      sharing: { workspaceAccess: "view" },
      skipMultiplayerConfirmation: false,
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(settingsContextQueryOptions(userId).queryKey, {
      workspace: { displayName: "Acme" },
    } as never);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ShareDialog thread={thread} open onOpenChange={() => undefined} />
          <Toaster position="bottom-right" closeButton />
        </QueryClientProvider>,
      ),
    );

    await click(
      document.querySelector('[aria-label="Workspace access: No access"]'),
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[role="menuitemradio"]')).not.toBeNull(),
    );
    await click(
      [...document.querySelectorAll('[role="menuitemradio"]')].find(
        (item) => item.textContent?.trim() === "View",
      ),
    );
    expect(sharing.update).toHaveBeenCalledWith(thread.id, {
      workspaceAccess: "view",
    });
    await vi.waitFor(() =>
      expect(titleOf(onlyToast())).toBe("Sharing updated"),
    );
    expect(onlyToast().dataset.type).toBe("success");
    await React.act(() => root.unmount());
  });
});
