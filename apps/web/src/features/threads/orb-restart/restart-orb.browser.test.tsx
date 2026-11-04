import type { ThreadDetailData } from "@dx/api";
import { defaultThreadModelSelection, type UserId } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DateTime } from "effect";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
}));

import { AuthContext } from "../../../shared/auth/auth-context.js";
import { ThreadMenu } from "../thread-menu.js";
import "../../../styles.css";

/** Restart Orb in the Thread's menu (#1592): who sees it, and what it does. */

const thread = {
  createdAt: DateTime.makeUnsafe("2026-10-31T00:00:00.000Z"),
  id: "thr_00000000-0000-4000-8000-000000001592",
  projectId: "prj_00000000000000000000000000001592",
  title: "Restart Orb",
  visibility: "private",
  lifecycleState: "active",
  activityStatus: "idle",
  executionWorkspace: { ready: true, preparationStatus: null },
  agentInitialization: { selection: defaultThreadModelSelection() },
} as ThreadDetailData;

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
  for (const root of roots.splice(0)) await React.act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  toast.mockReset();
});

const viewer = "usr_00000000000000000000000000001592" as UserId;

/** Opens the menu as a signed-in person with the flag on or off. */
const openMenu = async (shown: ThreadDetailData, flagOn = true) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(["experimental-features", viewer], {
    flags: [{ registration: { id: "orb-restart" }, effectiveEnabled: flagOn }],
  });
  await React.act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <AuthContext
          value={{
            identity: { id: viewer, name: "Ravi", email: "r@dx.test" },
            logout: () => undefined,
          }}
        >
          <ThreadMenu thread={shown} transcript={() => model} />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  await React.act(() =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="More Actions"]')
      ?.click(),
  );
  await vi.waitFor(() =>
    expect(document.querySelector(".thread-actions-menu")).not.toBeNull(),
  );
  // The item loads with the menu; let it settle before looking, so a hidden
  // item is hidden, not still loading.
  await import("./restart-orb-actions.js");
  await React.act(() => new Promise((resolve) => setTimeout(resolve, 0)));
};

const restartItem = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>(
      ".thread-actions-menu .thread-menu-item",
    ),
  ).find((item) => item.textContent?.trim() === "Restart Orb…");

/** The open Restart Orb dialog, found by its title. */
const restartDialog = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find(
    (dialog) =>
      document
        .getElementById(dialog.getAttribute("aria-labelledby") ?? "")
        ?.textContent?.startsWith("Restart the Orb"),
  ) ?? null;

const button = (name: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );

/**
 * Routes the restart request to `restart`; the menu's other reads (the Orb's
 * memory, the Thread's cost) get a 404, so `restart` sees only restarts.
 */
const stubRestart = (
  restart: (url: string, init?: RequestInit) => Promise<Response>,
) =>
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
    url.endsWith("/orb/restart")
      ? restart(url, init)
      : Response.json(
          {
            status: "error",
            data: { code: "NOT_FOUND", message: "", requestId: "req-0" },
          },
          { status: 404 },
        ),
  );

describe("Restart Orb", () => {
  it("is offered to the owner and contributors of an active Thread, never to viewers or on an archived Thread", async () => {
    const cases: ReadonlyArray<[Partial<ThreadDetailData>, boolean]> = [
      [{}, true],
      [{ access: "owner" }, true],
      [{ access: "contribute" }, true],
      [{ access: "view" }, false],
      [{ lifecycleState: "archived" }, false],
    ];
    for (const [overrides, offered] of cases) {
      await openMenu({ ...thread, ...overrides } as ThreadDetailData);
      expect(restartItem() !== undefined).toBe(offered);
      for (const root of roots.splice(0)) await React.act(() => root.unmount());
      document.body.replaceChildren();
    }
  });

  it("is hidden unless the person turned on the orb-restart experimental feature", async () => {
    await openMenu(thread, false);
    expect(restartItem()).toBeUndefined();
    expect(
      Array.from(
        document.querySelectorAll(".thread-actions-menu .thread-menu-item"),
      ).some((item) => item.textContent?.trim() === "Report Bug"),
    ).toBe(true);
  });

  it("asks first, saying files are kept and processes stop, then restarts the Orb", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        status: "success",
        data: { files: "kept", restartedAt: "2026-11-03T04:00:00.000Z" },
      }),
    );
    stubRestart(fetch);
    await openMenu(thread);
    await React.act(() => restartItem()?.click());
    const dialog = await vi.waitFor(() => {
      const found = restartDialog();
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(dialog.textContent).toContain("Its files are kept.");
    expect(dialog.textContent).toMatch(/Running processes, .* stop\./);
    // Nothing restarts until the person confirms.
    expect(fetch).not.toHaveBeenCalled();

    await React.act(() => button("Restart Orb")?.click());
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Orb restarted. Its files were kept."),
    );
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/v1/threads/${thread.id}/orb/restart`);
    expect(init.method).toBe("POST");
    await vi.waitFor(() => expect(restartDialog()).toBeNull());
  });

  it("keeps the dialog open with the reason when the restart is refused", async () => {
    stubRestart(
      vi.fn(async () =>
        Response.json(
          {
            status: "error",
            data: {
              code: "ORB_RESTART_TOO_SOON",
              message:
                "The Orb restarted less than 2 minutes ago. Try again in 87 s.",
              requestId: "req-1",
              retryAfterSeconds: 87,
            },
          },
          { status: 429 },
        ),
      ),
    );
    await openMenu(thread);
    await React.act(() => restartItem()?.click());
    await vi.waitFor(() => expect(button("Restart Orb")).toBeDefined());
    await React.act(() => button("Restart Orb")?.click());
    const alert = await vi.waitFor(() => {
      const found =
        restartDialog()?.querySelector<HTMLElement>('[role="alert"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(alert.textContent).toContain("Try again in 87 s.");
    expect(toast).not.toHaveBeenCalled();
  });

  it("offers to restart from the last save when the Orb can't be saved, saying what is lost (#1614)", async () => {
    const bodies: unknown[] = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return bodies.length === 1
        ? Response.json(
            {
              status: "error",
              data: {
                code: "ORB_RESTART_UNSAVED",
                message: "dx couldn't save the Orb's files first.",
                requestId: "req-1",
                lastSavedAt: "2026-11-03T09:00:00.000Z",
              },
            },
            { status: 409 },
          )
        : Response.json({
            status: "success",
            data: {
              files: "earlier",
              restartedAt: "2026-11-03T12:00:00.000Z",
              savedAt: "2026-11-03T09:00:00.000Z",
              rescue: "copied",
              restoredName: "dx-recovered-2026-11-03T12-00-00.tar.gz",
            },
          });
    });
    stubRestart(fetch);
    await openMenu(thread);
    await React.act(() => restartItem()?.click());
    await vi.waitFor(() => expect(button("Restart Orb")).toBeDefined());
    await React.act(() => button("Restart Orb")?.click());

    // The second, explicit choice, only after the plain restart was refused.
    await vi.waitFor(() =>
      expect(button("Restart From Last Save")).toBeDefined(),
    );
    const dialog = restartDialog();
    expect(dialog?.textContent).toContain(
      "Everything that changed since is lost.",
    );
    expect(dialog?.textContent).toContain("~/dx-recovered/");
    expect(bodies).toEqual([{}]);

    await React.act(() => button("Restart From Last Save")?.click());
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Orb restarted from its last save. Unsaved work was copied to ~/dx-recovered/dx-recovered-2026-11-03T12-00-00.tar.gz.",
      ),
    );
    expect(bodies).toEqual([{}, { discardUnsaved: true }]);
  });

  it("offers no fallback when the Orb has never been saved", async () => {
    stubRestart(
      vi.fn(async () =>
        Response.json(
          {
            status: "error",
            data: {
              code: "ORB_RESTART_UNSAVED",
              message:
                "dx couldn't save the Orb's files first, and it has no earlier save.",
              requestId: "req-2",
            },
          },
          { status: 409 },
        ),
      ),
    );
    await openMenu(thread);
    await React.act(() => restartItem()?.click());
    await vi.waitFor(() => expect(button("Restart Orb")).toBeDefined());
    await React.act(() => button("Restart Orb")?.click());
    await vi.waitFor(() =>
      expect(
        restartDialog()?.querySelector('[role="alert"]')?.textContent,
      ).toContain("no earlier save"),
    );
    expect(button("Restart From Last Save")).toBeUndefined();
  });
});
