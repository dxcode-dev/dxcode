// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandSurfaceDialog } from "./command-surface-dialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const styles = readFileSync(
  resolve(process.cwd(), "apps/web/src/styles.css"),
  "utf8",
);

function Harness({ variant = "command" }: { variant?: "command" | "keymap" }) {
  const [open, setOpen] = React.useState(false);
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>
        Open surface
      </button>
      <a href="/background">Background link</a>
      <CommandSurfaceDialog
        open={open}
        onOpenChange={setOpen}
        title="Surface title"
        description="Surface description"
        leftHeaderAction={<button type="button">Left action</button>}
        rightHeaderAction={<button type="button">Right action</button>}
        primary={<input aria-label="Primary input" />}
        attachments={<div>Attachment</div>}
        footer={<button type="button">Footer action</button>}
        pending
        error="Surface error"
        variant={variant}
      >
        <button type="button">Result action</button>
      </CommandSurfaceDialog>
    </main>
  );
}

const press = (key: string, shiftKey = false) =>
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }),
  );

describe("CommandSurfaceDialog", () => {
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
  });

  it("renders every composable state with an accessible dialog name and status", async () => {
    await React.act(() => root.render(<Harness variant="keymap" />));
    const opener = container.querySelector<HTMLButtonElement>("button");
    await React.act(() => opener?.click());

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.classList).toContain("command-surface-dialog-keymap");
    expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog?.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")
        ?.textContent,
    ).toBe("Surface title");
    expect(
      document.getElementById(dialog?.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("Surface description");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Surface error",
    );
    expect(document.querySelector('[aria-busy="true"]')?.textContent).toContain(
      "Result action",
    );
    expect(document.body.textContent).toContain("Left action");
    expect(document.body.textContent).toContain("Right action");
    expect(document.body.textContent).toContain("Attachment");
    expect(document.body.textContent).toContain("Footer action");
    expect(
      document.querySelector(".modal-surface-header-action")?.textContent,
    ).toContain("Close");
  });

  it("traps focus, closes with Escape, and restores the opener", async () => {
    await React.act(() => root.render(<Harness />));
    const opener = container.querySelector<HTMLButtonElement>("button");
    opener?.focus();
    await React.act(() => opener?.click());

    expect(
      document
        .querySelector('[role="dialog"]')
        ?.contains(document.activeElement),
    ).toBe(true);
    await React.act(() => press("Tab", true));
    expect(
      document
        .querySelector('[role="dialog"]')
        ?.contains(document.activeElement),
    ).toBe(true);
    await React.act(() => press("Escape"));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes on the backdrop and leaves the background outside the modal", async () => {
    await React.act(() => root.render(<Harness />));
    const opener = container.querySelector<HTMLButtonElement>("button");
    await React.act(() => opener?.click());
    const backdrop = document.querySelector<HTMLElement>(
      ".modal-surface-backdrop",
    );
    expect(backdrop).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')?.contains(container)).toBe(
      false,
    );
    await React.act(() => backdrop?.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("codifies desktop, mobile, safe-area, layering, and reduced-motion presentation", () => {
    expect(styles).toMatch(
      /\.modal-surface-popup \{[^}]*width: min\(832px, 100%\);[^}]*overflow-y: auto;[^}]*background: var\(--surface\);[^}]*border-radius: 18px;/,
    );
    expect(styles).toMatch(
      /\.modal-surface-header \{[\s\S]*?justify-content: space-between;[\s\S]*?height: 48px;/,
    );
    expect(styles).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.modal-surface-popup \{[\s\S]*?height: auto;[\s\S]*?margin-top: 12\.5dvh;[\s\S]*?border-radius: 18px;/,
    );
    expect(styles).toMatch(
      /\.command-surface-dialog-keymap \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/,
    );
    expect(styles).toMatch(/\.modal-surface-backdrop[\s\S]*?z-index: 110;/);
    expect(styles).toMatch(/\.modal-surface-viewport[\s\S]*?z-index: 111;/);
    expect(styles).toMatch(/\.menu-positioner[\s\S]*?z-index: 80;/);
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition-duration: 0\.01ms;/,
    );
  });
});
