import { CodeFile } from "./code-view.js";

const options = {
  overflow: "scroll",
  disableFileHeader: true,
  stickyHeader: false,
} as const;

/** A file's text in dx's code theme; loaded lazily by `FileView`. */
export function FileViewCode({
  path,
  content,
}: {
  readonly path: string;
  readonly content: string;
}) {
  return (
    <CodeFile
      file={{
        name: path,
        contents: content,
      }}
      className="dx-file-view-code"
      disableWorkerPool
      options={options}
    />
  );
}
