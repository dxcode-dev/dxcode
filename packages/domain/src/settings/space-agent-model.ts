import { Schema } from "effect";
import {
  CLAUDE_CODE_MODELS,
  CLAUDE_CODE_PROVIDER_ID,
  isClaudeCodeModel,
} from "./claude-code.js";
import { ModelId, ThinkingLevel } from "./model-routing.js";

/**
 * The model a person's new Spaces run their main Thread on (Settings → Mode
 * Dial → Space). Absent means Auto: `SPACE_AGENT_DEFAULT`.
 */
export const SpaceAgentModel = Schema.Struct({
  model: ModelId,
  thinking: ThinkingLevel,
});

export type SpaceAgentModel = typeof SpaceAgentModel.Type;

/** Auto: Claude Opus 5.5 at medium effort. */
export const SPACE_AGENT_DEFAULT = {
  model: "anthropic/claude-opus-5-5",
  thinking: "medium",
} as const satisfies { readonly model: string; readonly thinking: string };

/**
 * The Claude Code model that serves `model` on a Claude Pro/Max plan, such as
 * `claude-code/claude-opus-5-5` for `anthropic/claude-opus-5-5`; undefined
 * when Claude Code does not serve it. A Space whose model Claude Code serves
 * runs on Claude Code when its creator has a plan connected.
 */
export const claudeCodeModelFor = (model: string): string | undefined => {
  if (isClaudeCodeModel(model)) return model;
  const id = model.slice(model.indexOf("/") + 1);
  return model.includes("/") && CLAUDE_CODE_MODELS.some((m) => m.id === id)
    ? `${CLAUDE_CODE_PROVIDER_ID}/${id}`
    : undefined;
};
