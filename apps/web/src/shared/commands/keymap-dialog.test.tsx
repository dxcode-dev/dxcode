// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CommandView, createCommandRegistry } from "./command-registry.js";
import { KeymapDialog } from "./keymap-dialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useLocation: ({
    select,
  }: {
    readonly select: (location: {
      readonly href: string;
      readonly pathname: string;
    }) => unknown;
  }) => select({ href: "/projects", pathname: "/projects" }),
}));

const styles = readFileSync(
  resolve(process.cwd(), "apps/web/src/styles.css"),
  "utf8",
);

const renderDialog = async (
  root: Root,
  commands: ReadonlyArray<CommandView>,
) => {
  await React.act(() =>
    root.render(
      <KeymapDialog open onOpenChange={vi.fn()} commands={commands} />,
    ),
  );
};

describe("KeymapDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await React.act(() => root.unmount());
    document.body.replaceChildren();
    navigate.mockReset();
  });

  it("renders only available commands that have effective shortcuts", async () => {
    const registry = createCommandRegistry({ platform: "mac" });
    const commands = registry.getCommands("app");
    await renderDialog(root, commands);

    const rows = [...document.querySelectorAll<HTMLElement>(".keymap-entry")];
    const expected = commands.filter(
      (command) => command.available && command.displayedBindings.length > 0,
    );
    expect(rows).toHaveLength(expected.length);
    expect(rows[0]?.textContent).toContain("Go to home screen");
    expect(rows[0]?.querySelectorAll("kbd")).toHaveLength(2);
    expect(rows[0]?.querySelectorAll("kbd")[0]?.textContent).toBe("G");
    expect(rows[0]?.querySelectorAll("kbd")[1]?.textContent).toBe("G");
    const palette = rows.find((row) =>
      row.textContent?.includes("Open command palette"),
    );
    expect(palette?.textContent).toContain("⌃Oor⌘K");
    expect(document.querySelector('[aria-disabled="true"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Not available in dx yet.");
    expect(document.body.textContent).not.toContain("Open projects");
    expect(document.querySelector(".keymap-edit-link svg")).not.toBeNull();
    expect(rows[0]?.textContent).not.toContain("or");
    expect(
      document
        .querySelector('[role="dialog"]')
        ?.getAttribute("aria-describedby"),
    ).toBeTruthy();
  });

  it("groups commands into Global, Sidebar, and Thread columns", async () => {
    const registry = createCommandRegistry({ platform: "mac" });
    await renderDialog(root, registry.getCommands("thread"));

    const categories = [...document.querySelectorAll(".keymap-category")].map(
      (heading) => heading.textContent,
    );
    expect(categories).toEqual(["Global", "Sidebar", "Thread"]);
    const sidebar = [
      ...document.querySelectorAll(".keymap-category-column"),
    ][1];
    expect(sidebar?.textContent).toContain("Toggle and focus sidebar");
    expect(sidebar?.textContent).toContain("Open focused thread menu");
    const thread = [...document.querySelectorAll(".keymap-category-column")][2];
    expect(thread?.textContent).toContain("Add images & files");
    expect(thread?.textContent).toContain("Focus message composer");
  });

  it("keeps keyboard-shortcuts-scoped commands out of Global", async () => {
    const registry = createCommandRegistry({ platform: "mac" });
    await renderDialog(root, registry.getCommands("keyboard-shortcuts"));

    const columns = [
      ...document.querySelectorAll<HTMLElement>(".keymap-category-column"),
    ];
    const settings = columns.find((column) =>
      column
        .querySelector(".keymap-category")
        ?.textContent?.includes("Keyboard shortcuts"),
    );
    expect(settings?.textContent).toContain("Focus shortcut search");
    expect(
      columns.find(
        (column) =>
          column.querySelector(".keymap-category")?.textContent === "Global",
      )?.textContent,
    ).not.toContain("Focus shortcut search");
  });

  it("shows effective configured bindings for supported commands", async () => {
    const registry = createCommandRegistry({ platform: "mac" });
    registry.setBinding("command-palette.open", "Mod+Shift+P");
    await renderDialog(root, registry.getCommands("app"));
    const palette = [...document.querySelectorAll(".keymap-entry")].find(
      (row) => row.textContent?.includes("Open command palette"),
    );
    expect(palette?.textContent).toContain("⌘⇧P");
    expect(palette?.textContent).not.toContain("⌃O");
  });

  it("shows a sequence override exactly like the settings row would", async () => {
    const registry = createCommandRegistry({ platform: "mac" });
    expect(registry.setSequence("navigation.home", ["g", "h"])).toMatchObject({
      ok: true,
    });
    await renderDialog(root, registry.getCommands("app"));
    const home = [...document.querySelectorAll(".keymap-entry")].find((row) =>
      row.textContent?.includes("Go to home screen"),
    );
    expect(home?.textContent).toContain("G");
    expect(home?.textContent).toContain("H");
    expect(home?.textContent).not.toContain("or");
  });

  it("codifies bounded overflow and one, two, and three-column layouts", () => {
    expect(styles).toMatch(
      /\.command-surface-dialog-keymap[\s\S]*?max-height: 80dvh/,
    );
    expect(styles).toMatch(/\.command-surface-content[\s\S]*?overflow: auto/);
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(styles).toMatch(/@media \(min-width: 640px\)[\s\S]*?repeat\(2/);
    expect(styles).toMatch(/@media \(min-width: 1024px\)[\s\S]*?repeat\(3/);
  });
});
