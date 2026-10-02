// @vitest-environment happy-dom

import type { ModeId } from "@dx/domain";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("./new-thread-configuration-strip.js", () => ({
  NewThreadConfigurationStrip: () => null,
}));

import { NewThreadComposer } from "./new-thread-composer.js";

const drag = (target: Element, type: string, files: ReadonlyArray<File>) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files, dropEffect: "none" },
  });
  target.dispatchEvent(event);
  return event;
};

const mount = async (submitting: boolean) => {
  const onFiles = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await React.act(() =>
    root.render(
      <NewThreadComposer
        prompt=""
        images={[]}
        textareaRef={React.createRef()}
        submitting={submitting}
        onPromptChange={vi.fn()}
        onSubmit={vi.fn()}
        onRemoveImage={vi.fn()}
        onFiles={onFiles}
        onScreenshot={vi.fn()}
        projects={[]}
        projectId=""
        onProjectChange={vi.fn()}
        onLoadMoreProjects={vi.fn()}
        runnerProfileLoading={false}
        onRunnerProfileChange={vi.fn()}
        profile={"medium" as ModeId}
        onProfileChange={vi.fn()}
        onModelChange={vi.fn()}
        dictationActive={false}
        dictationHideSubmit={false}
        footer={null}
      />,
    ),
  );
  const form = container.querySelector("form");
  const textarea = container.querySelector("textarea");
  if (form === null || textarea === null)
    throw new Error("Expected new-thread composer.");
  return { root, form, textarea, onFiles };
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("new-thread composer image drop", () => {
  it("routes images dropped on the prompt to the attachment handler", async () => {
    const { root, form, textarea, onFiles } = await mount(false);
    const file = new File(["png"], "dropped.png", { type: "image/png" });
    await React.act(() => {
      drag(textarea, "dragenter", [file]);
      drag(textarea, "dragover", [file]);
    });
    expect(form.className).toBe("new-thread-composer");
    expect(form.dataset.fileDropActive).toBe("true");
    let drop: Event | undefined;
    await React.act(() => {
      drop = drag(textarea, "drop", [file]);
    });
    expect(drop?.defaultPrevented).toBe(true);
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([file]);
    expect(form.dataset.fileDropActive).toBeUndefined();
    await React.act(() => root.unmount());
  });

  it("ignores drops while the thread is being created", async () => {
    const { root, form, textarea, onFiles } = await mount(true);
    const file = new File(["png"], "dropped.png", { type: "image/png" });
    await React.act(() => {
      drag(textarea, "dragenter", [file]);
      drag(textarea, "drop", [file]);
    });
    expect(form.dataset.fileDropActive).toBeUndefined();
    expect(onFiles).not.toHaveBeenCalled();
    await React.act(() => root.unmount());
  });
});
