import * as React from "react";
import {
  CodeEditor,
  type CodeEditorHandle,
} from "../../../shared/ui/code-editor.js";
import type { FileLineRange } from "../transcript-file-link.js";
import { RevealLine } from "./reveal-line.js";

export type FileEditorHandle = CodeEditorHandle;

/** The Files pane's editor: the shared CodeEditor, revealing agent edits. */
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
  const host = React.useRef<HTMLDivElement | null>(null);
  return (
    <CodeEditor
      ref={forwardedRef}
      className="thread-file-editor"
      path={path}
      content={content}
      wrap={wrap}
      onChange={onChange}
      {...(onReadyChange === undefined ? {} : { onReadyChange })}
      {...(revealLines === undefined
        ? {}
        : {
            selectedLines: { start: revealLines.start, end: revealLines.end },
          })}
      onHost={(node) => {
        host.current = node;
      }}
    >
      {revealLines === undefined ? null : (
        <RevealLine
          host={host}
          key={`${revealSequence}:${revealLines.start}`}
          line={revealLines.start}
        />
      )}
    </CodeEditor>
  );
});
