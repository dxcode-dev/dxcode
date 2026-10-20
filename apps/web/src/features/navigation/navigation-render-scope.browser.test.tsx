// Render-scope regressions for navigation: moving between pages must not
// re-render the command surface or the account menu, and their settings links
// must still return to the page the person left.

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import {
  CommandProvider,
  useCommandPaletteSurface,
} from "../../shared/commands/command-provider.js";
import { createCommandRegistry } from "../../shared/commands/command-registry.js";
import { settingsReturnToFromState } from "../../shared/navigation/settings-return.js";
import { SidebarAccountMenu } from "./sidebar-account-menu.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const renders = { surface: 0, account: 0 };
const countAccountRender = () => {
  renders.account += 1;
};

const SurfaceReader = React.memo(function SurfaceReader() {
  const surface = useCommandPaletteSurface();
  renders.surface += 1;
  return (
    <button type="button" onClick={surface.openPalette}>
      {surface.paletteLabel}
    </button>
  );
});
const AccountMenu = React.memo(SidebarAccountMenu);
const noop = () => {};

const createTestRouter = () => {
  const registry = createCommandRegistry({ platform: "mac" });
  const rootRoute = createRootRoute({
    component: () => (
      <CommandProvider registry={registry}>
        <SurfaceReader />
        <React.Profiler id="account" onRender={countAccountRender}>
          <AccountMenu onNavigate={noop} />
        </React.Profiler>
        <Outlet />
      </CommandProvider>
    ),
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/threads/$threadId",
    component: () => <p>Thread</p>,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => <p>Settings</p>,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([threadRoute, settingsRoute]),
    history: createMemoryHistory({ initialEntries: ["/threads/a"] }),
  });
};

let root: Root | undefined;

const mount = async () => {
  const router = createTestRouter();
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await React.act(async () => {
    await router.load();
    root?.render(<RouterProvider router={router} />);
  });
  renders.surface = 0;
  renders.account = 0;
  return router;
};

const openThread = (router: ReturnType<typeof createTestRouter>, id: string) =>
  React.act(() =>
    router.navigate({ to: "/threads/$threadId", params: { threadId: id } }),
  );

afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

it("re-renders neither command surface readers nor the account menu when switching threads", async () => {
  const router = await mount();

  for (const id of ["b", "c", "d"]) await openThread(router, id);

  expect(router.state.location.pathname).toBe("/threads/d");
  expect(renders).toEqual({ surface: 0, account: 0 });
});

it("keeps command surface readers still while the command palette opens", async () => {
  await mount();

  await React.act(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "o",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );

  expect(document.querySelector("[role='dialog']")).not.toBeNull();
  expect(renders).toEqual({ surface: 0, account: 0 });
});

it("returns from a settings shortcut to the thread opened after mounting", async () => {
  const router = await mount();
  await openThread(router, "b");

  await React.act(async () => {
    const resolved = new Promise<void>((resolve) => {
      const unsubscribe = router.subscribe("onResolved", () => {
        unsubscribe();
        resolve();
      });
    });
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: ",",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await resolved;
  });

  expect(router.state.location.pathname).toBe("/settings");
  expect(settingsReturnToFromState(router.state.location.state)).toBe(
    "/threads/b",
  );
});
