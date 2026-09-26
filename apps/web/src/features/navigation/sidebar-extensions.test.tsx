// @vitest-environment happy-dom

import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SidebarExtensionRegion,
  SidebarNewsCard,
  SidebarNewsStack,
  SidebarUpdateAction,
} from "./sidebar-extensions.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type HarnessState =
  | "empty"
  | "one-card"
  | "stacked"
  | "collapsed"
  | "update"
  | "combined";

const SidebarExtensionHarness = ({
  state,
  onNews = vi.fn(),
  onUpdate = vi.fn(),
}: {
  readonly state: HarnessState;
  readonly onNews?: () => void;
  readonly onUpdate?: () => void;
}) => {
  if (state === "empty") return <SidebarExtensionRegion />;

  const showCards = state !== "update";
  const showSecondCard = state === "stacked" || state === "combined";
  const showUpdate = state === "update" || state === "combined";

  return (
    <SidebarExtensionRegion>
      {showCards ? (
        <SidebarNewsStack collapsed={state === "collapsed"}>
          <SidebarNewsCard
            title="Resolved headline"
            description="Resolved news copy"
            onSelect={onNews}
          />
          {showSecondCard ? (
            <SidebarNewsCard
              title="A long headline that must remain inside the sidebar"
              description="Unbroken-content-must-wrap-rather-than-widen-the-navigation-panel"
            />
          ) : null}
        </SidebarNewsStack>
      ) : null}
      {showUpdate ? (
        <SidebarUpdateAction
          label="Reload to Update"
          shortcut="R"
          onSelect={onUpdate}
        />
      ) : null}
    </SidebarExtensionRegion>
  );
};

describe("sidebar extension presentation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await React.act(() => root.unmount());
    container.remove();
  });

  const renderState = async (state: HarnessState, callbacks = {}) => {
    await React.act(() =>
      root.render(<SidebarExtensionHarness state={state} {...callbacks} />),
    );
  };

  it("renders no wrapper or production gap when empty", async () => {
    await renderState("empty");

    expect(container.innerHTML).toBe("");
  });

  it("supports one, stacked, and collapsed card states", async () => {
    await renderState("one-card");
    expect(container.querySelectorAll(".sidebar-news-card")).toHaveLength(1);

    await renderState("stacked");
    expect(container.querySelectorAll(".sidebar-news-card")).toHaveLength(2);
    expect(container.textContent).toContain(
      "Unbroken-content-must-wrap-rather-than-widen-the-navigation-panel",
    );

    await renderState("collapsed");
    expect(container.querySelector(".sidebar-extension-region")).not.toBeNull();
    expect(container.querySelector(".sidebar-news-stack")).toBeNull();
  });

  it("mounts news and update actions independently or together", async () => {
    const onNews = vi.fn();
    const onUpdate = vi.fn();
    await renderState("combined", { onNews, onUpdate });

    const news =
      container.querySelector<HTMLButtonElement>(".sidebar-news-card");
    const update = container.querySelector<HTMLButtonElement>(
      ".sidebar-update-action",
    );
    expect(news?.textContent).toContain("Resolved headline");
    expect(update?.textContent).toContain("Reload to Update");
    expect(update?.querySelector("kbd")?.textContent).toBe("R");

    await React.act(() => news?.click());
    await React.act(() => update?.click());
    expect(onNews).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledOnce();

    await renderState("update", { onUpdate });
    expect(container.querySelector(".sidebar-news-card")).toBeNull();
    expect(container.querySelector(".sidebar-update-action")).not.toBeNull();
  });
});
