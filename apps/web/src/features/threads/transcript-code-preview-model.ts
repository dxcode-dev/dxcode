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

export interface TranscriptEditSource {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

const textField = (input: unknown, name: string) => {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
};

/**
 * Recover the edited region from an edit or write tool call's input. Flue's
 * `edit` result carries no patch, so the diff is derived from the request.
 */
export const transcriptEditSource = (
  toolName: string,
  input: unknown,
): TranscriptEditSource | undefined => {
  const path = textField(input, "path");
  if (path === undefined || path.length === 0) return undefined;
  const name = toolName.toLowerCase();
  if (name === "edit") {
    const before = textField(input, "oldText");
    const after = textField(input, "newText");
    return before === undefined || after === undefined
      ? undefined
      : { path, before, after };
  }
  if (name === "write") {
    const after = textField(input, "content");
    return after === undefined ? undefined : { path, before: "", after };
  }
  return undefined;
};
