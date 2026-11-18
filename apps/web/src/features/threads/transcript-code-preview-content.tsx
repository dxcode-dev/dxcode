import { textVersion } from "../../shared/text-version.js";
import { codeDiffOptions } from "../../shared/ui/code-theme.js";
import { CodeDiff, CodeFile } from "../../shared/ui/code-view.js";
import { stripToolLineNumbers } from "./transcript-code-preview-model.js";
import { parseTranscriptPatch } from "./transcript-code-preview-patch.js";

const codeOptions = {
  overflow: "wrap",
  disableFileHeader: true,
  stickyHeader: false,
} as const;

export function TranscriptCodePreview({
  path,
  contents,
  kind,
}: {
  readonly path: string;
  readonly contents: string;
  readonly kind: "file" | "patch";
}) {
  return <CodePreview path={path} contents={contents} kind={kind} />;
}

function CodePreview({
  path,
  contents,
  kind,
}: {
  readonly path: string;
  readonly contents: string;
  readonly kind: "file" | "patch";
}) {
  const file = {
    name: path,
    contents: stripToolLineNumbers(contents),
    cacheKey: `transcript:${path}:${textVersion(contents)}`,
  };
  const fileDiffs =
    kind === "patch" ? parseTranscriptPatch(contents, path) : [];
  if (kind === "patch" && fileDiffs.length === 0) {
    return <pre className="transcript-edit-output">{contents}</pre>;
  }

  return (
    <div className="transcript-code-preview" data-preview-kind={kind}>
      {kind === "file" ? (
        <CodeFile
          file={file}
          className="transcript-pierre-file"
          disableWorkerPool
          options={codeOptions}
        />
      ) : (
        fileDiffs.map((fileDiff) => (
          <CodeDiff
            key={fileDiff.name}
            fileDiff={fileDiff}
            className="transcript-pierre-file"
            disableWorkerPool
            options={{
              ...codeOptions,
              ...codeDiffOptions,
              diffStyle: "unified",
            }}
          />
        ))
      )}
    </div>
  );
}
