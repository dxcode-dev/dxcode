// @vitest-environment happy-dom

import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadDesktopLayout } from "./thread-desktop-layout.js";

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});

afterEach(() => document.body.replaceChildren());

const clickNamed = (container: Element, name: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  React.act(() =>
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
};

describe("Thread desktop Files activation", () => {
  it("does not mount Files on initial Thread render and preserves it after activation", async () => {
    const renderFilePanel = vi.fn();
    const FilesProbe = () => {
      renderFilePanel();
      return <div>Live workspace files</div>;
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <ThreadDesktopLayout
          rightPaneCollapsed={false}
          main={<div>Agent</div>}
          changes={<div>Durable changes</div>}
          files={<FilesProbe />}
        />,
      ),
    );
    expect(renderFilePanel).not.toHaveBeenCalled();

    clickNamed(container, "Files");
    expect(renderFilePanel).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Live workspace files");

    clickNamed(container, "Changes");
    expect(renderFilePanel).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector("#thread-files-panel")?.hasAttribute("hidden"),
    ).toBe(true);
    await React.act(() => root.unmount());
  });

  it("reports Files active only while its retained panel is visible", async () => {
    const activity: boolean[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <ThreadDesktopLayout
          rightPaneCollapsed={false}
          main={<div>Agent</div>}
          changes={<div>Durable changes</div>}
          files={(active) => {
            activity.push(active);
            return <div>Live workspace files</div>;
          }}
        />,
      ),
    );

    clickNamed(container, "Files");
    expect(activity.at(-1)).toBe(true);

    await React.act(() =>
      root.render(
        <ThreadDesktopLayout
          rightPaneCollapsed={true}
          main={<div>Agent</div>}
          changes={<div>Durable changes</div>}
          files={(active) => {
            activity.push(active);
            return <div>Live workspace files</div>;
          }}
        />,
      ),
    );
    expect(activity.at(-1)).toBe(false);

    clickNamed(container, "Changes");
    expect(activity.at(-1)).toBe(false);
    await React.act(() => root.unmount());
  });
});

describe("Thread desktop Terminal activation", () => {
  it("reports Terminal active only while its retained panel is visible", async () => {
    const activity: boolean[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <ThreadDesktopLayout
          rightPaneCollapsed={false}
          main={<div>Agent</div>}
          changes={<div>Durable changes</div>}
          terminal={(active) => {
            activity.push(active);
            return <div>Live terminal</div>;
          }}
        />,
      ),
    );

    clickNamed(container, "Terminal");
    expect(activity.at(-1)).toBe(true);

    await React.act(() =>
      root.render(
        <ThreadDesktopLayout
          rightPaneCollapsed={true}
          main={<div>Agent</div>}
          changes={<div>Durable changes</div>}
          terminal={(active) => {
            activity.push(active);
            return <div>Live terminal</div>;
          }}
        />,
      ),
    );
    expect(activity.at(-1)).toBe(false);

    clickNamed(container, "Changes");
    expect(activity.at(-1)).toBe(false);
    await React.act(() => root.unmount());
  });
});
