// A collapsed desktop sidebar is 0 px wide. Keyboard and screen-reader users
// must not reach its controls, and toggling it must leave focus on a control
// they can see (#1142).

import type { UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { cdp, userEvent } from "vitest/browser";

vi.mock("../../shared/use-mobile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/use-mobile.js")>()),
  useMobile: () => false,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Outlet: () => <button type="button">Page action</button>,
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
      <a href="#thr_1">First Thread</a>
      <a href="#thr_2">Second Thread</a>
    </nav>
  ),
}));

import { AuthContext } from "../../shared/auth/auth-context.js";
import { createQueryClient } from "../../shared/query/query-client.js";
import { projectKeys } from "../projects/project-queries.js";
import { personalAccountQueryOptions } from "../settings/account/personal-account-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { threadKeys } from "../threads/thread-queries.js";
import { ProductShell } from "./product-shell.js";

const userId = "usr_collapsed" as UserId;
let root: Root | undefined;

afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
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
  // Tab order checks start from this button, above the shell.
  const start = document.body.appendChild(document.createElement("button"));
  start.textContent = "Start";
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
  await settle();
};

// The collapse and expand animations run for 200 ms.
const settle = () =>
  React.act(() => new Promise((resolve) => setTimeout(resolve, 400)));

const sidebarNav = () => {
  const nav = document.querySelector<HTMLElement>("nav.product-sidebar");
  if (nav === null) throw new Error("Expected the sidebar.");
  return nav;
};
const button = (name: string) => {
  const found = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${name}"]`,
  );
  if (found === null) throw new Error(`Expected the ${name} button.`);
  return found;
};

type FrameTree = {
  frame: { id: string };
  childFrames?: FrameTree[];
};

/** Names of the unignored nodes in Chromium's accessibility tree. */
const accessibleNames = async () => {
  // The test renders in Vitest's iframe, not the top frame.
  const { frameTree } = (await cdp().send("Page.getFrameTree")) as {
    frameTree: FrameTree;
  };
  const frameId = frameTree.childFrames?.[0]?.frame.id;
  const { nodes } = (await cdp().send("Accessibility.getFullAXTree", {
    frameId,
  })) as {
    nodes: { ignored: boolean; name?: { value?: string } }[];
  };
  return nodes
    .filter((node) => !node.ignored)
    .map((node) => node.name?.value ?? "")
    .filter((name) => name !== "");
};

/** What Tab reaches, starting from the top of the document. */
const tabStops = async (count: number) => {
  document.querySelector<HTMLButtonElement>("body > button")?.focus();
  const stops: string[] = [];
  for (let step = 0; step < count; step++) {
    await userEvent.tab();
    const active = document.activeElement as HTMLElement | null;
    stops.push(
      `${active?.getAttribute("aria-label") ?? active?.textContent ?? ""}${
        active !== null && sidebarNav().contains(active) ? " (sidebar)" : ""
      }`,
    );
  }
  return stops;
};

it("keeps a collapsed sidebar out of the Tab order and accessibility tree", async () => {
  await mountShell();
  expect(await tabStops(3)).toEqual([
    "Collapse sidebar (sidebar)",
    "First Thread (sidebar)",
    "Second Thread (sidebar)",
  ]);
  expect(await accessibleNames()).toEqual(
    expect.arrayContaining(["Collapse sidebar", "First Thread"]),
  );

  await userEvent.click(button("Collapse sidebar"));
  await settle();

  // Focus moves from the hidden collapse button to the visible open button.
  expect(document.activeElement).toBe(button("Open sidebar"));
  expect(await tabStops(3)).toEqual([
    "Resize navigation",
    "Open sidebar",
    "Page action",
  ]);
  const collapsedNames = await accessibleNames();
  expect(collapsedNames).toContain("Open sidebar");
  expect(collapsedNames).not.toContain("Collapse sidebar");
  expect(collapsedNames).not.toContain("First Thread");
});

it("lets Mod+B focus a sidebar row on the frame after it opens the sidebar", async () => {
  await mountShell();
  await userEvent.click(button("Collapse sidebar"));
  await settle();

  // toggleAndFocusSidebar clicks the open button with focus elsewhere, then
  // focuses a sidebar row on the next animation frame.
  document
    .querySelector<HTMLButtonElement>("main button:not([aria-label])")
    ?.focus();
  // Outside act, so React schedules the update as it does in the app.
  button("Open sidebar").click();
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('a[href="#thr_1"]')?.focus();
      resolve();
    }),
  );

  expect(document.activeElement?.textContent).toBe("First Thread");
});

it("moves focus into the sidebar when the keyboard expands it", async () => {
  await mountShell();
  await userEvent.click(button("Collapse sidebar"));
  await settle();

  button("Open sidebar").focus();
  await userEvent.keyboard("{Enter}");
  await settle();

  expect(document.querySelector('button[aria-label="Open sidebar"]')).toBe(
    null,
  );
  expect(document.activeElement).toBe(button("Collapse sidebar"));
  expect(await tabStops(2)).toEqual([
    "Collapse sidebar (sidebar)",
    "First Thread (sidebar)",
  ]);
});
