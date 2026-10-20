import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandSurfaceDialog } from "./command-surface-dialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Harness() {
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

  it("traps focus, closes with Escape, and restores the opener", async () => {
    await React.act(() => root.render(<Harness />));
    const opener = container.querySelector<HTMLButtonElement>("button");
    opener?.focus();
    await React.act(() => opener?.click());

    // The dialog moves focus inside once it has opened.
    await React.act(() =>
      vi.waitFor(() =>
        expect(
          document
            .querySelector('[role="dialog"]')
            ?.contains(document.activeElement),
        ).toBe(true),
      ),
    );
    await React.act(() => press("Tab", true));
    expect(
      document
        .querySelector('[role="dialog"]')
        ?.contains(document.activeElement),
    ).toBe(true);
    await React.act(() => press("Escape"));
    // The dialog unmounts once its exit transition ends.
    await React.act(() =>
      vi.waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      ),
    );
    expect(document.activeElement).toBe(opener);
  });
});
