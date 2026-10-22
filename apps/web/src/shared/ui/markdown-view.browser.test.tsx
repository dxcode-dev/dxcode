// A view is an iframe: mounting it again reloads its document, runs its
// scripts again, and replays its entrance animation. These tests lock when a
// view's frame is created, and that streaming text around it never rebuilds
// it.

import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RichMarkdown } from "./rich-markdown.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  document.body.replaceChildren();
});

const mount = () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(() => React.act(() => root.unmount()));
  const render = (text: string, streaming: boolean) =>
    React.act(() =>
      root.render(<RichMarkdown streaming={streaming}>{text}</RichMarkdown>),
    );
  return { container, render };
};

const frames = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll<HTMLIFrameElement>(".markdown-view-frame"),
  );

/**
 * Waits for the lazily loaded kit, then for the view inside the frame to
 * report its height, which it does once its document has run.
 */
const loadedFrame = async (container: HTMLElement) => {
  await expect.poll(() => frames(container).length).toBe(1);
  const [frame] = frames(container);
  await expect
    .poll(
      () =>
        frame === undefined
          ? ""
          : getComputedStyle(frame).getPropertyValue("--view-height"),
      {
        timeout: 10_000,
      },
    )
    .not.toBe("");
  // The view reports its height while it loads; the frame's own load event
  // follows once the view finishes.
  await new Promise((done) => setTimeout(done, 500));
  return frame as HTMLIFrameElement;
};

const view =
  '<p class="ui-title">Views stay mounted</p><div id="chart"></div>' +
  "<script>{ ui.line(document.getElementById('chart'), { x: ['a', 'b', 'c'], series: [{ name: 'S', values: [1, 3, 2] }] }) }</script>";
const intro = "Here is the chart:\n\n";
const fence = `\`\`\`dx-view\n${view}\n\`\`\`\n\n`;
const after = "Most of the growth came from existing users. ";

describe("dx-view frames", { timeout: 30_000 }, () => {
  it("creates no frame while the view's fence is open", async () => {
    const { container, render } = mount();
    let text = `${intro}\`\`\`dx-view\n`;
    for (const chunk of view.match(/.{1,40}/gs) ?? []) {
      text += chunk;
      await render(text, true);
      expect(frames(container)).toHaveLength(0);
    }
    expect(container.querySelector(".markdown-view-drawing")).not.toBeNull();
  });

  it("keeps one frame from the fence's close through the finished reply", async () => {
    const { container, render } = mount();
    let text = intro + fence;
    await render(text, true);
    const frame = await loadedFrame(container);
    let loads = 0;
    frame.addEventListener("load", () => loads++);

    // The reply streams on after the view, then finishes.
    for (let i = 0; i < 20; i++) {
      text += after;
      await render(text, true);
    }
    await render(text, false);
    await new Promise((done) => setTimeout(done, 300));

    expect(frames(container)).toEqual([frame]);
    expect(frame.isConnected).toBe(true);
    expect(loads).toBe(0);
  });

  it("keeps the frame when its reply moves to another parent", async () => {
    // A finished turn moves its reply from the work list to the answer.
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(() => React.act(() => root.unmount()));
    const text = `${intro}${fence}${after}`;
    await React.act(() =>
      root.render(
        <ol key="work">
          <li>
            <RichMarkdown streaming>{text}</RichMarkdown>
          </li>
        </ol>,
      ),
    );
    const frame = await loadedFrame(container);
    let loads = 0;
    frame.addEventListener("load", () => loads++);
    await React.act(() =>
      root.render(
        <section key="answer">
          <RichMarkdown>{text}</RichMarkdown>
        </section>,
      ),
    );
    await new Promise((done) => setTimeout(done, 300));
    expect(frames(container)).toEqual([frame]);
    expect(frame.closest("section")).not.toBeNull();
    expect(loads).toBe(0);
  });

  it("does not rebuild a settled reply's view when it renders again", async () => {
    const { container, render } = mount();
    const text = `${intro}${fence}${after}`;
    await render(text, false);
    const frame = await loadedFrame(container);
    let loads = 0;
    frame.addEventListener("load", () => loads++);
    await render(text, false);
    await render(text, false);
    await new Promise((done) => setTimeout(done, 300));
    expect(frames(container)).toEqual([frame]);
    expect(loads).toBe(0);
  });
});
