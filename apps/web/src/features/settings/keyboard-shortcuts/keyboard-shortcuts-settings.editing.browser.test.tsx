import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CommandRegistry,
  createCommandRegistry,
} from "../../../shared/commands/command-registry.js";
import { KeyboardShortcutsSettings } from "./keyboard-shortcuts-settings.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const bindingFor = (label: string) => {
  const binding = [...document.querySelectorAll<HTMLElement>(".settings-row")]
    .find((row) => row.querySelector("strong")?.textContent === label)
    ?.querySelector<HTMLElement>(".shortcut-binding");
  if (binding === undefined || binding === null)
    throw new Error(`Missing row for ${label}`);
  return binding;
};

const keycapsOf = (binding: Element) =>
  [...binding.querySelectorAll("kbd")].map((kbd) => kbd.textContent);

const buttonByLabel = (label: string) => {
  const button = document.querySelector<HTMLButtonElement>(
    `button[aria-label='${label}']`,
  );
  if (button === null) throw new Error(`Missing button ${label}`);
  return button;
};

const buttonByText = (text: string) => {
  const button = [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim().startsWith(text),
  );
  if (button === undefined) throw new Error(`Missing button ${text}`);
  return button;
};

const press = (registry: CommandRegistry, init: KeyboardEventInit) =>
  registry.recordKeyboardEvent(
    new KeyboardEvent("keydown", { cancelable: true, ...init }),
  );

describe("KeyboardShortcutsSettings editing", () => {
  let container: HTMLDivElement;
  let root: Root;
  let registry: CommandRegistry;
  let showAll: () => void;

  const mount = async () => {
    await React.act(() =>
      root.render(
        <KeyboardShortcutsSettings
          registry={registry}
          onShowAll={showAll}
          showAllKeycaps={["?"]}
        />,
      ),
    );
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    registry = createCommandRegistry({ platform: "linux" });
    showAll = vi.fn();
  });

  afterEach(async () => {
    await React.act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("records g g for home, replaces the chord, and saves without navigating", async () => {
    await mount();
    await React.act(() => buttonByLabel("Edit Go to home screen").click());
    expect(registry.getActiveRecording()).toMatchObject({
      commandId: "navigation.home",
    });
    expect(document.body.textContent).toContain("Recording…");

    await React.act(() => press(registry, { key: "g" }));
    expect(
      [...document.querySelectorAll(".shortcut-editor kbd")].map(
        (kbd) => kbd.textContent,
      ),
    ).toEqual(["G"]);
    await React.act(() => press(registry, { key: "g" }));
    expect(registry.getActiveRecording()).toBeNull();
    expect(
      [...document.querySelectorAll(".shortcut-editor kbd")].map(
        (kbd) => kbd.textContent,
      ),
    ).toEqual(["G", "G"]);

    await React.act(() => buttonByText("Save shortcut").click());
    // Re-recording the default chord restores the default (no override).
    expect(registry.getSnapshot().overrides).toEqual({});
    expect(keycapsOf(bindingFor("Go to home screen"))).toEqual(["G", "G"]);
    expect(document.body.textContent).toContain(
      "Shortcut saved and active on this device.",
    );
  });

  it("records a different chord, persists it, and resets to the default", async () => {
    await mount();
    await React.act(() => buttonByLabel("Edit Go to home screen").click());
    await React.act(() => press(registry, { key: "g" }));
    await React.act(() => press(registry, { key: "h" }));
    await React.act(() => buttonByText("Save shortcut").click());
    expect(registry.getSnapshot().overrides).toEqual({
      "navigation.home": { sequence: ["G", "H"] },
    });
    expect(keycapsOf(bindingFor("Go to home screen"))).toEqual(["G", "H"]);

    await React.act(() => buttonByLabel("Reset Go to home screen").click());
    expect(registry.getSnapshot().overrides).toEqual({});
    expect(keycapsOf(bindingFor("Go to home screen"))).toEqual(["G", "G"]);
  });

  it("clears and restores the home chord with the row controls", async () => {
    await mount();
    const clear = buttonByLabel("Clear Go to home screen");
    expect(clear.disabled).toBe(false);
    await React.act(() => clear.click());
    expect(registry.getSnapshot().overrides).toEqual({
      "navigation.home": null,
    });
    expect(bindingFor("Go to home screen").textContent).toContain("Not set");

    await React.act(() => buttonByLabel("Reset Go to home screen").click());
    expect(registry.getSnapshot().overrides).toEqual({});
    expect(keycapsOf(bindingFor("Go to home screen"))).toEqual(["G", "G"]);
  });

  it("edits a single-chord command and surfaces validation conflicts", async () => {
    await mount();
    await React.act(() => buttonByLabel("Edit Open projects").click());
    await React.act(() =>
      press(registry, { key: "o", ctrlKey: true, shiftKey: true }),
    );
    expect(
      [...document.querySelectorAll(".shortcut-editor kbd")].map(
        (kbd) => kbd.textContent,
      ),
    ).toEqual(["Ctrl", "Shift", "O"]);
    await React.act(() => buttonByText("Save shortcut").click());
    expect(registry.getBinding("navigation.projects")).toBe("Mod+Shift+O");

    // Recording the palette's live default surfaces the conflict before save.
    await React.act(() => buttonByLabel("Edit Open projects").click());
    await React.act(() => press(registry, { key: "k", ctrlKey: true }));
    expect(
      document.querySelector(".shortcut-validation-error")?.textContent,
    ).toContain("conflicts with “Open command palette”");
    expect(buttonByText("Save shortcut").disabled).toBe(true);
    await React.act(() => buttonByText("Cancel").click());
    expect(registry.getActiveRecording()).toBeNull();
    expect(registry.getBinding("navigation.projects")).toBe("Mod+Shift+O");
  });

  it("ends the recording session when the screen unmounts", async () => {
    await mount();
    await React.act(() => buttonByLabel("Edit Go to home screen").click());
    expect(registry.getActiveRecording()).not.toBeNull();
    await React.act(() => root.unmount());
    expect(registry.getActiveRecording()).toBeNull();
  });

  it("opens the keymap from Show All and resets every override from Reset All", async () => {
    await mount();
    await React.act(() => buttonByText("Show All Keyboard Shortcuts").click());
    expect(showAll).toHaveBeenCalledTimes(1);

    const resetAll = buttonByText("Reset All Shortcuts");
    expect(resetAll.disabled).toBe(true);
    expect(document.querySelector("button[aria-label^='Reset ']")).toBeNull();

    await React.act(() => buttonByLabel("Clear Go to home screen").click());
    await React.act(() => buttonByLabel("Edit Open projects").click());
    await React.act(() =>
      press(registry, { key: "o", ctrlKey: true, shiftKey: true }),
    );
    await React.act(() => buttonByText("Save shortcut").click());
    expect(Object.keys(registry.getSnapshot().overrides).sort()).toEqual([
      "navigation.home",
      "navigation.projects",
    ]);
    expect(resetAll.disabled).toBe(false);

    await React.act(() => resetAll.click());
    expect(registry.getSnapshot().overrides).toEqual({});
    expect(keycapsOf(bindingFor("Go to home screen"))).toEqual(["G", "G"]);
    expect(bindingFor("Open projects").textContent).toContain("Not set");
    expect(resetAll.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "All keyboard shortcuts restored to their defaults.",
    );
  });
});
