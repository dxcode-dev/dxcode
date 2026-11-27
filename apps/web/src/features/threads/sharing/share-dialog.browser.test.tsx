import type { ThreadDetailData } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** The sharing PUTs the dialog sends, answered as Core would. */
const sharing = {
  update: vi.fn<typeof globalThis.fetch>(),
  bodies: () =>
    sharing.update.mock.calls
      .filter(([, init]) => init?.method === "PUT")
      .map(([input, init]) => ({
        path: String(input),
        body: JSON.parse(String(init?.body)) as unknown,
      })),
};
const userId = "share-user" as UserId;

vi.mock("../../../shared/auth/auth-context.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../shared/auth/auth-context.js")
  >()),
  useAuthenticatedIdentity: () => ({ identity: { id: "share-user" } }),
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
  vi.unstubAllGlobals();
  await React.act(() => toast.dismiss());
  document.body.replaceChildren();
});

describe("Share dialog notices", () => {
  it("confirms a sharing change with a toast", async () => {
    sharing.update.mockImplementation(async () =>
      Response.json({
        status: "success",
        data: {
          threadId: thread.id,
          sharing: { workspaceAccess: "view" },
          skipMultiplayerConfirmation: false,
        },
      }),
    );
    vi.stubGlobal("fetch", sharing.update);
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
    await vi.waitFor(() =>
      expect(sharing.bodies()).toEqual([
        {
          path: `/v1/threads/${thread.id}/sharing`,
          body: { workspaceAccess: "view" },
        },
      ]),
    );
    await vi.waitFor(() =>
      expect(titleOf(onlyToast())).toBe("Sharing updated"),
    );
    expect(onlyToast().dataset.type).toBe("success");
    await React.act(() => root.unmount());
  });
});
