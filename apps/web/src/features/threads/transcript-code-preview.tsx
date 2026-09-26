import { File, FileDiff } from "@pierre/diffs/react";
import * as React from "react";
import { useTheme } from "../../shared/theme/theme-provider.js";
import {
  parseTranscriptPatch,
  stableTranscriptPreviewVersion,
  stripToolLineNumbers,
} from "./transcript-code-preview-model.js";

export function TranscriptCodePreview({
  path,
  contents,
  kind,
}: {
  readonly path: string;
  readonly contents: string;
  readonly kind: "file" | "patch";
}) {
  const { resolvedAppearance } = useTheme();
  const file = React.useMemo(
    () => ({
      name: path,
      contents: stripToolLineNumbers(contents),
      cacheKey: `transcript:${path}:${stableTranscriptPreviewVersion(contents)}`,
    }),
    [path, contents],
  );
  const fileDiffs = React.useMemo(
    () => (kind === "patch" ? parseTranscriptPatch(contents, path) : []),
    [contents, kind, path],
  );
  const theme = resolvedAppearance === "light" ? "pierre-light" : "pierre-dark";
  const codeOptions = {
    theme,
    themeType: resolvedAppearance,
    overflow: "wrap" as const,
    disableFileHeader: true,
    stickyHeader: false,
  };

  if (kind === "patch" && fileDiffs.length === 0) {
    return <pre className="transcript-edit-output">{contents}</pre>;
  }

  return (
    <div className="transcript-code-preview" data-preview-kind={kind}>
      {kind === "file" ? (
        <File
          file={file}
          className="transcript-pierre-file"
          disableWorkerPool
          options={codeOptions}
        />
      ) : (
        fileDiffs.map((fileDiff) => (
          <FileDiff
            key={fileDiff.name}
            fileDiff={fileDiff}
            className="transcript-pierre-file"
            disableWorkerPool
            options={{
              ...codeOptions,
              diffStyle: "unified",
              lineDiffType: "word-alt",
              hunkSeparators: "line-info-basic",
            }}
          />
        ))
      )}
    </div>
  );
}
