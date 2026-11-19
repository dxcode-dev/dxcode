import { CodeEditor } from "./code-editor.js";

/** A file in the shared diffs editor; loaded lazily by `FileView`. */
export function FileViewEditor({
  path,
  content,
  onChange,
}: {
  readonly path: string;
  readonly content: string;
  readonly onChange: (content: string) => void;
}) {
  return (
    <CodeEditor
      className="dx-file-view-editor"
      path={path}
      content={content}
      wrap={false}
      onChange={onChange}
    />
  );
}
