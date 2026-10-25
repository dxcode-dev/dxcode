import type { ThreadDetailData } from "@dx/api";
import { isClaudeCodeModel } from "@dx/domain";
import { modelDisplayName } from "../../shared/model-display-name.js";

type ThreadSelection = ThreadDetailData["agentInitialization"]["selection"];

/**
 * What a Thread runs on: its mode, Claude Code, or a pinned model. `label`
 * names it and `detail` adds the model or effort, as the phone Thread menu
 * shows them side by side.
 */
export function threadSelectionSummary(selection: ThreadSelection) {
  if (selection.kind === "mode")
    return {
      kind: "mode" as const,
      label: selection.mode,
      detail: "Mode",
      title: `Mode: ${selection.mode}`,
    };
  const effort = selection.thinking;
  if (isClaudeCodeModel(selection.model)) {
    const model = modelDisplayName(selection.model).replace(/^Claude /, "");
    return {
      kind: "claude-code" as const,
      label: "claude code",
      detail: effort === undefined ? model : `${model} · ${effort}`,
      title: `Claude Code: ${modelDisplayName(selection.model)}${effort === undefined ? "" : `, ${effort} effort`}`,
    };
  }
  return {
    kind: "model" as const,
    label: modelDisplayName(selection.model),
    detail: effort,
    title: `Model: ${selection.model}`,
  };
}
