import { parsePatchFiles } from "@pierre/diffs";
import { stableTranscriptPreviewVersion } from "./transcript-code-preview-model.js";

// Apart from the model so the transcript does not load the diff library.
export const parseTranscriptPatch = (patch: string, path: string) => {
  patch = /```diff\r?\n([\s\S]*?)```/.exec(patch)?.[1] ?? patch;
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
