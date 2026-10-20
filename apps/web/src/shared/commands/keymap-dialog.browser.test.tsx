import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CommandView, createCommandRegistry } from "./command-registry.js";
import { KeymapDialog } from "./keymap-dialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useLocation: ({
    select,
  }: {
    readonly select: (location: {
      readonly href: string;
      readonly pathname: string;
    }) => unknown;
  }) => select({ href: "/projects", pathname: "/projects" }),
  useRouter: () => ({
    state: { location: { href: "/projects", pathname: "/projects" } },
  }),
}));

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
});
