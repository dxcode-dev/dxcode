// @vitest-environment happy-dom

import type {
  ThreadFileData,
  ThreadFilesPath,
  ThreadFileVersion,
} from "@dx/api";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const editorActions = vi.hoisted(() => ({
  openFind: vi.fn(),
}));

vi.mock("./file-editor.js", async () => {
  const ReactModule = await import("react");
  return {
    ThreadFileEditor: ReactModule.forwardRef(function MockFileEditor(
      {
        content,
        onChange,
        wrap,
        onReadyChange,
      }: {
        content: string;
        onChange: (value: string) => void;
        wrap: boolean;
        onReadyChange: (ready: boolean) => void;
      },
      ref,
    ) {
      ReactModule.useImperativeHandle(ref, () => editorActions, []);
      return (
        <textarea
          ref={(node) => onReadyChange(node !== null)}
          aria-label="Source editor"
          data-wrap={wrap}
          value={content}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );
    }),
  };
});

import { ThreadFileViewer } from "./file-viewer.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const path = "README.md" as ThreadFilesPath;
const version = `sha256:${"a".repeat(64)}` as ThreadFileVersion;
const editable: ThreadFileData = {
  kind: "file",
  path,
  editable: true,
  contentVersion: version,
  content: "# Original\n",
  sizeBytes: 11,
  language: "markdown",
  mediaType: "text/markdown",
};

afterEach(() => document.body.replaceChildren());

describe("Thread file viewer", () => {
  it("previews unsaved Markdown and saves the complete local buffer with its version", async () => {
    const onSave = vi.fn();
    const onDirtyChange = vi.fn();
    const onPreserveLocal = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (conflict = false) =>
      root.render(
        <ThreadFileViewer
          conflict={conflict}
          file={editable}
          onDirtyChange={onDirtyChange}
          onPreserveLocal={onPreserveLocal}
          onReload={vi.fn()}
          onSave={onSave}
          saving={false}
        />,
      );
    await React.act(() => render());
    const editor = container.querySelector("textarea");
    if (editor === null) throw new Error("Editor did not mount.");
    await React.act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(editor, "# Local draft\n\nunsaved proof");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      container.querySelector(".thread-file-preview")?.textContent,
    ).toContain("unsaved proof");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    const button = (name: string) =>
      [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === name,
      );
    expect(button("Find")?.disabled).toBe(true);
    await React.act(() => button("Source")?.click());
    await React.act(() =>
      button("Find")?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await React.act(() =>
      button("Wrap")?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(editorActions.openFind).toHaveBeenCalledOnce();
    expect(editor.dataset.wrap).toBe("true");

    const save = button("Save");
    await React.act(() =>
      save?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onSave).toHaveBeenCalledWith(
      {
        path,
        content: "# Local draft\n\nunsaved proof",
        expectedVersion: version,
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onSettled: expect.any(Function),
      }),
    );

    await React.act(() => {
      onSave.mock.calls[0]?.[1].onSettled();
      render(true);
    });
    expect(container.textContent).toContain(
      "Choose which version to continue with",
    );
    expect(button("Preserve local")?.type).toBe("button");
    expect(button("Reload remote")?.type).toBe("button");
    expect(button("Preserve local")?.closest('[role="alert"]')).not.toBeNull();
    expect(button("Reload remote")?.closest('[role="alert"]')).not.toBeNull();
    expect(
      container.querySelector(".thread-file-preview")?.textContent,
    ).toContain("Local draft");
    await React.act(() =>
      button("Preserve local")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      ),
    );
    expect(onPreserveLocal).toHaveBeenCalledOnce();
    await React.act(() => root.unmount());
  });

  it("renders binary content structurally read-only", async () => {
    const root = createRoot(
      document.body.appendChild(document.createElement("div")),
    );
    await React.act(() =>
      root.render(
        <ThreadFileViewer
          conflict={false}
          file={{
            kind: "file",
            path: "asset.bin" as ThreadFilesPath,
            editable: false,
            readonlyReason: "binary",
            content: "",
            sizeBytes: 4,
            language: "text",
            mediaType: "text/plain",
          }}
          onDirtyChange={vi.fn()}
          onPreserveLocal={vi.fn()}
          onReload={vi.fn()}
          onSave={vi.fn()}
          saving={false}
        />,
      ),
    );
    expect(document.body.textContent).toContain(
      "Binary content cannot be displayed or edited",
    );
    expect(document.body.textContent).not.toContain("Save");
    await React.act(() => root.unmount());
  });
});
