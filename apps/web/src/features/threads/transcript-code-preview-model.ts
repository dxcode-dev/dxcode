import { parsePatchFiles } from "@pierre/diffs";

const numberedLine = /^\s*\d+[:|]\s?/;

export const stripToolLineNumbers = (contents: string) => {
  const lines = contents.split("\n");
  const populated = lines.filter((line) => line.trim().length > 0);
  if (
    populated.length === 0 ||
    !populated.every((line) => numberedLine.test(line))
  ) {
    return contents;
  }
  return lines.map((line) => line.replace(numberedLine, "")).join("\n");
};

export const stableTranscriptPreviewVersion = (value: string) => {
  let hash = 0;
  for (const character of value)
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return hash >>> 0;
};

export const parseTranscriptPatch = (patch: string, path: string) => {
  const normalized =
    patch.includes("--- ") || patch.includes("diff --git")
      ? patch
      : `--- a/${path}\n+++ b/${path}\n${patch}`;
  try {
    return parsePatchFiles(
      normalized,
      `transcript-${encodeURIComponent(path)}-${stableTranscriptPreviewVersion(patch)}`,
      true,
    ).flatMap((parsed) => parsed.files);
  } catch {
    return [];
  }
};

export const isPatchOutput = (output: string) =>
  /^(?:diff --git|--- |\+\+\+ |@@ )/m.test(output);
