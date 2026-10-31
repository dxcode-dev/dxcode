// The desktop sidebar opens at 256 px for a person who never resized it
// (#1185), and keeps the width they dragged it to across a reload, as the
// Thread page's panes keep theirs (#1184). A collapsed sidebar stays
// collapsed across a reload. A reload here is a new query
// client and a new mount against the same fake server.

import type { UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

vi.mock("../../shared/use-mobile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/use-mobile.js")>()),
  useMobile: () => false,
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
  }) => (
    <nav className="product-sidebar" aria-label="Sidebar">
      <button
        type="button"
        aria-label={collapseLabel}
        data-command-action="toggle-sidebar"
        onClick={onCollapse}
      />
    </nav>
  ),
}));

import { AuthContext } from "../../shared/auth/auth-context.js";
import { createQueryClient } from "../../shared/query/query-client.js";
import { ProductShell } from "./product-shell.js";
import { ensureProductShellData } from "./sidebar-width.js";

const userId = "usr_sidebar_width" as UserId;
let root: Root | undefined;

afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** `/v1/sidebar-layout` backed by one saved layout; every other call hangs. */
const fakeServer = (initial: { width?: number; collapsed?: boolean } = {}) => {
  const saved: { entries: unknown[]; width?: number; collapsed?: boolean } = {
    entries: [],
    ...initial,
  };
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith("/v1/sidebar-layout"))
      return new Promise<Response>(() => {});
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as {
        kind: string;
        width?: number;
        collapsed?: boolean;
      };
      writes.push(body);
      if (body.kind === "width") saved.width = body.width;
      if (body.kind === "collapsed") saved.collapsed = body.collapsed;
    }
    return Response.json({ status: "success", data: saved });
  });
  return { saved, writes };
};

/** Loads the shell as the product route does, then mounts it. */
const load = async () => {
  await React.act(() => root?.unmount());
  document.body.replaceChildren();
  const client = createQueryClient();
  await ensureProductShellData(client, userId);
  const container = document.body.appendChild(document.createElement("div"));
  container.style.width = "1440px";
  container.style.height = "900px";
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
  await settle();
};

const settle = () =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, 300)));

const sidebarWidth = () => {
  const panel = document.querySelector<HTMLElement>(
    ".product-navigation-panel",
  );
  if (panel === null) throw new Error("Expected the sidebar panel.");
  return Math.round(panel.getBoundingClientRect().width);
};

const divider = () => {
  const found = document.querySelector<HTMLElement>(
    '[aria-label="Resize navigation"]',
  );
  if (found === null) throw new Error("Expected the resize handle.");
  return found;
};

it("opens at 256 px for a person who never resized the sidebar", async () => {
  const server = fakeServer();
  await load();

  expect(sidebarWidth()).toBe(256);
  // Showing the default is not a choice, so nothing is saved.
  expect(server.writes).toEqual([]);
});

it("keeps a resized sidebar width across a reload", async () => {
  const server = fakeServer();
  await load();

  divider().focus();
  await userEvent.keyboard("{End}");
  await settle();
  await userEvent.keyboard("{ArrowLeft}");
  await settle();
  const resized = sidebarWidth();
  expect(resized).toBeGreaterThan(256);
  expect(resized).toBeLessThan(480);
  expect(server.saved.width).toBe(resized);

  await load();

  expect(sidebarWidth()).toBe(resized);
});

it("opens at a saved width rather than the default", async () => {
  fakeServer({ width: 380 });
  await load();

  expect(sidebarWidth()).toBe(380);
});

it("does not save a collapsed sidebar as its width", async () => {
  const server = fakeServer({ width: 380 });
  await load();

  divider().focus();
  await userEvent.keyboard("{Home}");
  await settle();

  expect(server.saved.width).toBe(380);
});

it("opens at the default at once when the saved layout fails to load", async () => {
  let reads = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo) => {
    if (!String(input).endsWith("/v1/sidebar-layout"))
      return new Promise<Response>(() => {});
    reads += 1;
    return Response.json(
      {
        status: "error",
        data: { code: "PERSISTENCE_UNAVAILABLE", message: "Down." },
      },
      { status: 503 },
    );
  });
  const before = performance.now();
  await ensureProductShellData(createQueryClient(), userId);

  // One try, not the query's retry backoff, holds the page.
  expect(reads).toBe(1);
  expect(performance.now() - before).toBeLessThan(500);
  await load();
  expect(sidebarWidth()).toBe(256);
});

const button = (name: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

it("keeps a collapsed sidebar collapsed across a reload, and reopens it at its width", async () => {
  const server = fakeServer({ width: 380 });
  await load();

  await userEvent.click(button("Collapse sidebar") as HTMLButtonElement);
  await settle();
  expect(sidebarWidth()).toBe(0);
  expect(server.saved.collapsed).toBe(true);

  await load();

  expect(sidebarWidth()).toBe(0);
  expect(button("Open sidebar")).not.toBe(null);
  // Out of the Tab order and accessibility tree, as after a collapse.
  expect(
    document.getElementById("product-navigation")?.hasAttribute("inert"),
  ).toBe(true);

  await userEvent.click(button("Open sidebar") as HTMLButtonElement);
  await settle();
  expect(sidebarWidth()).toBe(380);
  expect(server.saved.collapsed).toBe(false);
  // Reopening is not a resize.
  expect(server.saved.width).toBe(380);

  await load();

  expect(sidebarWidth()).toBe(380);
});

it("opens a collapsed sidebar at the default width for a person who never resized it", async () => {
  fakeServer({ collapsed: true });
  await load();
  expect(sidebarWidth()).toBe(0);

  await userEvent.click(button("Open sidebar") as HTMLButtonElement);
  await settle();

  expect(sidebarWidth()).toBe(256);
});
