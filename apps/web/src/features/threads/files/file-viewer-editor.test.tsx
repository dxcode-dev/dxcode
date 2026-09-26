// @vitest-environment happy-dom

import type {
  ThreadFileData,
  ThreadFilesPath,
  ThreadFileVersion,
} from "@dx/api";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./file-editor.js", async () => {
  const ReactModule = await import("react");
  return {
    ThreadFileEditor: ReactModule.forwardRef(function MockFileEditor(
      {
        content,
        onChange,
      }: { content: string; onChange: (value: string) => void },
      _ref,
    ) {
      return (
        <textarea
          aria-label="Source editor"
          value={content}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );
    }),
  };
});

import { ThreadFileViewer } from "./file-viewer.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => document.body.replaceChildren());

const path = "proof.ts" as ThreadFilesPath;
const version = (character: string) =>
  `sha256:${character.repeat(64)}` as ThreadFileVersion;
const file = (content: string, contentVersion: ThreadFileVersion) =>
  ({
    kind: "file",
    path,
    editable: true,
    content,
    contentVersion,
    sizeBytes: content.length,
    language: "typescript",
    mediaType: "text/typescript",
  }) satisfies ThreadFileData;
const readOnlyFile = (
  readonlyReason: "binary" | "encoding" | "too-large" = "binary",
) =>
  ({
    kind: "file",
    path,
    editable: false,
    readonlyReason,
    content: "",
    sizeBytes: 4,
    language: "text",
    mediaType: "application/octet-stream",
  }) satisfies ThreadFileData;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const editorIn = (container: Element) => {
  const editor = container.querySelector("textarea");
  if (!(editor instanceof HTMLTextAreaElement)) {
    throw new Error("Editor did not mount.");
  }
  return editor;
};

const input = async (editor: HTMLTextAreaElement, content: string) => {
  await React.act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(editor, content);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const click = async (container: Element, name: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  );
  if (button === undefined) throw new Error(`${name} button did not mount.`);
  await React.act(() =>
    button.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
};

const mountViewer = async ({
  initial = file("A", version("a")),
  onDirtyChange = vi.fn(),
  onPreserveLocal = vi.fn(async () => initial),
  onReload = vi.fn(),
  onSave = vi.fn(async () => ({ contentVersion: version("b") })),
}: {
  initial?: ThreadFileData;
  onDirtyChange?: (dirty: boolean) => void;
  onPreserveLocal?: () => Promise<ThreadFileData>;
  onReload?: () => void;
  onSave?: (input: {
    path: ThreadFilesPath;
    content: string;
    expectedVersion: ThreadFileVersion;
  }) => Promise<{ contentVersion: ThreadFileVersion }>;
} = {}) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const render = async (currentFile = initial, generation = 0) => {
    await React.act(() =>
      root.render(
        <ThreadFileViewer
          conflict={false}
          file={currentFile}
          key={`${currentFile.path}:${generation}`}
          onDirtyChange={onDirtyChange}
          onPreserveLocal={(accept) => {
            void onPreserveLocal().then(accept, () => {});
          }}
          onReload={onReload}
          onSave={(input, callbacks) => {
            void onSave(input)
              .then(callbacks.onSuccess, () => {})
              .finally(callbacks.onSettled);
          }}
          saving={false}
        />,
      ),
    );
  };
  await render();
  return { container, onDirtyChange, render, root };
};

describe("Thread file viewer save lifecycle", () => {
  it("keeps C dirty when save B resolves after C is typed", async () => {
    const saveB = deferred<{ contentVersion: ThreadFileVersion }>();
    const onSave = vi
      .fn()
      .mockImplementationOnce(() => saveB.promise)
      .mockResolvedValue({ contentVersion: version("c") });
    const mounted = await mountViewer({ onSave });
    const editor = editorIn(mounted.container);

    await input(editor, "B");
    await click(mounted.container, "Save");
    await input(editor, "C");
    await React.act(async () =>
      saveB.resolve({ contentVersion: version("b") }),
    );

    expect(editor.value).toBe("C");
    expect(mounted.container.textContent).toContain("Unsaved changes");
    expect(mounted.onDirtyChange).toHaveBeenLastCalledWith(true);
    await click(mounted.container, "Save");
    expect(onSave).toHaveBeenLastCalledWith({
      path,
      content: "C",
      expectedVersion: version("b"),
    });
  });

  it("keeps an input back to A dirty against acknowledged B", async () => {
    const saveB = deferred<{ contentVersion: ThreadFileVersion }>();
    const onSave = vi
      .fn()
      .mockImplementationOnce(() => saveB.promise)
      .mockResolvedValue({ contentVersion: version("c") });
    const mounted = await mountViewer({ onSave });
    const editor = editorIn(mounted.container);

    await input(editor, "B");
    await click(mounted.container, "Save");
    await input(editor, "A");
    await React.act(async () =>
      saveB.resolve({ contentVersion: version("b") }),
    );

    expect(editor.value).toBe("A");
    expect(mounted.onDirtyChange).toHaveBeenLastCalledWith(true);
    await click(mounted.container, "Save");
    expect(onSave).toHaveBeenLastCalledWith({
      path,
      content: "A",
      expectedVersion: version("b"),
    });
  });

  it("does not accept a background version until Preserve local", async () => {
    const remote = file("remote", version("b"));
    const onSave = vi.fn().mockRejectedValue(new Error("conflict"));
    const onPreserveLocal = vi.fn(async () => remote);
    const mounted = await mountViewer({ onPreserveLocal, onSave });
    const editor = editorIn(mounted.container);
    await input(editor, "draft");

    await mounted.render(remote);
    expect(editorIn(mounted.container)).toBe(editor);
    expect(editor.value).toBe("draft");
    expect(mounted.container.textContent).toContain("changed remotely");
    await click(mounted.container, "Save");
    expect(onSave).toHaveBeenLastCalledWith({
      path,
      content: "draft",
      expectedVersion: version("a"),
    });

    await click(mounted.container, "Preserve local");
    expect(editorIn(mounted.container)).toBe(editor);
    expect(editor.value).toBe("draft");
    await click(mounted.container, "Save");
    expect(onSave).toHaveBeenLastCalledWith({
      path,
      content: "draft",
      expectedVersion: version("b"),
    });
  });

  it("preserves the buffer and original expected version after a rejected save", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("network failure"));
    const mounted = await mountViewer({ onSave });
    const editor = editorIn(mounted.container);
    await input(editor, "draft");

    await click(mounted.container, "Save");
    expect(editor.value).toBe("draft");
    expect(mounted.container.textContent).toContain("Unsaved changes");
    await click(mounted.container, "Save");
    expect(onSave).toHaveBeenNthCalledWith(2, {
      path,
      content: "draft",
      expectedVersion: version("a"),
    });
  });

  it("resets the buffer only when Reload remote remounts the viewer", async () => {
    const remote = file("remote", version("b"));
    let generation = 0;
    let render!: (
      currentFile: ThreadFileData,
      generation: number,
    ) => Promise<void>;
    const onReload = vi.fn(() => {
      generation += 1;
      void render(remote, generation);
    });
    const mounted = await mountViewer({ onReload });
    render = mounted.render;
    const editor = editorIn(mounted.container);
    await input(editor, "draft");
    await mounted.render(remote, generation);

    await click(mounted.container, "Reload remote");
    await React.act(async () => undefined);
    expect(editorIn(mounted.container)).not.toBe(editor);
    expect(editorIn(mounted.container).value).toBe("remote");
  });

  it("retains the draft when Preserve local reads a read-only response", async () => {
    const readOnly = readOnlyFile();
    const onPreserveLocal = vi.fn(async () => readOnly);
    const onSave = vi.fn().mockResolvedValue({ contentVersion: version("c") });
    const mounted = await mountViewer({ onPreserveLocal, onSave });
    const editor = editorIn(mounted.container);
    await input(editor, "draft");
    await mounted.render(file("remote", version("b")));

    await click(mounted.container, "Preserve local");
    expect(editorIn(mounted.container)).toBe(editor);
    expect(editor.value).toBe("draft");
    await click(mounted.container, "Save");
    expect(onSave).not.toHaveBeenCalled();
    expect(mounted.container.textContent).toContain("Your draft is retained");
  });

  it("adopts current query data when a read-only file becomes editable", async () => {
    const editable = file("remote text", version("b"));
    const mounted = await mountViewer({ initial: readOnlyFile("encoding") });

    expect(mounted.container.textContent).toContain("not valid UTF-8");
    expect(mounted.container.querySelector("textarea")).toBeNull();
    await mounted.render(editable);

    expect(editorIn(mounted.container).value).toBe("remote text");
    expect(mounted.container.textContent).not.toContain("Read-only file");
    expect(mounted.container.textContent).toContain("Saved");
    expect(mounted.onDirtyChange).not.toHaveBeenCalled();
  });

  it("replaces a clean editor when current query data advances", async () => {
    const mounted = await mountViewer();
    const initialEditor = editorIn(mounted.container);

    await mounted.render(file("remote", version("b")));

    expect(editorIn(mounted.container)).not.toBe(initialEditor);
    expect(editorIn(mounted.container).value).toBe("remote");
    expect(mounted.container.textContent).toContain("Saved");
    expect(mounted.onDirtyChange).not.toHaveBeenCalled();
  });

  it("retains an existing draft when current query data becomes read-only", async () => {
    const mounted = await mountViewer();
    const editor = editorIn(mounted.container);
    await input(editor, "local draft");

    await mounted.render(readOnlyFile());

    expect(editorIn(mounted.container)).toBe(editor);
    expect(editor.value).toBe("local draft");
    expect(mounted.container.textContent).toContain("Your draft is retained");
    expect(
      [...mounted.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Save",
      )?.disabled,
    ).toBe(true);
  });

  it("ignores a Preserve local response that arrives after a newer save", async () => {
    const refresh = deferred<ThreadFileData>();
    const onSave = vi.fn().mockResolvedValue({ contentVersion: version("c") });
    const mounted = await mountViewer({
      onSave,
      onPreserveLocal: () => refresh.promise,
    });
    const editor = editorIn(mounted.container);
    await input(editor, "draft");
    await mounted.render(file("remote", version("b")));
    await click(mounted.container, "Preserve local");
    await click(mounted.container, "Save");
    await React.act(async () => refresh.resolve(file("stale", version("b"))));
    await input(editor, "new draft");
    await click(mounted.container, "Save");
    expect(onSave).toHaveBeenLastCalledWith({
      path,
      content: "new draft",
      expectedVersion: version("c"),
    });
  });

  it("preserves a dirty editor while navigation hides and restores its pane", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    const render = (active: boolean) =>
      root.render(
        <>
          <section hidden={active}>Agent</section>
          <section hidden={!active}>
            <ThreadFileViewer
              conflict={false}
              file={file("A", version("a"))}
              onDirtyChange={vi.fn()}
              onPreserveLocal={vi.fn()}
              onReload={vi.fn()}
              onSave={vi.fn()}
              saving={false}
            />
          </section>
        </>,
      );

    await React.act(() => render(true));
    const editor = editorIn(container);
    await input(editor, "dirty navigation draft");
    await React.act(() => render(false));
    expect(editor.isConnected).toBe(true);
    await React.act(() => render(true));
    expect(editorIn(container)).toBe(editor);
    expect(editor.value).toBe("dirty navigation draft");
    expect(container.textContent).toContain("Unsaved changes");
    await React.act(() => root.unmount());
  });
});
