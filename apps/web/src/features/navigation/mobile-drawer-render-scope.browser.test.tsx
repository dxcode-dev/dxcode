// Render-scope regression for the phone drawer: opening it again slides in
// the sidebar it already built instead of mounting every row anew.

import type { UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const sidebar = vi.hoisted(() => ({ mounts: 0 }));

vi.mock("../../shared/use-mobile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/use-mobile.js")>()),
  useMobile: () => true,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Outlet: () => <p>Page</p>,
  useNavigate: () => () => undefined,
}));
vi.mock("./app-sidebar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app-sidebar.js")>()),
  AppSidebar: ({
    collapseLabel,
    onCollapse,
  }: {
    collapseLabel: string;
    onCollapse: () => void;
  }) => {
    React.useState(() => {
      sidebar.mounts += 1;
    });
    return (
      <nav data-testid="app-sidebar">
        <button type="button" aria-label={collapseLabel} onClick={onCollapse} />
      </nav>
    );
  },
}));

import { AuthContext } from "../../shared/auth/auth-context.js";
import { createQueryClient } from "../../shared/query/query-client.js";
import { projectKeys } from "../projects/project-queries.js";
import { personalAccountQueryOptions } from "../settings/account/personal-account-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { threadKeys } from "../threads/thread-queries.js";
import { ProductShell } from "./product-shell.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const userId = "usr_drawer" as UserId;
let root: Root | undefined;

afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  sidebar.mounts = 0;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const mountShell = async () => {
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
  const client = createQueryClient();
  const empty = { pages: [{ items: [] }], pageParams: [undefined] };
  client.setQueryData(projectKeys.lists(userId), empty);
  client.setQueryData(threadKeys.list(userId, undefined, "active", "roots"), {
    pages: [{ items: [{ id: "thr_1" }] }],
    pageParams: [undefined],
  });
  client.setQueryData(personalAccountQueryOptions(userId).queryKey, {
    displayName: "Test",
    email: "t@dx.test",
  } as never);
  client.setQueryData(settingsContextQueryOptions(userId).queryKey, {
    activeScope: "personal",
  } as never);
  client.setQueryData(threadKeys.shared(userId), []);
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
  return container;
};

const settle = () =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, 50)));
const drawerShown = () =>
  document.querySelector(".mobile-sidebar-drawer:not([hidden])") !== null;

it("opens the phone drawer again without mounting the sidebar again", async () => {
  const container = await mountShell();
  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-label="Open sidebar"]',
  );
  if (trigger === null) throw new Error("Expected the sidebar trigger.");
  // A phone opens on the page itself.
  expect(drawerShown()).toBe(false);
  expect(sidebar.mounts).toBe(0);

  for (let open = 0; open < 3; open++) {
    await React.act(() => trigger.click());
    await settle();
    expect(drawerShown()).toBe(true);
    await React.act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Close sidebar"]')
        ?.click(),
    );
    await settle();
    expect(drawerShown()).toBe(false);
  }

  expect(sidebar.mounts).toBe(1);
});
