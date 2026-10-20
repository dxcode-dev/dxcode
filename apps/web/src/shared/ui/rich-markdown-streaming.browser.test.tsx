// Streaming a long fenced code block must cost linear time overall: each
// chunk may parse and highlight only a bounded part of the open fence. The
// work is counted where it happens, in react-markdown and highlight.js, and
// the finished output must equal a fresh render of the same text.

import HighlightJs from "highlight.js/lib/core";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const work = vi.hoisted(() => ({ parsed: 0, highlighted: 0 }));

vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  return {
    ...actual,
    default: (props: React.ComponentProps<typeof actual.default>) => {
      work.parsed += props.children?.length ?? 0;
      return React.createElement(actual.default, props);
    },
  };
});

// Every highlighter, including lowlight's, is a highlight.js instance.
const newInstance = HighlightJs.newInstance;
HighlightJs.newInstance = () => {
  const instance = newInstance();
  const highlight = instance.highlight;
  instance.highlight = ((code: string, options: never) => {
    work.highlighted += code.length;
    return highlight(code, options);
  }) as typeof instance.highlight;
  return instance;
};
const { RichMarkdown } = await import("./rich-markdown.js");

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

const intro = "Here is the new checkout module:\n\n```ts\n";
const line = (i: number) =>
  `export const step${i} = (cart: Cart) => applyDiscount(cart, ${i}) ?? cart;\n`;

/** Parse and highlight characters to stream `lines` lines, one per chunk. */
const streamOpenFence = async (lines: number) => {
  const { container, render } = mount();
  work.parsed = 0;
  work.highlighted = 0;
  let text = intro;
  for (let i = 0; i < lines; i++) {
    text += line(i);
    await render(text, true);
  }
  expect(container.querySelector("code.hljs.language-ts")?.textContent).toBe(
    text.slice(intro.length),
  );
  return work.parsed + work.highlighted;
};

const fresh = async (text: string) => {
  const { container, render } = mount();
  await render(text, false);
  return container;
};

// Each test streams hundreds of chunks through react-markdown and lowlight:
// under a second alone, several seconds when the full suite loads the CPU.
describe("streaming a fenced code block", { timeout: 30_000 }, () => {
  it("does linear, not quadratic, parse and highlight work", async () => {
    const short = await streamOpenFence(150);
    const long = await streamOpenFence(300);
    // Twice the lines: linear work doubles, quadratic work quadruples.
    expect(long / short).toBeLessThan(3);
  }, 60_000);

  it("stays highlighted while open and renders as before once settled", async () => {
    const { container, render } = mount();
    let text = intro;
    for (let i = 0; i < 120; i++) {
      text += line(i);
      await render(text, true);
    }
    expect(
      container.querySelectorAll("code.hljs.language-ts .hljs-keyword").length,
    ).toBeGreaterThanOrEqual(120);

    // The fence closes and its block settles while the reply streams on.
    text += "```\n\nRun `pnpm test`";
    await render(text, true);
    const settled = container.querySelector(".transcript-code-block");
    const parsed = (await fresh(text)).querySelector(".transcript-code-block");
    expect(settled?.outerHTML).toBe(parsed?.outerHTML);

    text += " to check it.\n";
    await render(text, false);
    expect(container.innerHTML).toBe((await fresh(text)).innerHTML);
  });

  it.each([
    ["no language", "```\n"],
    ["an unknown language", "```not-a-language\n"],
  ])("streams an open fence with %s as plain text", async (_, fence) => {
    const { container, render } = mount();
    const open = `Output:\n\n${fence}`;
    let text = open;
    for (let i = 0; i < 20; i++) {
      text += `line ${i}\n`;
      await render(text, true);
    }
    expect(container.querySelector("pre code")?.textContent).toBe(
      text.slice(open.length),
    );

    text += "```\n\nDone.\n";
    await render(text, false);
    expect(container.innerHTML).toBe((await fresh(text)).innerHTML);
  });
});
