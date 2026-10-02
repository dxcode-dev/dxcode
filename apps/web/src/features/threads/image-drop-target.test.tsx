// @vitest-environment happy-dom

import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useImageDropTarget } from "./image-drop-target.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const png = () =>
  new File(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    "dropped.png",
    { type: "image/png" },
  );

// Browsers expose file drags as the "Files" type; happy-dom does not.
const dispatchDrag = (
  target: Element,
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  data: {
    readonly types: ReadonlyArray<string>;
    readonly files?: ReadonlyArray<File>;
  },
  relatedTarget: EventTarget | null = null,
) => {
  const dataTransfer = {
    types: data.types,
    files: data.files ?? [],
    dropEffect: "none",
  };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    relatedTarget: { value: relatedTarget },
  });
  target.dispatchEvent(event);
  return { event, dataTransfer };
};

function Harness({
  disabled,
  onFiles,
}: {
  readonly disabled?: boolean;
  readonly onFiles: (files: ReadonlyArray<File>) => void;
}) {
  const dropTarget = useImageDropTarget({ disabled, onFiles });
  return (
    <form {...dropTarget}>
      <textarea aria-label="Prompt" />
      <span className="child">child</span>
    </form>
  );
}

const mount = async (props: React.ComponentProps<typeof Harness>) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await React.act(() => root.render(<Harness {...props} />));
  const form = container.querySelector("form");
  const textarea = container.querySelector("textarea");
  const child = container.querySelector(".child");
  if (form === null || textarea === null || child === null)
    throw new Error("Expected drop target.");
  return { root, form, textarea, child };
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("image drop target", () => {
  it("attaches files dropped anywhere in the composer, including the prompt", async () => {
    const onFiles = vi.fn();
    const { root, form, textarea } = await mount({ onFiles });
    const file = png();

    await React.act(() =>
      dispatchDrag(textarea, "dragenter", { types: ["Files"] }),
    );
    expect(form.dataset.fileDropActive).toBe("true");
    let over: ReturnType<typeof dispatchDrag> | undefined;
    await React.act(() => {
      over = dispatchDrag(textarea, "dragover", { types: ["Files"] });
    });
    expect(over?.event.defaultPrevented).toBe(true);
    expect(over?.dataTransfer.dropEffect).toBe("copy");

    let drop: ReturnType<typeof dispatchDrag> | undefined;
    await React.act(() => {
      drop = dispatchDrag(textarea, "drop", {
        types: ["Files"],
        files: [file],
      });
    });
    expect(drop?.event.defaultPrevented).toBe(true);
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([file]);
    expect(form.dataset.fileDropActive).toBeUndefined();
    await React.act(() => root.unmount());
  });

  it("keeps the indicator while moving between children and clears it on exit", async () => {
    const { root, form, textarea, child } = await mount({ onFiles: vi.fn() });
    // happy-dom 20 reports connected form descendants as uncontained.
    vi.spyOn(form, "contains").mockImplementation(
      (node) => node === textarea || node === child,
    );
    await React.act(() =>
      dispatchDrag(form, "dragenter", { types: ["Files"] }),
    );
    await React.act(() =>
      dispatchDrag(form, "dragleave", { types: ["Files"] }, textarea),
    );
    expect(form.dataset.fileDropActive).toBe("true");
    await React.act(() =>
      dispatchDrag(textarea, "dragleave", { types: ["Files"] }, child),
    );
    expect(form.dataset.fileDropActive).toBe("true");
    await React.act(() =>
      dispatchDrag(form, "dragleave", { types: ["Files"] }, document.body),
    );
    expect(form.dataset.fileDropActive).toBeUndefined();
    await React.act(() => root.unmount());
  });

  it("leaves text drags to the browser", async () => {
    const onFiles = vi.fn();
    const { root, form, textarea } = await mount({ onFiles });
    let over: ReturnType<typeof dispatchDrag> | undefined;
    let drop: ReturnType<typeof dispatchDrag> | undefined;
    await React.act(() => {
      dispatchDrag(textarea, "dragenter", { types: ["text/plain"] });
      over = dispatchDrag(textarea, "dragover", { types: ["text/plain"] });
      drop = dispatchDrag(textarea, "drop", { types: ["text/plain"] });
    });
    expect(over?.event.defaultPrevented).toBe(false);
    expect(drop?.event.defaultPrevented).toBe(false);
    expect(form.dataset.fileDropActive).toBeUndefined();
    expect(onFiles).not.toHaveBeenCalled();
    await React.act(() => root.unmount());
  });

  it("refuses drops while locked without letting the browser open the file", async () => {
    const onFiles = vi.fn();
    const { root, form, textarea } = await mount({ disabled: true, onFiles });
    let over: ReturnType<typeof dispatchDrag> | undefined;
    let drop: ReturnType<typeof dispatchDrag> | undefined;
    await React.act(() => {
      dispatchDrag(textarea, "dragenter", { types: ["Files"] });
      over = dispatchDrag(textarea, "dragover", { types: ["Files"] });
      drop = dispatchDrag(textarea, "drop", {
        types: ["Files"],
        files: [png()],
      });
    });
    expect(over?.dataTransfer.dropEffect).toBe("none");
    expect(drop?.event.defaultPrevented).toBe(true);
    expect(form.dataset.fileDropActive).toBeUndefined();
    expect(onFiles).not.toHaveBeenCalled();
    await React.act(() => root.unmount());
  });
});
