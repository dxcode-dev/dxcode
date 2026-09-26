// @vitest-environment happy-dom

import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { CommandProvider } from "./command-provider.js";
import { createCommandRegistry } from "./command-registry.js";

const navigation = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigation.navigate,
  useLocation: ({
    select,
  }: {
    readonly select: (location: {
      readonly href: string;
      readonly pathname: string;
    }) => unknown;
  }) =>
    select({
      href: window.location.pathname,
      pathname: window.location.pathname,
    }),
}));
vi.mock("./command-palette.js", () => ({ CommandPalette: () => null }));
vi.mock("./keymap-dialog.js", () => ({
  KeymapDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="keymap-open" /> : null,
}));

let root: Root | undefined;

async function mount(path = "/") {
  window.history.replaceState(null, "", path);
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <CommandProvider registry={createCommandRegistry({ platform: "mac" })}>
        <aside data-command-surface="sidebar">
          <button
            type="button"
            aria-label="Open sidebar"
            data-command-action="toggle-sidebar"
          >
            Open
          </button>
          <a href="/threads/one" data-command-sidebar-item className="selected">
            One
          </a>
          <a href="/threads/two" data-command-sidebar-item>
            Two
          </a>
        </aside>
        <textarea data-command-target="thread-composer" />
        <input type="file" data-command-action="add-images" />
      </CommandProvider>,
    ),
  );
}

async function key(target: EventTarget, value: string, init = {}) {
  await React.act(() =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    ),
  );
}

afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  navigation.navigate.mockReset();
});

it("binds sidebar navigation and the thread file picker to mounted controls", async () => {
  await mount("/threads/one");
  const links = [
    ...document.querySelectorAll<HTMLElement>("[data-command-sidebar-item]"),
  ];
  const secondClick = vi
    .spyOn(links[1] as HTMLElement, "click")
    .mockImplementation(() => undefined);
  const fileInput = document.querySelector<HTMLInputElement>("[type='file']");
  if (fileInput === null) throw new Error("Missing file input fixture");
  const fileClick = vi.spyOn(fileInput, "click");

  await key(window, "ArrowDown");
  expect(document.activeElement).toBe(links[0]);
  await key(window, "j");
  expect(document.activeElement).toBe(links[1]);
  await key(window, "Enter");
  expect(secondClick).toHaveBeenCalledOnce();
  await key(window, "u", { metaKey: true });
  expect(fileClick).toHaveBeenCalledOnce();
});

it("opens workspace selection when no current workspace owns the command", async () => {
  await mount("/threads/one");
  await key(window, ",", { metaKey: true, altKey: true });
  expect(navigation.navigate).toHaveBeenCalledOnce();
  expect(navigation.navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      state: expect.any(Function),
      to: "/workspaces",
    }),
  );
});

it("toggles an open sidebar closed and a closed sidebar open with the platform modifier", async () => {
  await mount("/threads/one");
  const toggle = document.querySelector<HTMLButtonElement>(
    '[data-command-action="toggle-sidebar"]',
  );
  if (toggle === null) throw new Error("Missing sidebar toggle fixture");
  const click = vi.spyOn(toggle, "click");

  toggle.setAttribute("aria-label", "Collapse sidebar");
  await key(window, "b", { metaKey: true });
  expect(click).toHaveBeenCalledOnce();

  toggle.setAttribute("aria-label", "Open sidebar");
  await key(window, "b", { metaKey: true });
  expect(click).toHaveBeenCalledTimes(2);
});

it("anchors the focused Thread menu to its row instead of the viewport origin", async () => {
  await mount("/threads/one");
  const focused = document.querySelector<HTMLElement>(
    "[data-command-sidebar-item].selected",
  );
  if (focused === null) throw new Error("Missing focused Thread fixture");
  focused.dataset.commandFocused = "true";
  focused.focus();
  vi.spyOn(focused, "getBoundingClientRect").mockReturnValue({
    left: 24,
    right: 280,
    top: 100,
    bottom: 132,
    width: 256,
    height: 32,
    x: 24,
    y: 100,
    toJSON: () => ({}),
  });
  const position = vi.fn();
  focused.addEventListener("contextmenu", (event) =>
    position(event.clientX, event.clientY),
  );

  await key(window, "m");

  expect(position).toHaveBeenCalledExactlyOnceWith(272, 116);
});

it("keeps provider shortcuts inert while the user edits a nested textbox", async () => {
  await mount();
  const editor = document.body.appendChild(document.createElement("div"));
  editor.setAttribute("role", "textbox");
  const nested = editor.appendChild(document.createElement("span"));
  const questionMark = new KeyboardEvent("keydown", {
    key: "?",
    code: "Slash",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  await React.act(() => nested.dispatchEvent(questionMark));
  expect(questionMark.defaultPrevented).toBe(false);
  expect(document.querySelector('[data-testid="keymap-open"]')).toBeNull();
});

beforeAll(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterAll(() => vi.unstubAllGlobals());
