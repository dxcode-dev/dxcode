// The phone drawer's first open (#1183): within 200 ms of the tap it shows
// Thread rows, or a loading state while the list is still on its way. It
// never slides in as an empty panel.

import type { UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../shared/use-mobile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/use-mobile.js")>()),
  useMobile: () => true,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Outlet: () => <p>Page</p>,
  // The row's own attributes, without navigating the test page.
  Link: ({
    to: _to,
    params: _params,
    ...props
  }: React.ComponentProps<"a"> & { to: string; params?: unknown }) => (
    <a {...props} />
  ),
  useLocation: ({
    select,
  }: {
    readonly select: (location: { readonly pathname: string }) => unknown;
  }) => select({ pathname: "/threads/thr_open" }),
  useNavigate: () => () => undefined,
}));
vi.mock("./sidebar-account-menu.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sidebar-account-menu.js")>()),
  SidebarAccountMenu: () => null,
}));
vi.mock("./notification-inbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./notification-inbox.js")>()),
  NotificationInbox: () => null,
}));
vi.mock("./needs-you-inbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./needs-you-inbox.js")>()),
  NeedsYouInbox: () => null,
}));
vi.mock("../../shared/thread-archive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/thread-archive.js")>()),
  useThreadArchive: () => ({
    setArchived: () => undefined,
    pendingThreadId: undefined,
  }),
}));
vi.mock("../../shared/new-thread-surface.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../shared/new-thread-surface.js")
  >()),
  useNewThreadSurface: () => ({ openNewThread: () => undefined }),
}));

import { AuthContext } from "../../shared/auth/auth-context.js";
import { createQueryClient } from "../../shared/query/query-client.js";
import { projectKeys } from "../projects/project-queries.js";
import { threadKeys } from "../threads/thread-queries.js";
import { ProductShell } from "./product-shell.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const userId = "usr_drawer_first_open" as UserId;
const now = new Date().toISOString();
const thread = {
  id: "thr_open",
  ownerId: userId,
  projectId: "prj_drawer",
  projectless: false,
  title: "Drawer row",
  lifecycleState: "active",
  activityStatus: "idle",
  createdAt: now,
  updatedAt: now,
  lastActivityAt: now,
};
let root: Root | undefined;

afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** The shell on a phone; `listed` decides whether the Thread list loaded. */
const mountShell = async (listed: boolean) => {
  // Every request stays in flight, as on a slow first load.
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
  const client = createQueryClient();
  client.setQueryData(projectKeys.lists(userId), {
    pages: [{ items: [{ id: "prj_drawer", name: "Drawer project" }] }],
    pageParams: [undefined],
  });
  if (listed)
    client.setQueryData(threadKeys.list(userId, undefined, "active", "roots"), {
      pages: [{ items: [thread] }],
      pageParams: [undefined],
    });
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Test", email: "t@dx.test" },
            logout: () => undefined,
          }}
        >
          <ProductShell />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-label="Open sidebar"]',
  );
  if (trigger === null) throw new Error("Expected the sidebar trigger.");
  return trigger;
};

/** What the drawer's Thread list shows 200 ms after the first tap. */
const firstOpen = async (trigger: HTMLButtonElement) => {
  const tapped = performance.now();
  await React.act(() => trigger.click());
  await React.act(
    () =>
      new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 200 - (performance.now() - tapped))),
      ),
  );
  const list = document.querySelector(
    ".mobile-sidebar-drawer nav[aria-label='Threads']",
  );
  return {
    rows: list?.querySelectorAll("[data-command-sidebar-item]").length ?? 0,
    status: list?.querySelector("[role='status']")?.textContent ?? null,
  };
};

it("shows a loading state at once while the Thread list is on its way", async () => {
  const shown = await firstOpen(await mountShell(false));
  expect(shown).toEqual({ rows: 0, status: "Loading threads…" });
});

it("shows the Thread rows at once once the list has loaded", async () => {
  const shown = await firstOpen(await mountShell(true));
  expect(shown).toEqual({ rows: 1, status: null });
});
