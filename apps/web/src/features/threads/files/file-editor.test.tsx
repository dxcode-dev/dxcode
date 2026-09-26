// @vitest-environment happy-dom
import type { FileProps } from "@pierre/diffs/react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ThemeProvider } from "../../../shared/theme/theme-provider.js";
import type { Appearance } from "../../../shared/theme/theme-store.js";

let props: FileProps<undefined, undefined>;
vi.mock("@pierre/diffs/edit", () => ({ Editor: vi.fn() }));
vi.mock("@pierre/diffs/react", () => ({
  EditProvider: ({ children }: React.PropsWithChildren) => children,
  File: (value: FileProps<undefined, undefined>) => {
    props = value;
    return null;
  },
}));

import { ThreadFileEditor } from "./file-editor.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("keeps Pierre's external file stable while updating theme, wrap, and change callbacks", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const ready = vi.fn();
  const first = vi.fn(),
    next = vi.fn();
  const render = (
    content: string,
    wrap: boolean,
    onChange: (content: string) => void,
    appearance: Appearance = "dark",
  ) =>
    root.render(
      <ThemeProvider
        appearance={appearance}
        palette="daydream"
        onAppearanceChange={() => undefined}
        onPaletteChange={() => undefined}
      >
        <ThreadFileEditor
          path="proof.py"
          content={content}
          wrap={wrap}
          onChange={onChange}
          onReadyChange={ready}
        />
      </ThemeProvider>,
    );
  try {
    await React.act(() => render("answer = 42\n", false, first));
    const initial = props.file;
    expect(initial).toEqual({ name: "proof.py", contents: "answer = 42\n" });
    expect(props.edit).toBe(true);
    expect(props.editStateKey).toBeUndefined();
    await React.act(() => {
      render("answer = 43\n", true, next, "light");
    });
    expect(props.file).toBe(initial);
    expect(props.options).toMatchObject({
      theme: "pierre-light",
      themeType: "light",
      overflow: "wrap",
    });
    props.onEditChange?.({
      file: { name: "proof.py", contents: "answer = 44\n" },
    } as never);
    expect(next).toHaveBeenCalledWith("answer = 44\n");
    expect(first).not.toHaveBeenCalled();
    const node = document.createElement("div");
    const shadow = node.attachShadow({ mode: "open" });
    props.options?.onPostRender?.(node, {} as never, "render" as never);
    expect(ready).toHaveBeenLastCalledWith(false);
    const input = document.createElement("div");
    input.setAttribute("contenteditable", "true");
    shadow.append(input);
    props.options?.onPostRender?.(node, {} as never, "render" as never);
    expect(ready).toHaveBeenLastCalledWith(true);
    input.remove();
    props.options?.onPostRender?.(node, {} as never, "render" as never);
    expect(ready).toHaveBeenLastCalledWith(false);
  } finally {
    await React.act(() => root.unmount());
    container.remove();
  }
});
