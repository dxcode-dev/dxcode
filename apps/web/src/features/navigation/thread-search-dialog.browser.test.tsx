import type { UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../shared/query/query-client.js";
import { ThreadSearchDialog } from "./thread-search-dialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const act = React.act;
const userId = "user-1" as UserId;

const item = (
  id: string,
  title: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  title,
  projectId: "prj-1",
  projectName: "Atlas",
  ownerUserId: "user-2",
  ownerName: "Ben Member",
  color: "auto",
  archived: false,
  pinned: false,
  visibility: "workspace",
  state: "idle",
  lastActivityAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  createdAt: "2026-10-01T00:00:00.000Z",
  ...extra,
});

/** The search route, answering by query. */
const searchRoute = vi.fn((query: string) => {
  if (query === "archived:maybe")
    return Response.json(
      {
        status: "error",
        data: {
          code: "INVALID_REQUEST",
          message: "archived: takes true or false.",
          requestId: "r",
        },
      },
      { status: 400 },
    );
  const items =
    query === "archived:false"
      ? [item("thr-1", "Recent work"), item("thr-2", "Older work")]
      : [
          item("thr-3", "Ledger migration", {
            matchedSearchText: "…moved the ledger to D1…",
            state: "working",
            visibility: "private",
          }),
        ];
  return Response.json({ status: "success", data: { items } });
});

const enterText = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, value);
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
};

/** Runs the debounce, then lets the response render. */
const settle = async () => {
  await act(async () => vi.advanceTimersByTimeAsync(300));
  await act(async () => vi.advanceTimersByTimeAsync(0));
};

describe("ThreadSearchDialog", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onOpenChange = vi.fn();
  const onSelectThread = vi.fn();

  const render = async () => {
    await act(() =>
      root.render(
        <QueryClientProvider client={createQueryClient()}>
          <ThreadSearchDialog
            open
            userId={userId}
            onOpenChange={onOpenChange}
            onSelectThread={onSelectThread}
          />
        </QueryClientProvider>,
      ),
    );
    await settle();
  };
  const combobox = () => {
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
    if (input === null) throw new Error("missing combobox");
    return input;
  };
  const queries = () =>
    searchRoute.mock.calls.map(([query]) => query as string);

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        searchRoute(
          new URL(path, "https://dx.test").searchParams.get("q") ?? "",
        ),
      ),
    );
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("lists recent Threads with nothing typed, and searches the server after typing pauses", async () => {
    await render();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(combobox().placeholder).toBe("Search workspace threads…");
    expect(combobox().getAttribute("aria-controls")).toBe(
      "thread-search-results",
    );
    expect(queries()).toEqual(["archived:false"]);
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);

    await act(() => enterText(combobox(), "led"));
    await act(() => enterText(combobox(), "ledger"));
    await settle();
    // One request for the paused text, none per keystroke.
    expect(queries()).toEqual(["archived:false", "ledger"]);
    const option = document.querySelector('[role="option"]');
    expect(option?.textContent).toContain("Ledger migration");
    expect(option?.textContent).toContain("Ben Member");
    expect(option?.textContent).toContain("2h ago");
    expect(option?.textContent).toContain("Private");
    expect(option?.textContent).toContain("Active");
    expect(option?.textContent).toContain("…moved the ledger to D1…");
    expect(option?.textContent).toContain("Atlas");
  });

  it("supports arrows, Home/End, Enter and selects exactly once", async () => {
    await render();
    await act(() =>
      combobox().dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      ),
    );
    expect(combobox().getAttribute("aria-activedescendant")).toBe(
      "thread-search-1",
    );
    await act(() =>
      combobox().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(onSelectThread).toHaveBeenCalledTimes(1);
    expect(onSelectThread).toHaveBeenCalledWith("thr-2");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("inserts filters from the chips and runs syntax examples", async () => {
    await render();
    const chip = [
      ...document.querySelectorAll<HTMLButtonElement>(".thread-search-filter"),
    ].find((button) => button.textContent === "project:");
    await act(() => chip?.click());
    expect(combobox().value).toBe("project:");
    expect(document.activeElement).toBe(combobox());

    const syntax = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Search Syntax",
    );
    await act(() => syntax?.click());
    expect(syntax?.getAttribute("aria-expanded")).toBe("true");
    const example = [
      ...document.querySelectorAll<HTMLButtonElement>(".thread-search-example"),
    ].find((button) => button.textContent?.includes("Inactive Threads"));
    await act(() => example?.click());
    await settle();
    expect(combobox().value).toBe("updated_before:7d");
    expect(queries().at(-1)).toBe("updated_before:7d");
    expect(document.querySelector(".thread-search-syntax")).toBeNull();
  });

  it("shows the server's message for an invalid filter", async () => {
    await render();
    await act(() => enterText(combobox(), "archived:maybe"));
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "archived: takes true or false.",
    );
  });
});
