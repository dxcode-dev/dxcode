import { Editor } from "@pierre/diffs/edit";
import { type EditorFactory, EditProvider, File } from "@pierre/diffs/react";
import * as React from "react";
import { useTheme } from "../../../shared/theme/theme-provider.js";
import type { FileLineRange } from "../transcript-file-link.js";
import { RevealLine } from "./reveal-line.js";

const createEditor: EditorFactory<undefined, undefined> = (
  type,
  options,
  key,
) => new Editor(type, options, key);

export interface FileEditorHandle {
  readonly openFind: () => void;
}

export const ThreadFileEditor = React.forwardRef<
  FileEditorHandle,
  {
    readonly path: string;
    readonly content: string;
    readonly wrap: boolean;
    readonly onChange: (content: string) => void;
    readonly onReadyChange?: (ready: boolean) => void;
    /** Lines to highlight, such as the chunk an agent edit wrote. */
    readonly revealLines?: FileLineRange;
    /** Changes whenever the same file is opened again to scroll once more. */
    readonly revealSequence?: number;
  }
>(function ThreadFileEditor(
  {
    path,
    content,
    wrap,
    onChange,
    onReadyChange,
    revealLines,
    revealSequence = 0,
  },
  forwardedRef,
) {
  const { resolvedAppearance } = useTheme();
  const host = React.useRef<HTMLDivElement>(null);
  // Pierre owns the live document and history. Never feed keystrokes back as
  // external file updates. An explicit Reload remounts this editor.
  const [file] = React.useState(() => ({ name: path, contents: content }));
  React.useImperativeHandle(
    forwardedRef,
    () => ({
      openFind: () => {
        // Diffs 1.4.1 has no public openFind handle. Its own Find demo uses the
        // keyboard command on the shadow-root editor. Keep that adapter here.
        const input = host.current
          ?.querySelector("diffs-container")
          ?.shadowRoot?.querySelector<HTMLElement>('[contenteditable="true"]');
        input?.focus();
        input?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "f",
            code: "KeyF",
            ctrlKey: !/Mac/.test(navigator.platform),
            metaKey: /Mac/.test(navigator.platform),
            bubbles: true,
            composed: true,
          }),
        );
      },
    }),
    [],
  );

  return (
    <div className="thread-file-editor" ref={host}>
      <EditProvider createEditor={createEditor}>
        <File
          file={file}
          edit
          selectedLines={
            revealLines === undefined
              ? null
              : { start: revealLines.start, end: revealLines.end }
          }
          options={{
            disableFileHeader: true,
            theme:
              resolvedAppearance === "light" ? "pierre-light" : "pierre-dark",
            themeType: resolvedAppearance,
            overflow: wrap ? "wrap" : "scroll",
            onPostRender: (node) =>
              onReadyChange?.(
                node.shadowRoot?.querySelector('[contenteditable="true"]') !=
                  null,
              ),
          }}
          onEditChange={(event) => onChange(event.file.contents)}
        />
      </EditProvider>
      {revealLines === undefined ? null : (
        <RevealLine
          host={host}
          key={`${revealSequence}:${revealLines.start}`}
          line={revealLines.start}
        />
      )}
    </div>
  );
});
