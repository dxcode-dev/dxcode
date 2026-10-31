// Real key presses (Playwright, trusted events) against the app-level command
// listener. A focused control keeps the keys it handles itself: Enter
// activates a button or link, and a slider, tab, or menu keeps its arrows and
// letters. The sidebar commands still run from the sidebar rows.
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { focusSidebarCommandItem } from "../../features/navigation/sidebar-command-focus.js";
import { CommandProvider } from "./command-provider.js";
import { createCommandRegistry } from "./command-registry.js";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
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
vi.mock("./command-palette.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./command-palette.js")>()),
  CommandPalette: () => null,
}));
vi.mock("./keymap-dialog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./keymap-dialog.js")>()),
  KeymapDialog: () => null,
}));

let root: Root | undefined;
let events: string[] = [];
const record = (name: string) => () => events.push(name);

function Fixture() {
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const [dial, setDial] = React.useState(1);
  const row = (id: string) => (
    <a
      key={id}
      href={`/threads/${id}`}
      data-command-sidebar-item
      onFocus={(event) => focusSidebarCommandItem(event.currentTarget)}
      onClick={(event) => {
        event.preventDefault();
        events.push(`open ${id}`);
      }}
    >
      Thread {id}
    </a>
  );
  return (
    <>
      <button
        type="button"
        data-command-action="toggle-sidebar"
        aria-label={sidebarOpen ? "Collapse sidebar" : "Open sidebar"}
        onClick={() => {
          events.push(sidebarOpen ? "collapse" : "expand");
          setSidebarOpen(!sidebarOpen);
        }}
      >
        Sidebar
      </button>
      {sidebarOpen ? (
        <aside data-command-surface="sidebar">
          <button type="button" onClick={record("new thread")}>
            New thread
          </button>
          {row("one")}
          {row("two")}
        </aside>
      ) : null}
      <main>
        <button type="button" onClick={record("main button")}>
          Create project
        </button>
        <a
          href="/docs"
          onClick={(event) => {
            event.preventDefault();
            events.push("main link");
          }}
        >
          Docs
        </a>
        <div
          role="slider"
          tabIndex={0}
          aria-label="Dial"
          aria-valuenow={dial}
          aria-valuemin={0}
          aria-valuemax={5}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") setDial(dial + 1);
            if (event.key === "ArrowDown") setDial(dial - 1);
          }}
        />
        <div role="menu" aria-label="Actions">
          <div
            role="menuitem"
            tabIndex={-1}
            onKeyDown={(event) => events.push(`menu ${event.key}`)}
          >
            Move
          </div>
        </div>
      </main>
    </>
  );
}

async function mount() {
  events = [];
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <CommandProvider registry={createCommandRegistry({ platform: "linux" })}>
        <Fixture />
      </CommandProvider>,
    ),
  );
}

const press = (keys: string) =>
  React.act(async () => {
    await userEvent.keyboard(keys);
  });

const focus = (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`Missing ${selector}`);
  element.focus();
  return element;
};

afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

it("lets Enter activate the focused button or link while the sidebar is shown", async () => {
  await mount();
  // A row focused earlier keeps its command mark after focus moves on.
  focus("[data-command-sidebar-item]");
  expect(
    document.querySelector("[data-command-focused='true']"),
  ).not.toBeNull();

  focus("main button");
  await press("{Enter}");
  focus("main a");
  await press("{Enter}");
  focus("aside button");
  await press("{Enter}");
  focus("[aria-label='Collapse sidebar']");
  await press("{Enter}");

  expect(events).toEqual([
    "main button",
    "main link",
    "new thread",
    "collapse",
  ]);
});

it("leaves arrows to a focused slider and letters to a focused menu", async () => {
  await mount();
  const slider = focus("[role='slider']");
  await press("{ArrowUp}{ArrowUp}");
  expect(slider.getAttribute("aria-valuenow")).toBe("3");
  expect(document.activeElement).toBe(slider);

  focus("[role='menuitem']");
  await press("jkm");
  expect(events).toEqual(["menu j", "menu k", "menu m"]);
  expect(document.querySelector("[data-command-focused='true']")).toBeNull();
});

it("still moves through and opens sidebar rows, and toggles the sidebar with Ctrl+B", async () => {
  await mount();
  const rows = [
    ...document.querySelectorAll<HTMLElement>("[data-command-sidebar-item]"),
  ];

  await press("{ArrowDown}");
  expect(document.activeElement).toBe(rows[0]);
  await press("j");
  expect(document.activeElement).toBe(rows[1]);
  await press("{Enter}");
  await press("k{Enter}");
  expect(events).toEqual(["open two", "open one"]);

  focus("main button");
  await press("{Control>}b{/Control}");
  expect(document.querySelector("[data-command-surface='sidebar']")).toBeNull();
  await press("{Control>}b{/Control}");
  expect(
    document.querySelector("[data-command-surface='sidebar']"),
  ).not.toBeNull();
  expect(events).toEqual(["open two", "open one", "collapse", "expand"]);
});
