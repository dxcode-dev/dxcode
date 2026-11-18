import { parseDiffFromFile } from "@pierre/diffs";
import { textVersion } from "../text-version.js";
import { codeDiffOptions } from "./code-theme.js";
import { CodeDiff } from "./code-view.js";
import type { EditDiffSource } from "./edit-diff.js";

const parseEditDiff = (source: EditDiffSource) => {
  const version = textVersion(`${source.before}\u0000${source.after}`);
  try {
    return parseDiffFromFile(
      {
        name: source.path,
        contents: source.before,
        cacheKey: `transcript-edit:${source.path}:${version}:before`,
      },
      {
        name: source.path,
        contents: source.after,
        cacheKey: `transcript-edit:${source.path}:${version}:after`,
      },
    );
  } catch {
    return undefined;
  }
};

/** Render an edit as a diff of the replaced region. */
export function EditDiffContent({
  source,
}: {
  readonly source: EditDiffSource;
}) {
  const fileDiff = parseEditDiff(source);
  if (fileDiff === undefined)
    return <pre className="transcript-edit-output">{source.after}</pre>;
  return (
    <div className="transcript-code-preview" data-preview-kind="edit">
      <CodeDiff
        fileDiff={fileDiff}
        className="transcript-pierre-file"
        disableWorkerPool
        options={{
          ...codeDiffOptions,
          diffStyle: "unified",
          overflow: "wrap",
          disableFileHeader: true,
          stickyHeader: false,
        }}
      />
    </div>
  );
}
